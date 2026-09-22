/**
 * Skill evolution tests（主切入点）：提炼管线（粗查 / 增量范围 / 提炼 LLM /
 * 提案落文件 / 水位推进）+ 调度簿记 + skill_create 提案面 + 治理审计事件。
 *
 * 脚本化假 LLM 驱动（test/memory/helpers.ts 的 scriptedLlm 先例）+ 临时目录 +
 * 真 SessionStore / 真 ProposalStore / 真 WriteLedger。断言只看外部行为：
 * 提案文件字段、事件流里的 skill 审计事件、扫描可见性、调用计数。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SkillEvolutionSystem } from "../../src/skills/evolution.js"
import { scanSkillDirs } from "../../src/skills/index.js"
import { SessionStore } from "../../src/session/store.js"
import { defaultConfig, type KclawConfig } from "../../src/storage/config.js"
import { newMessage, type Message } from "../../src/protocol/messages.js"
import type { Block } from "../../src/protocol/blocks.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { SkillEvent } from "../../src/session/events.js"
import { createSkillLink } from "../../src/skills/links.js"

let root: string
let sessions: SessionStore
let skillsDir: string
// 项目工作目录必须是真实可创建的路径（提案 apply 会写入 <workdir>/.kclaw/skills），
// 放在临时 root 下；每个用例的 beforeEach 重新赋值。
let WORKDIR: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-evo-"))
  sessions = new SessionStore(join(root, "sessions"))
  skillsDir = join(root, "skills")
  WORKDIR = join(root, "proj")
  mkdirSync(skillsDir, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function enabledConfig(): KclawConfig {
  const cfg = structuredClone(defaultConfig)
  cfg.skills = { evolution: { enabled: true, idleMinutes: 10 } }
  return cfg
}

/** 计数 + 脚本化 LLM：每次调用消耗一条脚本（或抛错）；多余的调用重复最后一条。
 * seen 记录每次调用请求里的用户内容（渲染段），供"模型看得到什么"断言。 */
function fakeLlm(replies: Array<string | Error>): { client: LlmClient; calls: () => number; seen: string[] } {
  let call = 0
  const seen: string[] = []
  const client: LlmClient = {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      const i = Math.min(call, replies.length - 1)
      call += 1
      const reply = replies[i]!
      const last = req.messages[req.messages.length - 1]
      seen.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""))
      if (reply instanceof Error) throw reply
      yield { type: "text_delta", delta: reply }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  return { client, calls: () => call, seen }
}

function installSkill(rootDir: string, name: string, body: string): void {
  mkdirSync(join(rootDir, name), { recursive: true })
  writeFileSync(join(rootDir, name, "SKILL.md"), `---\ndescription: 测试技能\n---\n${body}\n`)
}

function userText(sessionId: string, text: string): Message {
  return newMessage(sessionId, "user", [{ id: `blk_u_${text.length}_${Math.random()}`, type: "text", text }])
}
function toolCall(sessionId: string, name: string, args: unknown): Message {
  return newMessage(sessionId, "assistant", [
    { id: `blk_c_${Math.random()}`, type: "tool_call", callId: `call_${Math.random()}`, name, args, argsJson: JSON.stringify(args) },
  ] satisfies Block[])
}
function toolResult(sessionId: string, callId: string, output: string): Message {
  return newMessage(sessionId, "tool", [{ id: `blk_t_${Math.random()}`, type: "tool_result", callId, status: "ok", output, durationMs: 1 }] satisfies Block[])
}

function skillEvents(sessionId: string): SkillEvent[] {
  return sessions.readEvents(sessionId).filter((e): e is SkillEvent => e.type === "skill")
}

function system(llm: LlmClient, over: Partial<ConstructorParameters<typeof SkillEvolutionSystem>[0]> = {}): SkillEvolutionSystem {
  return new SkillEvolutionSystem({
    skillsDir,
    sessions,
    config: enabledConfig(),
    resolveLlm: () => ({ llm, model: "test" }),
    ...over,
  })
}

// ---- 粗查与调度簿记（run 收尾钩子消费面） ---------------------------------

