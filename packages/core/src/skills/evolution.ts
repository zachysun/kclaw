/**
 * Skill evolution — the extraction half of proposal-based skill
 * self-improvement (spec: docs/superpowers/self-evolving-skill-spec.md).
 *
 * What it does: after a run ends, a run-after hook asks `considerFollowCheck`
 * whether the finished conversation INVOLVED any skill (a zero-cost, zero-LLM
 * coarse check over the whole project's unextracted session deltas: any
 * skill_read/skill_list tool_call block, or a /mention of an installed skill).
 * Involvement schedules a follow check in the per-project ledger; a server
 * scheduler later consumes due checks through `triggerFollow`, which renders
 * each session's delta and asks the extraction LLM for 0..3 skill proposals.
 * Proposals land ONLY in `<skillsDir>/.proposals/` (never the live skill
 * directories) and every state change appends a `skill` audit event to the
 * session event stream.
 *
 * The skeleton is the memory system's follow-check machinery, with two
 * deliberate differences:
 * - the coarse check gates scheduling (memory schedules unconditionally) so
 *   conversations that never touched a skill cost nothing;
 * - there is no interval backstop — the scheduler therefore clears a check
 *   only AFTER a successful extraction (memory clears before triggering; its
 *   interval sweep is the retry net it can afford). A failed batch keeps its
 *   check and is retried on the next sweep; even if a daemon never sees
 *   another run in that project, the batch is not stranded (prototype
 *   finding #1).
 *
 * Subagent coverage: child sessions never schedule checks themselves (the
 * hook skips child runs), but coarse checks and extraction read the deltas of
 * ALL project sessions — child sessions included, deliberately un-filtered
 * (memory's #sessionRows excludes them; here they are the observation blind
 * spot the feature exists to cover).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { collectStreamText } from "../provider/collect.js"
import type { LlmClient } from "../provider/types.js"
import { renderSegment } from "../session/compaction.js"
import type { SessionStore } from "../session/store.js"
import type { KclawConfig } from "../storage/config.js"
import type { Message } from "../protocol/messages.js"
import type { SkillEvent } from "../session/events.js"
import { WriteLedger, type FollowCheck } from "../memory/ledger.js"
import { projectIdFor } from "../memory/layout.js"
import { linkedSkillNames } from "./links.js"
import { isSkillDirName } from "./names.js"
import { ProposalStore, type SkillProposal, type SkillProposalResult } from "./proposals.js"

/** Max proposals the extractor may produce per batch (excess dropped + logged). */
const MAX_PROPOSALS_PER_BATCH = 3
/** skill_create content cap: 64 KiB of UTF-8. */
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024

/**
 * 提炼器固定文案。字段名与 parseProposalItems 的校验逐字一致——模型只从
 * 这里认识 JSON 结构（照 memory EXTRACT_SYSTEM_PROMPT 的先例）。revise 必填
 * changes（改了哪里、为什么）；content 必须是含 frontmatter 的完整 SKILL.md；
 * 无值得提的就输出 {"proposals":[]} 安静结束。
 */
export const SKILL_EXTRACT_SYSTEM_PROMPT = [
  "你是技能库的提炼器。输入是一段会话消息（每行一条）与当前已装技能的清单。",
  "对话里可能有值得固化为技能的经验：某技能的规程有偏差需要修订，或反复出现的做法值得沉淀为新技能。",
  "只输出一个 JSON 对象：{\"proposals\":[…]}，每个元素都是 JSON 对象，字段名固定如下：",
  "- kind：\"new\"（新增技能）或 \"revise\"（修订已有技能），判别字段名是 kind，不是 type。",
  "- name：技能目录名，小写字母、数字与连字符组成（如 deploy-runbook）；revise 时必须是已装技能名。",
  "- scope：落点，\"global\"（全局技能库）或 \"project\"（当前项目的 .kclaw/skills）；拿不准用 \"project\"。",
  "- title：一句话短标题。rationale：为什么提这个案（从对话里看到的依据）。",
  "- changes：kind 为 revise 时必填，改了哪里、为什么（对照说明）。",
  "- content：完整的 SKILL.md 文件内容（YAML frontmatter + Markdown 正文，含 description 字段）。",
  "只有对话里出现了明确、可复用的经验才提案；不要为凑数提案，也不要重复提案里已有的内容。",
  "无值得提的内容输出 {\"proposals\":[]}。只输出 JSON，不要输出任何其他文字。",
].join("\n")

/** 消费面窄接口（照 MemoryQuery/MemoryScheduleBook 惯例：调用方按面声明依赖）。 */

