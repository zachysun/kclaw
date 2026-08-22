/**
 * web tools (spec §7): Tavily-backed search + plain page fetch.
 *
 * Both are safe + parallel: neither mutates workspace state, so the loop may
 * run them concurrently with anything else.
 *
 * - `web_search {query, maxResults?}` POSTs `{api_key, query, max_results}`
 *   to Tavily. `output` is a markdown list for the model
 *   (`- [title](url)：content`); `data` carries the raw triples
 *   `{results: [{title, url, content}]}` for the renderer.
 * - `web_fetch {url}` GETs a page (redirects followed). Non-2xx → error with
 *   the status code. HTML goes through linkedom's parseHTML + Readability for
 *   article text (scripts/styles never survive); if extraction comes up empty
 *   it falls back to body text with script/style nodes removed. Non-HTML
 *   content-types are returned as plain text. Bodies larger than
 *   `maxFetchBytes` (default 512KB) are byte-capped with a truncation marker;
 *   the cap is applied to the raw body BEFORE parsing so an oversized page
 *   can't blow up memory in the DOM stage.
 *
 * `fetchImpl` is injectable; tests pass a stub so no network is touched.
 */
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import type { ToolExecutor } from "../agent/tools.js"
import { errMsg, makeTool, optInt, requireString, ToolError } from "./shared.js"

const TAVILY_URL = "https://api.tavily.com/search"
const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_FETCH_BYTES = 512 * 1024

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
}): { "web_search": ToolExecutor; "web_fetch": ToolExecutor } {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const maxFetchBytes = opts.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES

  const web_search = makeTool("web_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const maxResults = optInt(args, "maxResults", DEFAULT_MAX_RESULTS, 1, 10)

    let res: Response
    try {
      res = await doFetch(TAVILY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: opts.tavilyApiKey, query, max_results: maxResults }),
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
      // redirect: "follow" is the default; stated explicitly for clarity.
      res = await doFetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html, text/plain, */*" },
      })
    } catch (e) {
      throw new ToolError(`fetch failed: ${errMsg(e)}`)
    }
    if (!res.ok) {
      throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`.replace(/\s+$/, ""))
    }

    let raw: string
    try {
      raw = await res.text()
    } catch (e) {
      throw new ToolError(`reading body failed: ${errMsg(e)}`)
    }

    const { text, dropped } = capBytes(raw, maxFetchBytes)
    const contentType = res.headers?.get("content-type") ?? ""
    const body = /html/i.test(contentType) ? extractReadableText(text) : text
    const marker = dropped > 0 ? `\n...[truncated, dropped ${dropped} bytes]...` : ""
    return { status: "ok", output: body + marker }
  })

  return { "web_search": web_search, "web_fetch": web_fetch }
}