describe("considerFollowCheck", () => {
  it("skips without scheduling or touching watermarks when no skill was involved", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, userText(meta.id, "帮我看看这段日志"))
    const { client, calls } = fakeLlm([])
    const evo = system(client)
    const r = evo.considerFollowCheck(meta.id, "2026-09-21T10:00:00.000Z", ["deploy-runbook"])
    expect(r.involved).toBe(false)
    expect(evo.pendingFollowChecks(WORKDIR)).toHaveLength(0)
    // 粗查零 LLM：范围选取纯读，一次调用都不发生
    expect(calls()).toBe(0)
  })

  it("schedules a check when a skill_read tool_call block is in the project deltas", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.considerFollowCheck(meta.id, "2026-09-21T10:00:00.000Z", ["deploy-runbook"])
    expect(r.involved).toBe(true)
    expect(r.names).toContain("deploy-runbook")
    const checks = evo.pendingFollowChecks(WORKDIR)
    expect(checks).toEqual([{ sessionId: meta.id, endTurnAt: "2026-09-21T10:00:00.000Z" }])
  })

  it("counts skill_list blocks and /mentions of user-invocable:false skills (wider set)", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    installSkill(skillsDir, "quiet-skill", "安静技能")
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_list", {}))
    const { client } = fakeLlm([])
    const evo = system(client)
    const viaList = evo.considerFollowCheck(meta.id, "2026-09-21T10:00:00.000Z", ["quiet-skill"])
    expect(viaList.involved).toBe(true)
    // /记号 宽集：matchSkillInvocations 本体按 user-invocable 过滤，粗查不受档位限制
    sessions.appendMessage(meta.id, userText(meta.id, "帮忙看看 /quiet-skill"))
    const viaMention = evo.considerFollowCheck(meta.id, "2026-09-21T10:05:00.000Z", ["quiet-skill"])
    expect(viaMention.involved).toBe(true)
    expect(viaMention.names).toContain("quiet-skill")
  })

  it("refreshes the anchor when the same session schedules twice", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "a" }))
    const { client } = fakeLlm([])
    const evo = system(client)
    evo.considerFollowCheck(meta.id, "2026-09-21T10:00:00.000Z", ["a"])
    evo.considerFollowCheck(meta.id, "2026-09-21T10:03:00.000Z", ["a"])
    expect(evo.pendingFollowChecks(WORKDIR)).toEqual([{ sessionId: meta.id, endTurnAt: "2026-09-21T10:03:00.000Z" }])
  })

  it("sees other sessions' unprocessed deltas in the same project (project-wide coarse check)", () => {
    const a = sessions.create("a", undefined, WORKDIR)
    sessions.appendMessage(a.id, toolCall(a.id, "skill_read", { name: "deploy-runbook" }))
    const { client } = fakeLlm([])
    const evo = system(client)
    evo.considerFollowCheck(a.id, "2026-09-21T10:00:00.000Z", ["deploy-runbook"])
    // 会话 B（无技能）的 run 收尾：粗查范围是全项目增量，A 的未处理卷入仍然命中
    const b = sessions.create("b", undefined, WORKDIR)
    sessions.appendMessage(b.id, userText(b.id, "今天天气如何"))
    const r = evo.considerFollowCheck(b.id, "2026-09-21T10:02:00.000Z", ["deploy-runbook"])
    expect(r.involved).toBe(true)
    expect(evo.pendingFollowChecks(WORKDIR).map((c) => c.sessionId).sort()).toEqual([a.id, b.id].sort())
  })

  it("lastActivity returns the project's max session updatedAt", () => {
    const a = sessions.create("a", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    expect(evo.lastActivity(WORKDIR)).toBe(a.updatedAt)
  })
})

// ---- 提炼管线（triggerFollow） --------------------------------------------

const ONE_NEW_PROPOSAL = JSON.stringify({
  proposals: [{ kind: "new", name: "deploy-postmortem", scope: "project", title: "复盘模板", rationale: "部署后总要做复盘", content: "---\ndescription: 复盘\n---\n复盘步骤" }],
})

