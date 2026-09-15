/**
 * First-run provider wizard: when detectProviderStatus reports
 * "missing" and stdout is a TTY, `kclaw chat` hands over to runWizard — a
 * 30-second select→key→model flow that probes the endpoint with a 1-token
 * completion and, only on success, writes config.yaml. Every cancel or
 * "重试？→否" bails out WITHOUT touching the filesystem (no partial
 * config.yaml is ever written).
 *
 * Paths come from core's resolvePaths (the real KclawPaths shape, home et
 * al.) — never a hand-rolled stand-in — so resolution cannot drift from the
 * daemon's; its mkdir side effect merely pre-creates the home tree any
 * kclaw invocation creates anyway. saveConfig itself does NOT set a file
 * mode (plain writeFileSync → 0o666 & umask), so the wizard chmods
 * config.yaml to 0o600 right after saving — API keys live in that file.
 *
 * The custom template has no baseUrl of its own, so the flow inserts a
 * baseUrl input step for it before the key step.
 */
import * as p from "@clack/prompts"
import { saveConfig, loadConfig, resolvePaths } from "@kclaw/core"
import { chmodSync } from "node:fs"

export interface Template {
  id: "deepseek" | "openai" | "ollama" | "custom"
  label: string
  baseUrl?: string
  defaultModel?: string
  skipKey?: boolean
}

export const PROVIDER_TEMPLATES: Template[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", skipKey: true },
  { id: "custom", label: "Custom OpenAI-compatible endpoint" },
]

export function buildProviderEntry(t: Template, apiKey: string, model: string) {
  return { baseUrl: t.baseUrl ?? "", apiKey: t.skipKey ? "ollama" : apiKey, model }
}

export function classifyProbeError(status: number | null, message: string): "key" | "network" | "model" | "unknown" {
  if (status === null) return "network"
  if (status === 401 || status === 403) return "key"
  if (status === 404) return "model"
  if (status === 400 && /model/i.test(message)) return "model"
  return "unknown"
}

/** Minimal completion to verify key + model. Returns HTTP status (null = request never landed) and body text. */
async function probe(baseUrl: string, apiKey: string, model: string): Promise<{ status: number | null; body: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(20_000),
    })
    return { status: res.status, body: (await res.text()).slice(0, 200) }
  } catch {
    return { status: null, body: "" }
  }
}

const REASON: Record<"key" | "network" | "model" | "unknown", string> = {
  key: "API key 无效（401/403）",
  network: "连不上服务端（网络或 baseUrl 不通）",
  model: "模型名不对（404/400）",
  unknown: "未知错误",
}

/** Probe 失败后回到失败的那一步：key 错→key 输入；model 错→model 输入；network/unknown→模板选择。 */
function retryStepFor(reason: "key" | "network" | "model" | "unknown"): "template" | "key" | "model" {
  if (reason === "key") return "key"
  if (reason === "model") return "model"
  return "template"
}

export async function runWizard(home: string): Promise<"configured" | "aborted"> {
  p.intro("还没配模型——带你 30 秒配好")
  // step 语义：下一步要采集的项；probe 失败按 retryStepFor 回退（custom 的 baseUrl 并入模板步）
  let step: "template" | "baseurl" | "key" | "model" = "template"
  let tpl: Template = PROVIDER_TEMPLATES[0]!
  let apiKey = "", model = ""
  while (true) {
    if (step === "template") {
      const pick = await p.select({ message: "选一个 provider", options: PROVIDER_TEMPLATES.map((t) => ({ value: t.id, label: t.label })) })
      if (p.isCancel(pick)) { p.cancel("已退出，未做任何修改"); return "aborted" }
      tpl = PROVIDER_TEMPLATES.find((t) => t.id === pick)!
      step = !tpl.baseUrl ? "baseurl" : tpl.skipKey ? "model" : "key"
      continue
    }
    if (step === "baseurl") {
      const b = await p.text({ message: `Base URL（${tpl.label}，OpenAI 兼容，含 /v1）`, placeholder: "https://api.example.com/v1" })
      if (p.isCancel(b)) { p.cancel("已退出，未做任何修改"); return "aborted" }
      const base = b.toString().trim().replace(/\/+$/, "")
      if (!base) { p.log.error("Base URL 不能为空"); continue }
      tpl = { ...tpl, baseUrl: base }
      step = tpl.skipKey ? "model" : "key"
      continue
    }
    if (step === "key") {
      const key = await p.password({ message: `API key（${tpl.label}）` })
      if (p.isCancel(key)) { p.cancel("已退出，未做任何修改"); return "aborted" }
      apiKey = key
      step = "model"
      continue
    }
    // step === "model"
    const m = await p.text({ message: "模型名", placeholder: tpl.defaultModel ?? "必填，如 llama3" })
    if (p.isCancel(m)) { p.cancel("已退出，未做任何修改"); return "aborted" }
    model = m.toString().trim() || tpl.defaultModel || ""
    if (!model) { p.log.error("模型名不能为空"); continue }
    const entry = buildProviderEntry(tpl, apiKey, model)
    const s = p.spinner(); s.start("测试连通…")
    const { status, body } = await probe(entry.baseUrl, entry.apiKey, entry.model)
    s.stop(status !== null && status < 400 ? "连通成功" : "连通失败")
    if (status !== null && status < 400) {
      const paths = resolvePaths(home)
      const cfg = loadConfig(paths)
      saveConfig(paths, {
        ...cfg,
        providers: { ...cfg.providers, default: tpl.id, entries: { ...cfg.providers.entries, [tpl.id]: entry } },
      })
      chmodSync(paths.configJson, 0o600) // saveConfig 设不了 mode；key 落盘必须 0600
      p.outro("已写入 config.json，开始对话")
      return "configured"
    }
    const reason = classifyProbeError(status, body)
    p.log.error(`连通失败：${REASON[reason]}${body ? `（${body}）` : ""}`)
    const retry = await p.confirm({ message: "重试？" })
    if (p.isCancel(retry) || !retry) { p.cancel("已退出，未做任何修改"); return "aborted" }
    step = retryStepFor(reason)
  }
}