/** 调度簿记 + 粗查面：run 收尾钩子（considerFollowCheck）与 server 调度器消费。 */
export interface SkillEvolutionScheduleBook {
  /**
   * run 收尾粗查（纯读、零 LLM）：范围 = 该项目全部会话（含子会话）各自的
   * 增量；卷入任一技能才排检查（同会话重复排=锚点刷新），未卷入不动增量进度。
   */
  considerFollowCheck(sessionId: string, endTurnAt: string, installedNames: readonly string[]): { involved: boolean; names: string[] }
  pendingFollowChecks(workdir: string): FollowCheck[]
  clearFollowCheck(workdir: string, sessionId: string): void
  /** 项目全部会话 meta 的最大 updatedAt（调度器判空闲门禁的"新活动"）。 */
  lastActivity(workdir: string): string
}

/** 提炼触发面：server 调度器（triggerFollow）与 skill_create 工具（propose）消费。 */
export interface SkillEvolutionTriggers {
  /**
   * 补查提炼：逐会话增量各调一次提炼 LLM；拿到合法 JSON（含 0 条）即推进
   * 该会话增量进度，单会话失败不阻塞其他会话，有失败时整体 reject（增量进度保留，
   * 调度器下个 sweep 重试同一范围），全部成功才 resolve。
   */
  triggerFollow(workdir: string, sessionId: string): Promise<void>
  /** skill_create 提案面：kind/scope 由系统推导，模型不给这两个参数。 */
  propose(sessionId: string, input: { name: string; content: string; rationale?: string }): SkillProposalResult
}

/** 治理面：server 路由消费（非法迁移/冲突由 store 判定，路由映射 409）。 */
export interface SkillEvolutionAdmin {
  listProposals(): SkillProposal[]
  getProposal(id: string): SkillProposal | undefined
  /** applied 提案的用量口径：appliedAt 之后全部会话里 skill_read(args.name==提案名) 的次数。 */
  proposalUsage(id: string): number
  applyProposal(id: string): SkillProposalResult
  rejectProposal(id: string): SkillProposalResult
  revertProposal(id: string): SkillProposalResult
  removeProposal(id: string): SkillProposalResult
}

export interface SkillEvolutionDeps {
  /** 全局技能目录 <home>/skills：提案目录 <skillsDir>/.proposals/ 也在这里。 */
  skillsDir: string
  sessions: SessionStore
  config: KclawConfig
  /** 每次提炼时解析提取模型（daemon 经 makeExtractLlmResolver 注入共享解析链）。 */
  resolveLlm: () => { llm: LlmClient; model: string }
  log?: (m: string) => void
  now?: () => Date
}

export class SkillEvolutionSystem implements SkillEvolutionScheduleBook, SkillEvolutionTriggers, SkillEvolutionAdmin {
  readonly #skillsDir: string
  readonly #sessions: SessionStore
  readonly #config: KclawConfig
  readonly #resolveLlm: () => { llm: LlmClient; model: string }
  readonly #store: ProposalStore
  readonly #log: (m: string) => void
  readonly #now: () => Date