describe("triggerFollow", () => {
  it("extracts a proposal with full fields and advances the watermark", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const callId = "call_1"
    sessions.appendMessage(meta.id, userText(meta.id, "按 /deploy-runbook 部署"))
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    sessions.appendMessage(meta.id, toolResult(meta.id, callId, "部署规程 DEPLOY_BODY"))
    const { client, calls, seen } = fakeLlm([ONE_NEW_PROPOSAL])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const proposals = evo.listProposals()
    expect(proposals).toHaveLength(1)
    const p = proposals[0]!
    expect(p.status).toBe("proposed")
    expect(p.kind).toBe("new")
    expect(p.name).toBe("deploy-postmortem")
    expect(p.scope).toBe("project")
    expect(p.workdir).toBe(WORKDIR)
    expect(p.source).toBe("follow")
    expect(p.sourceSessionId).toBe(meta.id)
    expect(p.content).toContain("复盘步骤")
    expect(p.baseline).toBeUndefined()
    // 提炼模型看得到读了什么：渲染段带技能正文
    expect(seen[0]).toContain("DEPLOY_BODY")
    // 水位推进：再次触发无增量（无第二次 LLM 调用、无第二条提案）
    await evo.triggerFollow(WORKDIR, meta.id)
    expect(calls()).toBe(1)
    expect(evo.listProposals()).toHaveLength(1)
    // 审计事件：op=proposed、source=follow，归属发起补查的会话
    const events = skillEvents(meta.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.op).toBe("proposed")
    expect(events[0]!.source).toBe("follow")
  })

  it("carries the live content as baseline for revise proposals", async () => {
    installSkill(skillsDir, "deploy-runbook", "部署规程 V1")
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const revise = JSON.stringify({
      proposals: [{ kind: "revise", name: "deploy-runbook", scope: "global", title: "t", rationale: "r", changes: "改了第 2 步", content: "---\ndescription: d\n---\nV2" }],
    })
    const { client } = fakeLlm([revise])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const p = evo.listProposals()[0]!
    expect(p.kind).toBe("revise")
    expect(p.scope).toBe("global")
    expect(p.workdir).toBeUndefined()
    expect(p.changes).toBe("改了第 2 步")
    expect(p.baseline).toContain("V1")
  })

  it("rejects on LLM failure, keeps watermarks, and retries the same range next time", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const { client, calls } = fakeLlm([new Error("provider 5xx"), ONE_NEW_PROPOSAL])
    const evo = system(client)
    await expect(evo.triggerFollow(WORKDIR, meta.id)).rejects.toThrow()
    expect(evo.listProposals()).toHaveLength(0)
    // 重试：同一批内容再提炼一次并成功
    await evo.triggerFollow(WORKDIR, meta.id)
    expect(calls()).toBe(2)
    expect(evo.listProposals()).toHaveLength(1)
  })

  it("advances watermarks on an unparseable reply and stays quiet (no files, no events)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const { client, calls } = fakeLlm(["这不是 JSON"])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    expect(evo.listProposals()).toHaveLength(0)
    expect(skillEvents(meta.id)).toHaveLength(0)
    await evo.triggerFollow(WORKDIR, meta.id)
    expect(calls()).toBe(1) // 水位已推进：安静结束不重提
  })

  it("caps at 3 proposals per batch and drops malformed entries without blocking the rest", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const good = (name: string): string => JSON.stringify({ kind: "new", name, scope: "project", title: "t", rationale: "r", content: `---\ndescription: d\n---\n${name}` })
    const four = JSON.stringify({ proposals: [JSON.parse(good("keep-1")), { kind: "new", name: "Bad_Name!", content: "x" }, JSON.parse(good("keep-2")), JSON.parse(good("dropped-4"))] })
    const { client } = fakeLlm([four])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const names = evo.listProposals().map((p) => p.name).sort()
    expect(names).toEqual(["keep-1", "keep-2"])
  })

  it("drops revise targets that are missing or reuse links; falls back an invalid scope to project", async () => {
    installSkill(skillsDir, "deploy-runbook", "部署规程")
    installSkill(join(root, "ext"), "real-kit", "外部正文")
    const link = createSkillLink({ skillsDir, name: "external-kit", target: join(root, "ext", "real-kit"), agent: "zcode" })
    expect(link.ok).toBe(true)
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const batch = JSON.stringify({
      proposals: [
        { kind: "revise", name: "ghost-skill", scope: "global", content: "x" },
        { kind: "revise", name: "external-kit", scope: "global", content: "x" },
        { kind: "new", name: "fallback-scope", scope: "elsewhere", content: "---\ndescription: d\n---\n正文" },
        { kind: "new", name: "empty-content", scope: "project", content: "" },
      ],
    })
    const { client } = fakeLlm([batch])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const names = evo.listProposals().map((p) => p.name).sort()
    expect(names).toEqual(["fallback-scope"])
    expect(evo.listProposals()[0]!.scope).toBe("project") // 非法 scope 回退影响面小的方向
  })
})

// ---- skill_create 提案面 ---------------------------------------------------

