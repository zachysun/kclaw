/**
 * web tools: Tavily-backed search + plain page fetch.
 *
 * Both are safe + parallel: neither mutates workspace state, so the loop may
 * run them concurrently with anything else.
 *
 * - `web_search {query, maxResults?}` POSTs `{api_key, query, max_results}`
 *   to Tavily. `output` is a markdown list for the model
 *   (`- [title](url)：content`); `data` carries the raw triples
 *   `{results: [{title, url, content}]}` for the renderer.
 * - `web_fetch {url}` GETs a page. Redirects are followed manually (at most
 *   5 hops) so EVERY hop's target — the initial URL and each Location — is
 *   checked against the private-network deny list before the request is
 *   made: loopback/unspecified/link-local/private addresses (127/8, 0.0.0.0,
 *   ::1, ::ffff: mappings, 10/8, 172.16/12, 192.168/16, 169.254/16,
 *   fc00::/7, fe80::/10) are
 *   refused unless `allowPrivateNetworks` opts in (SSRF guard). Non-2xx →
 *   error with the status code. HTML goes through linkedom's parseHTML +
 *   Readability for article text (scripts/styles never survive); if
 *   extraction comes up empty it falls back to body text with script/style
 *   nodes removed. Non-HTML content-types are returned as plain text. Bodies
 *   are read through a stream that is cancelled once `maxFetchBytes`
 *   (default 512KB) is passed (or the 10MB spill ceiling when a spill dir is
 *   wired), ending in a truncation marker — or an fs_read locator when the
 *   captured span was spilled to disk; the cap is
 *   applied to the raw body BEFORE parsing so an oversized page can't blow
 *   up memory in the DOM stage.
 *
 * `web_search` targets the fixed public Tavily domain and skips this check.
 *
 * `fetchImpl` and `lookupImpl` are injectable; tests pass stubs so no
 * network is touched (the default lookupImpl resolves via node:dns).
 *
 * Every fetch carries an AbortSignal.timeout (default 20s, `timeoutMs`) so a
 * hung host can never park a run forever.
 */
import { lookup as dnsLookup } from "node:dns/promises"
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import type { ToolExecutor } from "../agent/tools.js"
import { errMsg, makeTool, optInt, requireString, ToolError } from "./shared.js"
import { spillLocatorLine, spillToolOutput, SPILL_MAX_BYTES } from "./spill.js"

const TAVILY_URL = "https://api.tavily.com/search"
const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_FETCH_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_REDIRECTS = 5

