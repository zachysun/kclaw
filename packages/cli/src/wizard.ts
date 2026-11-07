/**
 * First-run provider wizard: when the daemon reports `configured: false` and
 * stdout is a TTY, `kclaw chat` hands over to runWizard — a 30-second
 * select→key→model flow. Everything that touches the configuration goes
 * through the daemon, the process that holds the configuration and makes the
 * real model calls: the connection test is `POST /providers/probe` (a 1-token
 * completion sent from the daemon), and only after it succeeds is the entry
 * saved (`POST /providers`; `PATCH /providers/:name` when that name already
 * exists) and made the default. The daemon persists the change and publishes
 * it, so the next message already uses it — no restart. Every cancel or
 * "重试？→否" bails out before anything is saved.
 *
 * The template menu derives from core's PROVIDER_PRESETS (the format +
 * baseUrl canon shared with the Model tab) plus wizard-only extras
 * (defaultModel suggestions, the custom template); the probe and the saved
 * entry carry the preset's wire format, so Anthropic-format providers are
 * configurable from the first run too.
 *
 * The custom template has no baseUrl of its own, so the flow inserts a
 * baseUrl input step for it before the key step.
 */
import * as p from "@clack/prompts"
import { findProviderPreset } from "@kclaw/core"
import type { ProviderApiFormat } from "@kclaw/core"
import { HttpRequestError } from "@kclaw/core/client-http"
import type { KclawClient } from "./client.js"

export interface Template {
  id: "deepseek" | "openai" | "anthropic" | "ollama" | "custom"
  label: string
  format: ProviderApiFormat
  baseUrl?: string
  defaultModel?: string
  skipKey?: boolean
}

/** Model-name suggestions per template (the model step's placeholder). */
const DEFAULT_MODELS: Partial<Record<Template["id"], string>> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
}

/** Wizard menu order (deepseek first — the common first-run choice here). */
const WIZARD_TEMPLATE_IDS = ["deepseek", "openai", "anthropic", "ollama"] as const

export const PROVIDER_TEMPLATES: Template[] = [
  ...WIZARD_TEMPLATE_IDS.map((id): Template => {
    const preset = findProviderPreset(id)!
    return {
      id,
      label: preset.label,
      format: preset.format,
      baseUrl: preset.baseUrl,
      ...(preset.authOptional === true ? { skipKey: true } : {}),
      ...(DEFAULT_MODELS[id] !== undefined ? { defaultModel: DEFAULT_MODELS[id] } : {}),
    }
  }),
  { id: "custom", label: "Custom OpenAI-compatible endpoint", format: "openai" },
]

export function buildProviderEntry(t: Template, apiKey: string, model: string) {
  return { format: t.format, baseUrl: t.baseUrl ?? "", apiKey: t.skipKey ? "ollama" : apiKey, model }
}

export function classifyProbeError(status: number | null, message: string): "key" | "network" | "model" | "unknown" {
  if (status === null) return "network"
  if (status === 401 || status === 403) return "key"
  if (status === 404) return "model"
  if (status === 400 && /model/i.test(message)) return "model"
  return "unknown"
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

/** Save the probed entry under `name` and make it the default; a same-named entry (409) is overwritten. */
async function saveAsDefault(client: KclawClient, name: string, entry: ReturnType<typeof buildProviderEntry>): Promise<void> {
  try {
    await client.request("POST", "/providers", { name, entry })
  } catch (error) {
    if (!(error instanceof HttpRequestError) || error.status !== 409) throw error
    await client.request("PATCH", `/providers/${encodeURIComponent(name)}`, { entry })
  }
  await client.request("POST", `/providers/${encodeURIComponent(name)}/default`)
}

export async function runWizard(client: KclawClient): Promise<"configured" | "aborted"> {
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
    const { status, body } = (await client.request("POST", "/providers/probe", entry)) as { status: number | null; body: string }
    s.stop(status !== null && status < 400 ? "连通成功" : "连通失败")
    if (status !== null && status < 400) {
      await saveAsDefault(client, tpl.id, entry)
      p.outro("配置已保存，开始对话")
      return "configured"
    }
    const reason = classifyProbeError(status, body)
    p.log.error(`连通失败：${REASON[reason]}${body ? `（${body}）` : ""}`)
    const retry = await p.confirm({ message: "重试？" })
    if (p.isCancel(retry) || !retry) { p.cancel("已退出，未做任何修改"); return "aborted" }
    step = retryStepFor(reason)
  }
}