describe("propose (skill_create face)", () => {
  it("creates a new-skill proposal scoped to the session's project", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.propose(meta.id, { name: "deploy-postmortem", content: "---\ndescription: 复盘\n---\n步骤", rationale: "用户要求固化" })
    expect(r.ok).toBe(true)
    const p = evo.listProposals()[0]!
    expect(p.kind).toBe("new")
    expect(p.scope).toBe("project")
    expect(p.workdir).toBe(WORKDIR)
    expect(p.source).toBe("skill_create")
    expect(p.sourceSessionId).toBe(meta.id)
    const events = skillEvents(meta.id)
    expect(events[0]!.source).toBe("skill_create")
  })

  it("derives kind=revise + scope from the installed copy (project hit wins over global)", () => {
    installSkill(skillsDir, "shared-skill", "全局版")
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const rGlobalOnly = evo.propose(meta.id, { name: "shared-skill", content: "V2" })
    expect(rGlobalOnly.ok).toBe(true)
    expect(rGlobalOnly.ok && rGlobalOnly.proposal.kind).toBe("revise")
    expect(rGlobalOnly.ok && rGlobalOnly.proposal.scope).toBe("global")
    expect(rGlobalOnly.ok && rGlobalOnly.proposal.baseline).toContain("全局版")
    // 项目副本命中 → scope=project，跟随当前会话工作目录
    installSkill(join(WORKDIR, ".kclaw", "skills"), "shared-skill", "项目版")
    const rProject = evo.propose(meta.id, { name: "shared-skill", content: "V3" })
    expect(rProject.ok).toBe(true)
    expect(rProject.ok && rProject.proposal.scope).toBe("project")
    expect(rProject.ok && rProject.proposal.workdir).toBe(WORKDIR)
  })

  it("rejects reuse-link targets up front", () => {
    installSkill(join(root, "ext"), "real-kit", "外部正文")
    expect(createSkillLink({ skillsDir, name: "external-kit", target: join(root, "ext", "real-kit"), agent: "zcode" }).ok).toBe(true)
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.propose(meta.id, { name: "external-kit", content: "x" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.conflict).toBe(true)
  })

  it("rejects invalid names and over-64KB content", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    expect(evo.propose(meta.id, { name: "Bad_Name", content: "x" }).ok).toBe(false)
    expect(evo.propose(meta.id, { name: "too-big", content: "x".repeat(64 * 1024 + 1) }).ok).toBe(false)
  })
})

// ---- 治理面与用量遥测 -------------------------------------------------------

