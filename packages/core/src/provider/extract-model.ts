/**
 * The extraction-model resolution chain shared by every background extractor
 * (memory pipeline, skill evolution): `memory.extractModel` picks which model
 * serves background extraction calls — no separate field exists for the skill
 * path, both systems resolve through THIS one helper so they can never drift.
 *
 * Chain (identical to the pre-extraction inline form in MemorySystem):
 * - "" (empty) → the main conversation model, endpoint included;
 * - a provider ENTRY name → that entry's own endpoint and its wire model
 *   (an entry name must never be sent as a wire model name);
 * - anything else is a bare wire model name, sent to the main endpoint.
 */
import { createProviderClient } from "./factory.js"
import { withRetry } from "./retry.js"
import type { KclawConfig } from "../storage/config.js"
import type { LlmClient } from "./types.js"

export function makeExtractLlmResolver(opts: {
  config: KclawConfig
  /** 主对话模型客户端与模型名的解析器（daemon 注入；测试注入脚本客户端）。 */
  resolveLlm: () => { llm: LlmClient; model: string }
  /**
   * extractModel 命中 provider 条目时解析该条目客户端的钩子（daemon 注入
   * 签名缓存的 resolver，条目编辑热生效）；缺省每调用现建客户端。
   */
  resolveEntryLlm?: (entryKey: string) => LlmClient
}): () => { llm: LlmClient; model: string } {
  return () => {
    const { llm, model } = opts.resolveLlm()
    const raw = opts.config.memory.extractModel
    if (raw === "") return { llm, model }
    const entry = opts.config.providers.entries[raw]
    if (entry === undefined) return { llm, model: raw }
    const client = opts.resolveEntryLlm !== undefined
      ? opts.resolveEntryLlm(raw)
      : createProviderClient({ entry, timeoutMs: opts.config.providers.timeoutMs })
    return { llm: withRetry(client), model: entry.model }
  }
}
