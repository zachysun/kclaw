/**
 * assembleSystemPrompt 直调测试：双段冻结、基线沿用、改写后 stable 基线
 * 偏离现算而 live 基线照常逐字比对（frozenAt 不虚刷）。端到端行为
 * （executeRun 经同一函数）另有 hooks/assembly.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { assembleSystemPrompt } from "../../src/agent/system-prompt.js"
import { SessionStore } from "../../src/session/store.js"
import { estimateTokens } from "../../src/session/compaction.js"
import { chainOf, hook } from "./hook-utils.js"
import type { HookEntry } from "../../src/hooks/types.js"

let home: string
beforeEach(() => {
  home = join(tmpdir(), `kclaw-sysprompt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(home, { recursive: true })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const TOOL_DEFS = [{ type: "function", function: { name: "exec", parameters: {} } }]

function systemEvents(sessions: SessionStore, sessionId: string): Array<{ stable: string; live: string }> {
  return sessions.readEvents(sessionId).filter((e) => e.type === "system") as Array<{ stable: string; live: string }>
}

describe("assembleSystemPrompt", () => {
  it("首装：system = stable + live 段，审计落盘，固定开销计入系统提示词与工具 schema", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("组装")
    const entries: HookEntry[] = [hook("seg", "system-before", () => ["认知段落", ""])] // 空段被过滤
    const chain = chainOf(...entries)

    const { system, overheadTokens } = await assembleSystemPrompt({
      chain, sessions, sessionId: session.id, base: "人设基座", baseline: undefined, toolDefs: TOOL_DEFS,
    })

    expect(system).toContain("人设基座")
    expect(system).toContain("认知段落")
    const [audit] = systemEvents(sessions, session.id)
    expect(audit.stable).toContain("人设基座")
    expect(audit.stable).toContain("<system-reminder>") // 注入约定声明在 stable 段
    expect(audit.live).toBe("认知段落")
    // 开销 = 系统提示词 + 工具 schema 两部分，都非零
    expect(overheadTokens).toBeGreaterThan(estimateTokens(system))
    const baseline = sessions.meta(session.id)?.systemBaseline
    expect(baseline?.stable.text).toBe(audit.stable)
    expect(baseline?.live?.text).toBe("认知段落")
  })

  it("两段全命中：沿用基线文本，frozenAt 不动，审计照常每 run 一条", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("沿用")
    const chain = chainOf(hook("seg", "system-before", () => ["认知段落"]))
    const input = {
      chain, sessions, sessionId: session.id, base: "人设基座",
      baseline: sessions.meta(session.id)?.systemBaseline, toolDefs: TOOL_DEFS,
    }

    await assembleSystemPrompt(input)
    const afterFirst = sessions.meta(session.id)?.systemBaseline
    const frozenAtStable = afterFirst?.stable.frozenAt
    const frozenAtLive = afterFirst?.live?.frozenAt
    expect(frozenAtStable).toBeDefined()

    const second = await assembleSystemPrompt({ ...input, baseline: afterFirst })
    // 命中基线：拼回基线文本，内容与首次一致
    expect(second.system).toContain("人设基座")
    expect(second.system).toContain("认知段落")
    const afterSecond = sessions.meta(session.id)?.systemBaseline
    expect(afterSecond?.stable.frozenAt).toBe(frozenAtStable)
    expect(afterSecond?.live?.frozenAt).toBe(frozenAtLive)
    // 审计每 run 一条：两次装配两条事件
    expect(systemEvents(sessions, session.id)).toHaveLength(2)
  })

  it("改写：stable 冻结终稿（基线偏离现算、改写每 run 重新生效），live 逐字比对、frozenAt 不虚刷", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("改写")
    const rewrite = "改写后的终稿"
    const chain = chainOf(
      hook("seg", "system-before", () => ["认知段落"]),
      hook("rewriter", "system-after", ({ system }) => `${rewrite}（原 ${system.length} 字）`),
    )
    const input = {
      chain, sessions, sessionId: session.id, base: "人设基座",
      baseline: sessions.meta(session.id)?.systemBaseline, toolDefs: TOOL_DEFS,
    }

    const first = await assembleSystemPrompt(input)
    expect(first.system.startsWith(rewrite)).toBe(true)
    // 事件记 stable=终稿（模型实际看到的那份）、live=现算文本
    const firstAudit = systemEvents(sessions, session.id)[0]!
    expect(firstAudit.stable).toBe(first.system)
    expect(firstAudit.live).toBe("认知段落")
    const liveFrozenAt = sessions.meta(session.id)?.systemBaseline?.live?.frozenAt

    // 第二个 run：fresh stable ≠ 基线（基线是终稿）→ 重装配、改写再次生效；
    // live 现算文本与基线逐字相同 → 沿用，frozenAt 不得被改写刷新
    const second = await assembleSystemPrompt({ ...input, baseline: sessions.meta(session.id)?.systemBaseline })
    expect(second.system.startsWith(rewrite)).toBe(true)
    expect(second.system).toBe(first.system)
    const afterSecond = sessions.meta(session.id)?.systemBaseline
    expect(afterSecond?.live?.frozenAt).toBe(liveFrozenAt)
    expect(afterSecond?.stable.text).toBe(first.system)
  })
})