/** True for loopback/unspecified/link-local/private v4/v6 addresses (SSRF boundary). */
function isBlockedIp(addr: string): boolean {
  let a = addr
  if (a.startsWith("::ffff:")) {
    // WHATWG serializes `::ffff:127.0.0.1` as pure hex `::ffff:7f00:1`; unmap
    // both spellings to dotted v4 so the rules below see the real address.
    const mapped = a.slice(7)
    if (mapped.includes(".")) {
      a = mapped
    } else {
      const segs = mapped.split(":")
      if (segs.length === 2) {
        const hi = parseInt(segs[0], 16)
        const lo = parseInt(segs[1], 16)
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
      }
    } // malformed mapped form: keep as-is and fall through to the v6 checks
  }
  if (a === "::1" || a === "0.0.0.0" || a.startsWith("127.")) return true
  if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true // fc00::/7 ULA, fe80::/10 link-local
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true
  const m = /^172\.(\d+)\./.exec(a)
  return m !== null && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

const isLiteralIp = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")

/** Tidy HTML-derived text: squash trailing spaces and 3+ blank lines. */
function normalizeText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Byte-cap a string at `maxBytes`, reporting how much was dropped. */
function capBytes(s: string, maxBytes: number): { text: string; dropped: number } {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return { text: s, dropped: 0 }
  // A multibyte char torn at the boundary decodes to U+FFFD, acceptable here.
  return { text: buf.subarray(0, maxBytes).toString("utf8"), dropped: buf.length - maxBytes }
}

/**
 * Read a response body as text, stopping at `maxBytes` (or at `spillCap` when
 * given — the extra span is captured for the on-disk spill copy). Once the
 * ceiling is passed the reader is cancelled, so an infinite/huge stream can
 * neither grow memory without bound nor keep the connection busy. `dropped`
 * is the byte count beyond the view cap (estimated from what was consumed).
 * `spill` carries everything read up to the ceiling; `spillPartial` marks a
 * copy that stopped before the stream ended.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  spillCap?: number,
): Promise<{ text: string; dropped: number; spill?: string; spillPartial?: boolean }> {
  if (res.body === null) {
    const full = await res.text()
    const { text, dropped } = capBytes(full, maxBytes)
    if (dropped === 0 || spillCap === undefined) return { text, dropped }
    const buf = Buffer.from(full, "utf8")
    if (buf.length <= spillCap) return { text, dropped, spill: full }
    return { text, dropped, spill: buf.subarray(0, spillCap).toString("utf8"), spillPartial: true }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  const ceiling = spillCap ?? maxBytes
  let received = 0
  let capped = false
  let spillPartial = false
  while (true) {
    const { done, value } = await reader.read()
    if (done === true) break
    chunks.push(value)
    received += value.byteLength
    if (received > ceiling) {
      capped = true
      spillPartial = spillCap !== undefined
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  const decoded = buf.toString("utf8")
  const { text, dropped } = capBytes(decoded, maxBytes)
  if (dropped === 0) return { text, dropped }
  if (spillCap === undefined) return { text, dropped }
  return { text, dropped, spill: decoded, ...(spillPartial ? { spillPartial: true } : {}) }
}

/**
 * Extract readable article text from an HTML string.
 * Readability first; on failure/empty result fall back to body text with
 * script/style/etc. nodes removed. The fallback re-parses the source so any
 * DOM mutation Readability made cannot leak into the fallback result.
 */
function extractReadableText(html: string): string {
  let article: ReturnType<Readability["parse"]> = null
  try {
    const { document } = parseHTML(html)
    // linkedom's structural Document type diverges from lib.dom's; at runtime
    // Readability only needs the standard API linkedom implements.
    article = new Readability(document as unknown as Document).parse()
  } catch {
    article = null
  }
  const articleText = article?.textContent
  if (typeof articleText === "string" && articleText.trim() !== "") {
    return normalizeText(articleText)
  }

  try {
    const { document } = parseHTML(html)
    for (const el of document.querySelectorAll("script, style, noscript, template, svg")) {
      el.remove()
    }
    const bodyText = document.body?.textContent ?? ""
    if (bodyText.trim() !== "") return normalizeText(bodyText)
  } catch {
    // fall through to the empty case below
  }
  return "(no extractable text content)"
}

export function createWebTools(opts: {
  tavilyApiKey: string
  fetchImpl?: typeof fetch
  maxFetchBytes?: number
  timeoutMs?: number
  /** Opt out of the private/loopback target denial (e.g. a local Ollama endpoint). */
  allowPrivateNetworks?: boolean
  /** Full-output spill dir (<home>/spill); undefined = truncation drops data as before. */
  spillDir?: string
  /** Hostname resolver used by the private-network check; tests inject a stub. */
  lookupImpl?: (host: string) => Promise<string[]>
}): { "web_search": ToolExecutor; "web_fetch": ToolExecutor } {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const maxFetchBytes = opts.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const allowPrivateNetworks = opts.allowPrivateNetworks ?? false
  const signal = () => AbortSignal.timeout(timeoutMs)

  const lookup = opts.lookupImpl ?? (async (host: string) => {
    const r = await dnsLookup(host, { all: true })
    return r.map((x) => x.address)
  })
  const assertPublicUrl = async (url: string): Promise<void> => {
    if (allowPrivateNetworks) return
    const { hostname } = new URL(url)
    const addrs = isLiteralIp(hostname) ? [hostname.replace(/^\[|\]$/g, "")] : await lookup(hostname)
    if (addrs.some(isBlockedIp)) {
      throw new ToolError(`refused: ${hostname} resolves to a private/loopback address (set web.allowPrivateNetworks to allow private network access)`)
    }
  }

  const web_search = makeTool("web_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const maxResults = optInt(args, "maxResults", DEFAULT_MAX_RESULTS, 1, 10)

    let res: Response
    try {
      res = await doFetch(TAVILY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: opts.tavilyApiKey, query, max_results: maxResults }),
        signal: signal(),
      })
    } catch (e) {
      throw new ToolError(`search request failed: ${errMsg(e)}`)
    }
    if (!res.ok) {
      throw new ToolError(`tavily returned HTTP ${res.status} ${res.statusText}`.trimEnd())
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (e) {
      throw new ToolError(`tavily response was not JSON: ${errMsg(e)}`)
    }
    const raw = (payload as { results?: unknown } | null)?.results
    if (!Array.isArray(raw)) {
      throw new ToolError("tavily response missing results array")
    }

    const results = raw.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      const pick = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "")
      return { title: pick("title"), url: pick("url"), content: pick("content") }
    })

    const output = results.length > 0
      ? results.map((r) => `- [${r.title}](${r.url})：${r.content}`).join("\n")
      : "(no results)"
    return { status: "ok", output, data: { results } }
  })

  const web_fetch = makeTool("web_fetch", "safe", "parallel", async (args) => {
    const url = requireString(args, "url")
    if (!/^https?:\/\//i.test(url)) {
      throw new ToolError(`args.url must be an http(s) URL: ${url}`)
    }

    let res: Response
    try {
      // Manual redirect loop: every hop (initial URL + each Location) passes
      // assertPublicUrl before the request, so a redirect cannot dodge the
      // private-network deny. Bounded at DEFAULT_MAX_REDIRECTS hops.
      let current = url
      for (let hop = 0; ; hop++) {
        await assertPublicUrl(current)
        res = await doFetch(current, { method: "GET", redirect: "manual", headers: { accept: "text/html, text/plain, */*" }, signal: signal() })
        const status = res.status
        if (status < 300 || status >= 400) break
        const location = res.headers.get("location")
        if (location === null || hop >= DEFAULT_MAX_REDIRECTS) {
          throw new ToolError(`too many redirects or missing location for ${url}`)
        }
        current = new URL(location, current).href
      }
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError(`fetch failed: ${errMsg(e)}`)
    }
    if (!res.ok) {
      throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`.replace(/\s+$/, ""))
    }

    let raw: { text: string; dropped: number; spill?: string; spillPartial?: boolean }
    try {
      raw = await readBodyCapped(res, maxFetchBytes, opts.spillDir === undefined ? undefined : SPILL_MAX_BYTES)
    } catch (e) {
      throw new ToolError(`reading body failed: ${errMsg(e)}`)
    }
    const { text: body_, dropped } = raw
    const contentType = res.headers?.get("content-type") ?? ""
    const body = /html/i.test(contentType) ? extractReadableText(body_) : body_
    let tail = ""
    if (dropped > 0) {
      // The spill copy is the RAW captured body (pre-extraction). Same shape
      // as exec: the drop marker always carries the byte count, and a
      // successful spill appends the fs_read locator after it.
      tail = `\n...[truncated, dropped ${dropped} bytes]...`
      tail += spillLocatorLine(spillToolOutput(opts.spillDir, "web_fetch", raw.spill ?? ""))
    }
    return { status: "ok", output: body + tail }
  })

  return { "web_search": web_search, "web_fetch": web_fetch }
}