describe("governance and usage telemetry", () => {
  it("applies a new proposal into the project skills dir; the next scan sees it; revert removes it", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.propose(meta.id, { name: "temp-kit", content: "---\ndescription: d\n---\n临时技能" })
    expect(r.ok).toBe(true)
    const applied = evo.applyProposal(r.ok ? r.proposal.id : "")
    expect(applied.ok).toBe(true)
    expect(scanSkillDirs({ global: skillsDir, project: join(WORKDIR, ".kclaw", "skills") }).some((s) => s.name === "temp-kit")).toBe(true)
    // 审计事件归属：scope=project → 项目最近活动会话
    expect(skillEvents(meta.id).map((e) => e.op)).toEqual(["proposed", "applied"])
    const reverted = evo.revertProposal(r.ok ? r.proposal.id : "")
    expect(reverted.ok).toBe(true)
    expect(scanSkillDirs({ global: skillsDir, project: join(WORKDIR, ".kclaw", "skills") }).some((s) => s.name === "temp-kit")).toBe(false)
    // reverted 可删
    expect(evo.removeProposal(r.ok ? r.proposal.id : "").ok).toBe(true)
    expect(evo.listProposals()).toHaveLength(0)
  })

  it("refuses illegal transitions and known conflicts without changing state", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    installSkill(skillsDir, "deploy-runbook", "部署规程 V1")
    // 提炼给出 kind=new 的已存在技能名 → apply 冲突，保持 proposed，原文件未被碰
    //（skill_create 侧自动推导 revise，造不出这种提案——冲突只能来自提炼输出）
    const dupBatch = JSON.stringify({ proposals: [{ kind: "new", name: "deploy-runbook", scope: "global", title: "t", rationale: "r", content: "新正文" }] })
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const { client } = fakeLlm([dupBatch])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const dup = evo.listProposals().find((p) => p.kind === "new" && p.name === "deploy-runbook")!
    const applied = evo.applyProposal(dup.id)
    expect(!applied.ok && applied.conflict).toBe(true)
    expect(readFileSync(join(skillsDir, "deploy-runbook", "SKILL.md"), "utf8")).toContain("V1")
    expect(evo.getProposal(dup.id)?.status).toBe("proposed")
    // revise：快照 + 覆盖 + 回退写回
    const rev = evo.propose(meta.id, { name: "deploy-runbook", content: "部署规程 V2" })
    expect(rev.ok).toBe(true)
    const okApply = evo.applyProposal(rev.ok ? rev.proposal.id : "")
    expect(okApply.ok).toBe(true)
    expect(readFileSync(join(skillsDir, "deploy-runbook", "SKILL.md"), "utf8")).toContain("V2")
    expect(evo.getProposal(rev.ok ? rev.proposal.id : "")?.snapshot).toContain("V1")
    expect(evo.revertProposal(rev.ok ? rev.proposal.id : "").ok).toBe(true)
    expect(readFileSync(join(skillsDir, "deploy-runbook", "SKILL.md"), "utf8")).toContain("V1")
    // 非法流转：proposed 不可删；rejected 不可再 reject/apply
    const ghost = evo.propose(meta.id, { name: "ghost-two", content: "x" })
    expect(ghost.ok).toBe(true)
    expect(evo.removeProposal(ghost.ok ? ghost.proposal.id : "").ok).toBe(false)
    expect(evo.rejectProposal(ghost.ok ? ghost.proposal.id : "").ok).toBe(true)
    expect(evo.rejectProposal(ghost.ok ? ghost.proposal.id : "").ok).toBe(false)
    expect(evo.applyProposal(ghost.ok ? ghost.proposal.id : "").ok).toBe(false)
  })

  it("apply of a revise proposal warns when the live content drifted from baseline", async () => {
    installSkill(skillsDir, "drift-kit", "部署规程 V1")
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.propose(meta.id, { name: "drift-kit", content: "部署规程 V2" })
    expect(r.ok).toBe(true)
    // 第三方在提案后改了正文：apply 不阻止，但响应带漂移提示
    writeFileSync(join(skillsDir, "drift-kit", "SKILL.md"), "部署规程 V1-被别人改过")
    const applied = evo.applyProposal(r.ok ? r.proposal.id : "")
    expect(applied.ok).toBe(true)
    expect(applied.warning).toContain("已被改动")
    expect(readFileSync(join(skillsDir, "drift-kit", "SKILL.md"), "utf8")).toContain("V2")
    expect(evo.getProposal(r.ok ? r.proposal.id : "")?.snapshot).toContain("被别人改过")
  })

  it("apply of a global proposal warns when a known project has the same-named skill (shadowing)", async () => {
    // 项目里已有同名技能，提炼 LLM 仍给出 scope=global 的 new 提案：
    // apply 应当成功（全局落点为空），但带遮蔽警告（项目副本整目录覆盖全局）。
    installSkill(join(WORKDIR, ".kclaw", "skills"), "shadowed", "项目版")
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "deploy-runbook" }))
    const batch = JSON.stringify({ proposals: [{ kind: "new", name: "shadowed", scope: "global", title: "t", rationale: "r", content: "全局版" }] })
    const { client } = fakeLlm([batch])
    const evo = system(client)
    await evo.triggerFollow(WORKDIR, meta.id)
    const p = evo.listProposals().find((x) => x.name === "shadowed")!
    expect(p.scope).toBe("global")
    const applied = evo.applyProposal(p.id)
    expect(applied.ok).toBe(true)
    expect(applied.warning).toContain("遮蔽")
    expect(existsSync(join(skillsDir, "shadowed", "SKILL.md"))).toBe(true)
  })

  it("usageOf counts skill_read calls for the proposal name after appliedAt", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    const r = evo.propose(meta.id, { name: "counter-kit", content: "---\ndescription: d\n---\n正文" })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.proposal.id : ""
    // apply 之前被读：不计。（消息 createdAt 与 appliedAt 都是毫秒精度，
    // 阶段间小睡保证时间戳严格有序，否则同毫秒的 apply 前读取会被误计。）
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "counter-kit" }))
    expect(evo.proposalUsage(id)).toBe(0)
    await new Promise((r2) => setTimeout(r2, 10))
    const applied = evo.applyProposal(id)
    expect(applied.ok).toBe(true)
    await new Promise((r2) => setTimeout(r2, 10))
    // apply 之后：skill_read 计入，skill_list 不计，其他技能的读取不计
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "counter-kit" }))
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "counter-kit" }))
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_list", {}))
    sessions.appendMessage(meta.id, toolCall(meta.id, "skill_read", { name: "other-kit" }))
    expect(evo.proposalUsage(id)).toBe(2)
  })

  it("reads proposal files tolerantly: corrupt files are skipped", () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const { client } = fakeLlm([])
    const evo = system(client)
    evo.propose(meta.id, { name: "good-one", content: "x" })
    writeFileSync(join(skillsDir, ".proposals", "999-corrupt.json"), "{oops")
    expect(evo.listProposals().map((p) => p.name)).toEqual(["good-one"])
  })
})