  constructor(deps: SkillEvolutionDeps) {
    this.#skillsDir = deps.skillsDir
    this.#sessions = deps.sessions
    this.#config = deps.config
    this.#resolveLlm = deps.resolveLlm
    this.#log = deps.log ?? ((m) => console.error(m))
    this.#now = deps.now ?? (() => new Date())
    this.#store = new ProposalStore({
      proposalsDir: this.#proposalsDir,
      resolveDir: (scope, workdir) => (scope === "global" ? this.#skillsDir : join(workdir ?? this.#config.workspace, ".kclaw", "skills")),
      log: this.#log,
    })
  }

  get #proposalsDir(): string {
    return join(this.#skillsDir, ".proposals")
  }

  #nowISO(): string {
    return this.#now().toISOString()
  }

  // ---- 归属与项目范围（照 memory system 的同构先例） ----------------------

  /** 会话工作目录；meta 缺失回退 daemon workspace（照 memory system 同一取舍）。 */
  #workdirOf(sessionId: string): string {
    return this.#sessions.meta(sessionId)?.workdir ?? this.#config.workspace
  }

  /** 项目最近活动会话（admin 事件归属；子会话不参与回落，照 memory 先例）。 */
  #recentSessionId(workdir: string): string | undefined {
    return this.#sessions.list().filter((m) => (m.workdir ?? "") === workdir && m.parentSessionId === undefined)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0]?.id
  }

  /** 全局最近活动会话（global 提案 admin 事件归属）。 */
  #recentGlobalSessionId(): string | undefined {
    return this.#sessions.list().find((m) => m.parentSessionId === undefined)?.id
  }

  /** 项目全部会话（含子会话——观察盲区正是要覆盖的对象，刻意不排除）。 */
  #projectRows(workdir: string): Array<{ id: string; createdAt: string; messages: Message[] }> {
    return this.#sessions.list()
      .filter((m) => (m.workdir ?? "") === workdir)
      .map((m) => ({ id: m.id, createdAt: m.createdAt, messages: this.#sessions.readMessages(m.id) }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  // ---- 账本（每项目一本 <skillsDir>/.proposals/state/<projectId>.json） ----

  #ledgerPath(workdir: string): string {
    return join(this.#proposalsDir, "state", `${projectIdFor(workdir)}.json`)
  }

  /** 写通道：目录惰性创建（写语义）；每次现开现读（WriteLedger 禁长命实例）。 */
  #ledgerForWrite(workdir: string): WriteLedger {
    mkdirSync(join(this.#proposalsDir, "state"), { recursive: true })
    return new WriteLedger(this.#ledgerPath(workdir))
  }

  #ledger(workdir: string): WriteLedger {
    return new WriteLedger(this.#ledgerPath(workdir))
  }

  // ---- SkillEvolutionScheduleBook -----------------------------------------

  considerFollowCheck(sessionId: string, endTurnAt: string, installedNames: readonly string[]): { involved: boolean; names: string[] } {
    const workdir = this.#workdirOf(sessionId)
    const installed = new Set(installedNames)
    const involved = new Set<string>()
    const ledger = this.#ledger(workdir)
    for (const row of this.#projectRows(workdir)) {
      for (const m of WriteLedger.since(ledger.get(row.id, "follow"), row.messages)) {
        collectInvolvedNames(m, installed, involved)
      }
    }
    if (involved.size === 0) return { involved: false, names: [] } // 不排检查、不动增量进度、零 LLM
    this.#ledgerForWrite(workdir).scheduleFollowCheck(sessionId, endTurnAt)
    return { involved: true, names: [...involved] }
  }

  pendingFollowChecks(workdir: string): FollowCheck[] {
    return this.#ledger(workdir).pendingFollowChecks()
  }

  clearFollowCheck(workdir: string, sessionId: string): void {
    const path = this.#ledgerPath(workdir)
    if (!existsSync(path)) return // 幂等：无账本不因清理而建文件
    this.#ledger(workdir).clearFollowCheck(sessionId)
  }

  lastActivity(workdir: string): string {
    let max = ""
    for (const m of this.#sessions.list()) {
      if ((m.workdir ?? "") === workdir && m.updatedAt > max) max = m.updatedAt
    }
    return max
  }

  // ---- SkillEvolutionTriggers ----------------------------------------------

  async triggerFollow(workdir: string, sessionId: string): Promise<void> {
    const ledger = this.#ledger(workdir)
    let failed = false
    for (const row of this.#projectRows(workdir)) {
      const range = WriteLedger.since(ledger.get(row.id, "follow"), row.messages)
      if (range.length === 0) continue
      let raw: string
      try {
        const { llm, model } = this.#resolveLlm()
        raw = await collectStreamText(llm, {
          model,
          system: SKILL_EXTRACT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: renderSegment(range) }],
          tools: [],
        })
      } catch (err) {
        this.#log(`kclaw skills extract failed for ${row.id} (watermark not advanced): ${String(err)}`)
        failed = true
        continue
      }
      for (const fields of this.#parseProposalItems(raw, workdir)) {
        const p = this.#store.create({ ...fields, source: "follow", sourceSessionId: sessionId })
        this.#audit({ op: "proposed", kind: p.kind, name: p.name, scope: p.scope, source: "follow", sessionId })
      }
      // 拿到合法 JSON（无论 0 条还是 N 条）即推进——"判断没有值得提的"是正常结局。
      this.#ledgerForWrite(workdir).advance(row.id, "follow", range[range.length - 1]!.id)
    }
    if (failed) throw new Error("skill extraction failed for one or more session batches (watermarks kept for retry)")
  }

  propose(sessionId: string, input: { name: string; content: string; rationale?: string }): SkillProposalResult {
    if (!isSkillDirName(input.name)) {
      return { ok: false, error: `技能名不合法（小写字母/数字/连字符，≤64 字符）：${input.name}` }
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_CONTENT_BYTES) {
      return { ok: false, error: "content 超过 64KB 上限" }
    }
    const workdir = this.#workdirOf(sessionId)
    const projectDir = join(workdir, ".kclaw", "skills")
    // kind/scope 系统推导：项目副本命中 → project + 当前会话 workdir；仅全局
    // 命中 → global；未装 → new，一律 project（影响面小的方向）。
    const scope = existsSync(join(projectDir, input.name, "SKILL.md"))
      ? "project"
      : existsSync(join(this.#skillsDir, input.name, "SKILL.md"))
        ? "global"
        : undefined
    const scopeDir = scope === "project" ? projectDir : scope === "global" ? this.#skillsDir : undefined
    if (scopeDir !== undefined && linkedSkillNames(scopeDir).includes(input.name)) {
      return { ok: false, error: `目标是复用链接技能，由源目录维护：${input.name}`, conflict: true }
    }
    const kind = scope === undefined ? "new" : "revise"
    const p = this.#store.create({
      kind,
      name: input.name,
      scope: scope ?? "project",
      ...(scope === "project" || scope === undefined ? { workdir } : {}),
      title: input.name,
      rationale: input.rationale ?? "",
      content: input.content,
      // revise 带 baseline：审阅对照展示用（apply 时另行快照覆盖前的真实正文）
      ...(kind === "revise" ? { baseline: readFileSync(join(scopeDir!, input.name, "SKILL.md"), "utf8") } : {}),
      source: "skill_create",
      sourceSessionId: sessionId,
    })
    this.#audit({ op: "proposed", kind, name: p.name, scope: p.scope, source: "skill_create", sessionId })
    return { ok: true, proposal: p }
  }

  // ---- SkillEvolutionAdmin --------------------------------------------------

  listProposals(): SkillProposal[] {
    return this.#store.list()
  }

  getProposal(id: string): SkillProposal | undefined {
    return this.#store.get(id)
  }

  proposalUsage(id: string): number {
    const p = this.#store.get(id)
    if (p === undefined || p.appliedAt === undefined) return 0
    const since = Date.parse(p.appliedAt)
    let count = 0
    for (const meta of this.#sessions.list()) {
      for (const m of this.#sessions.readMessages(meta.id)) {
        if (m.role !== "assistant" || Date.parse(m.createdAt) < since) continue
        for (const b of m.blocks) {
          if (b.type !== "tool_call" || b.name !== "skill_read") continue
          const arg = (b.args ?? {}) as { name?: unknown }
          if (arg.name === p.name) count += 1
        }
      }
    }
    return count
  }

  applyProposal(id: string): SkillProposalResult {
    const p = this.#store.get(id)
    if (p === undefined) return { ok: false, error: "提案不存在" }
    // 遮蔽检查候选：daemon 已知的全部项目技能目录（项目副本整目录覆盖全局）。
    const shadowDirs = p.scope === "global"
      ? [...new Set(this.#sessions.list().map((m) => m.workdir).filter((w): w is string => typeof w === "string" && w !== ""))].map((w) => join(w, ".kclaw", "skills"))
      : []
    const r = this.#store.apply(id, { at: this.#nowISO(), shadowDirs })
    if (r.ok) this.#adminAudit(r.proposal, "applied")
    return r
  }

  rejectProposal(id: string): SkillProposalResult {
    const r = this.#store.reject(id, { at: this.#nowISO() })
    if (r.ok) this.#adminAudit(r.proposal, "rejected")
    return r
  }

  revertProposal(id: string): SkillProposalResult {
    const r = this.#store.revert(id, { at: this.#nowISO() })
    if (r.ok) this.#adminAudit(r.proposal, "reverted")
    return r
  }

  removeProposal(id: string): SkillProposalResult {
    const p = this.#store.get(id)
    const r = this.#store.remove(id)
    if (r.ok && p !== undefined) this.#adminAudit(p, "deleted")
    return r
  }

  // ---- 内部 ---------------------------------------------------------------

  /** skill 审计事件：归属会话缺失即跳过（不落事件、不建幻影会话，照 memory 先例）。 */
  #audit(e: Omit<SkillEvent, "type" | "at"> & { at?: string; sessionId?: string }): void {
    const id = e.sessionId
    if (id === undefined) return
    if (this.#sessions.meta(id) === undefined) return
    const { sessionId: _sid, at, ...rest } = e
    this.#sessions.appendEvent(id, { type: "skill", at: at ?? this.#nowISO(), ...rest } as SkillEvent)
  }

  /** admin 治理动作的归属：project → 该 workdir 最近活动会话；global → 最近全局会话；无会话跳过。 */
  #adminAudit(p: SkillProposal, op: "applied" | "rejected" | "reverted" | "deleted"): void {
    const sessionId = p.scope === "project" ? this.#recentSessionId(p.workdir ?? "") : this.#recentGlobalSessionId()
    this.#audit({ op, kind: p.kind, name: p.name, scope: p.scope, source: "admin", sessionId })
  }

  /**
   * 提炼 JSON 解析与逐条校验（照 memory #extract 的逐条容错）：cap 3、
   * kind/name/content 非法丢弃、scope 非法回退 project、revise 目标不存在
   * 或是复用链接技能丢弃（丢弃只影响该条，其余照常）。
   */
  #parseProposalItems(raw: string, workdir: string): Array<Omit<SkillProposal, "id" | "status" | "createdAt" | "source" | "sourceSessionId">> {
    let text = raw.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
    if (fenced !== null) text = fenced[1]!.trim()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      // JSON 不可解析按放弃处理并推进（照记忆的既有取舍）：重试同一批
      // 大概率得到同样不可解析的输出，安静结束优于无限重试。
      this.#log("kclaw skills extract: unparseable response, batch abandoned")
      return []
    }
    const items = (parsed as { proposals?: unknown }).proposals
    if (!Array.isArray(items)) {
      this.#log("kclaw skills extract: response has no proposals array")
      return []
    }
    const capped = items.slice(0, MAX_PROPOSALS_PER_BATCH)
    if (items.length > capped.length) this.#log(`kclaw skills extract: proposals capped ${capped.length}/${items.length}`)
    const projectDir = join(workdir, ".kclaw", "skills")
    const out: Array<Omit<SkillProposal, "id" | "status" | "createdAt" | "source" | "sourceSessionId">> = []
    for (const item of capped) {
      if (typeof item !== "object" || item === null) { this.#log("kclaw skills extract: dropping malformed proposal"); continue }
      const x = item as Record<string, unknown>
      const kind = x.kind === "new" || x.kind === "revise" ? x.kind : undefined
      const name = typeof x.name === "string" ? x.name : ""
      const content = typeof x.content === "string" ? x.content : ""
      if (kind === undefined || !isSkillDirName(name) || content === "") {
        this.#log(`kclaw skills extract: dropping malformed proposal (kind=${String(x.kind)} name=${name})`)
        continue
      }
      const scope = x.scope === "global" || x.scope === "project" ? x.scope : "project" // 回退影响面小的方向
      const scopeDir = scope === "global" ? this.#skillsDir : projectDir
      if (kind === "revise") {
        const target = join(scopeDir, name, "SKILL.md")
        if (!existsSync(target)) { this.#log(`kclaw skills extract: revise target missing: ${name}`); continue }
        if (linkedSkillNames(scopeDir).includes(name)) { this.#log(`kclaw skills extract: revise target is a reuse link: ${name}`); continue }
      }
      out.push({
        kind, name, scope,
        ...(scope === "project" ? { workdir } : {}),
        title: typeof x.title === "string" && x.title !== "" ? x.title : name,
        rationale: typeof x.rationale === "string" ? x.rationale : "",
        ...(typeof x.changes === "string" && x.changes !== "" ? { changes: x.changes } : {}),
        content,
        ...(kind === "revise" ? { baseline: readFileSync(join(scopeDir, name, "SKILL.md"), "utf8") } : {}),
      })
    }
    return out
  }
}

/**
 * 卷入判定（纯读）：assistant 消息的 skill_read/skill_list 工具调用块，或
 * user 消息文本里命中已装技能名的 /记号。/记号 正则与 matchSkillInvocations
 * 同源，但匹配集合是全部已装技能名——那边按 user-invocable 档位过滤（渐进
 * 披露的用户面口径），观察面刻意更宽：user-invocable:false 的技能被点名
 * 同样是"卷入"。
 */
function collectInvolvedNames(m: Message, installed: ReadonlySet<string>, out: Set<string>): void {
  if (m.role === "assistant") {
    for (const b of m.blocks) {
      if (b.type !== "tool_call") continue
      if (b.name !== "skill_read" && b.name !== "skill_list") continue
      const arg = (b.args ?? {}) as { name?: unknown }
      out.add(typeof arg.name === "string" && installed.has(arg.name) ? arg.name : `[${b.name}]`)
    }
  } else if (m.role === "user") {
    for (const b of m.blocks) {
      if (b.type !== "text" || typeof b.text !== "string") continue
      for (const match of b.text.matchAll(/(?<![A-Za-z0-9])\/([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
        const name = match[1]!
        if (installed.has(name)) out.add(name)
      }
    }
  }
}
