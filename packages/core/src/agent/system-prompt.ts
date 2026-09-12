/**
 * assembleSystemPrompt — the system prompt's two-segment assembly, its
 * freeze discipline and the per-run audit append, in one place.
 *
 * 系统提示词（提示词缓存纪律，双段独立冻结）：stable（人设基座 + 注入约定）
 * 是缓存冻结面，live（认知 + 技能清单）是低频变化面。每 run 两段现算、与
 * 基线逐段比对——段文本没变就沿用基线（frozenAt 不动），变了就重冻结该段。
 * 前缀缓存按从头逐字节相同匹配：live 变化只失效变化点之后，stable 前缀
 * 继续命中；装技能、夜间认知刷新在下一 run 即时生效，不再等压缩边界。
 * 两段全命中时 system-after 链跳过；至少一段变化时走 system-after（用户可
 * 改终稿）——改写发生时事件记 stable=终稿（审计恒记录模型实际看到的那份）、
 * live=现算文本：stable 基线于是偏离现算值，下一个 run 自然重装配、改写每
 * run 重新生效；live 基线则照常逐字比对，frozenAt 不会虚假刷新。审计每 run
 * 一条双段全量留痕（直接落盘；写失败即 run 失败）。压缩事件在投影里清除
 * 基线（applyEvent），下一次 run 重新装配并固化——压缩本来就使缓存全量失效，
 * 纪元边界设在冷启动处零额外成本。子代理 run 的精简模板同样适用（live 恒空）。
 */
import { estimateTokens } from "../session/compaction.js"
import type { SessionMeta, SessionStore } from "../session/store.js"
import type { HookChain } from "../hooks/runner.js"
import { SYSTEM_INJECTION_CONVENTION } from "./context.js"

export interface AssembleSystemPromptInput {
  chain: HookChain
  sessions: SessionStore
  sessionId: string
  /** 人设基座：主会话完整模板或子代理精简模板（调用方决定）。 */
  base: string
  /** 会话 meta 里的双段冻结基线（undefined = 首次装配）。 */
  baseline: SessionMeta["systemBaseline"]
  /** 发给供应商的工具 schema，字符串化后计入固定开销。 */
  toolDefs: readonly unknown[]
}

export interface AssembledSystemPrompt {
  /** 发给模型的完整系统提示词。 */
  system: string
  /** 组装结果 + 工具 schema 的估算 token 数（压缩/打包判定的固定开销）。 */
  overheadTokens: number
}

export async function assembleSystemPrompt(input: AssembleSystemPromptInput): Promise<AssembledSystemPrompt> {
  const { chain, sessions, sessionId, base, baseline, toolDefs } = input
  const stable = [base, SYSTEM_INJECTION_CONVENTION].filter((s) => s !== "").join("\n\n")
  // live：system-before 链产出（内置 system-materials：认知 + 技能清单；
  // 用户段落同列此链，一并归属 live 段）。
  const segments = (await chain.run("system-before", { base })) ?? []
  const live = segments.filter((s) => s !== "").join("\n\n")
  const stableFresh = baseline === undefined || baseline.stable.text !== stable
  const liveFresh = baseline?.live === undefined || baseline.live.text !== live
  let system: string
  if (!stableFresh && !liveFresh) {
    system = [baseline.stable.text, baseline.live!.text].filter((s) => s !== "").join("\n\n")
    sessions.appendSystem(sessionId, { at: new Date().toISOString(), stable, live })
  } else {
    const draft = [stable, live].filter((s) => s !== "").join("\n\n")
    const rewrittenSystem = await chain.run("system-after", { system: draft })
    if (rewrittenSystem !== undefined) {
      system = rewrittenSystem
      // stable freezes the REWRITTEN text (what the model actually saw — the
      // audit's contract), so the next run's fresh stable differs and the
      // assembly (and the rewrite) re-runs; live carries the freshly computed
      // segment so ITS baseline still compares equal across rewrites — a
      // rewrite must not phantom-refresh live's frozenAt.
      sessions.appendSystem(sessionId, { at: new Date().toISOString(), stable: system, live })
    } else {
      system = draft
      sessions.appendSystem(sessionId, { at: new Date().toISOString(), stable, live })
    }
  }
  return {
    system,
    overheadTokens: estimateTokens(system) + estimateTokens(JSON.stringify(toolDefs)),
  }
}
