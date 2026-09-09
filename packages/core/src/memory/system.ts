import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { estimateTokens } from "../session/compaction.js"
import type { KclawConfig } from "../storage/config.js"
import { writeFileAtomic } from "../storage/atomic.js"
import type { LlmClient } from "../provider/types.js"
import type { SessionStore } from "../session/store.js"
import { MemoryLayout, projectIdFor } from "./layout.js"
import { WriteLedger } from "./ledger.js"
import { MemoryPipeline, type MemoryAudit } from "./pipeline.js"
import type { MemoryWrittenEvent } from "./pipeline.js"
import type { MemoryEvent } from "../session/events.js"
import { parseThreadFile, parseMemoryMd } from "./threads.js"
import { parseCognitionFile, cognitionPath, writeCognitionFile } from "./cognition.js"
import type { CogKind } from "./cognition.js"
import type { VectorIndex } from "./indexer.js"
import { normalizeFtsRank, fusedScore, recencyFactor } from "./scoring.js"
import type { EmbeddingClient } from "./embeddings.js"
import { cosine } from "./embeddings.js"

export interface EpisodeHit { topic: string; title: string; date: string; text: string; score: number }
export interface MemorySearchHit { kind: "episode" | "cognition"; scope: string; label: string; text: string }
export interface MemoryProjectInfo { id: string; workdir: string; threads: number; lastActivity: string }
export interface CognitionFileInfo { kind: "persona" | "wiki" | "rule"; name: string; path: string; scope: string; updated: string }

/**
 * 消费者窄接口：MemorySystem 的 30 个方法按四拨消费方分面。类不拆、
 * 公共 API 不删改——接口只是每个消费方该看到的方法子集，调用方按面声明依赖，
 * 编译器挡住越界使用（如路由碰触发器、调度器碰管理面）。
 */

/** 检索面：内置钩子（记忆注入 / 系统提示词材料）与 memory_search 工具消费。 */
export interface MemoryQuery {
  cognitionPrompt(workdir: string): string
  searchEpisodes(workdir: string, query: string, limit?: number): Promise<EpisodeHit[]>
  searchAll(query: string, limit?: number): Promise<MemorySearchHit[]>
}

/** 触发面：记忆写入触发（memory_save 工具 + 调度器 + 手动内化）。 */
export interface MemoryTriggers {
  triggerImmediate(sessionId: string): Promise<boolean>
  triggerManual(workdir: string, sessionId?: string): Promise<void>
  triggerClear(workdir: string, sessionId?: string): Promise<void>
  triggerInterval(workdir: string): Promise<void>
  triggerFollow(workdir: string, sessionId?: string): Promise<void>
  triggerNightly(workdir: string, sessionId?: string): Promise<void>
  consolidate(workdir: string, topic: string): Promise<void>
  recentSessionId(workdir: string): string | undefined
}

/** 调度簿记面：memory-scheduler 判节拍、跟随门禁、夜间防重跑。 */
export interface MemoryScheduleBook {
  markIntervalRun(workdir: string, iso: string): void
  intervalLastRun(workdir: string): string | undefined
  markNightlyRun(workdir: string, localDate: string): void
  nightlyLastRun(workdir: string): string | undefined
  scheduleFollowCheck(sessionId: string, endTurnAt: string): void
  clearFollowCheck(workdir: string, sessionId: string): void
  pendingFollowChecks(workdir: string): Array<{ sessionId: string; endTurnAt: string }>
  lastActivity(workdir: string): string
}

/** 管理面：网页记忆页路由（列表、线程/认知的读与人工覆写、对账）。 */
export interface MemoryAdmin {
  reconcile(): void
  projects(): MemoryProjectInfo[]
  projectThreads(projectId: string): Array<{ topic: string; title: string; status: string; updated: string }>
  threadContent(projectId: string, topic: string): string | undefined
  writeThread(projectId: string, topic: string, content: string): void
  deleteThread(projectId: string, topic: string): void
  globalFiles(): CognitionFileInfo[]
  cognitionContent(kind: CogKind, name: string): string | undefined
  writeCognition(kind: CogKind, name: string, content: string): void
  deleteCognition(kind: CogKind, name: string): void
}

/** 超预算保留优先级：规则漏了会出错 > 画像缺一段 > wiki 少一块。 */
const L2_PRIORITY: Array<CogKind> = ["rule", "persona", "wiki"]
const FTS_RECALL = 50

function readFileSafe(path: string): string | undefined {
  try { return readFileSync(path, "utf8") } catch { return undefined }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch { return [] }
}

function todayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** 解析 v1 记忆 note（yaml frontmatter + 正文）；非 note 文件返回 undefined。 */
function parseV1Note(content: string): { text: string } | undefined {
  const lines = content.split("\n")
  if (lines[0] !== "---") return undefined
  const end = lines.indexOf("---", 1)
  if (end === -1) return undefined
  try { parse(lines.slice(1, end).join("\n")) } catch { return undefined }
  const text = lines.slice(end + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
  return { text }
}

interface CogFile { kind: CogKind; name: string; title: string; body: string; scope: string }

interface ScoredHit { key: string; topic: string; title: string; date: string; text: string; score: number }

/**
 * MemorySystem —— 记忆系统的唯一 server 侧门面。装配 L1 情节管线 + L2 认知库，
 * 方法面按四拨消费方分面（MemoryQuery / MemoryTriggers / MemoryScheduleBook /
 * MemoryAdmin，卡⑤）；对账迁移（reconcile / migrateV1Notes）与停机（stop）只归 daemon。
 */
export class MemorySystem implements MemoryQuery, MemoryTriggers, MemoryScheduleBook, MemoryAdmin {
  readonly #layout: MemoryLayout
  readonly #sessions: SessionStore
  readonly #config: KclawConfig
  readonly #resolveLlm: () => { llm: LlmClient; model: string }
  readonly #embed?: EmbeddingClient
  readonly #emit?: (e: MemoryWrittenEvent) => void
  readonly #log: (m: string) => void
  readonly #now: () => Date
  /** 记忆落盘通知：接成会话事件流 appendEvent；sessionId 缺失时跳过（无处可挂）。 */
  readonly #audit: (e: MemoryAudit) => void
  readonly #pipeline: MemoryPipeline

  constructor(opts: {
    memoryDir: string
    sessions: SessionStore
    config: KclawConfig
    /** 每次触发时解析提取模型用的 llm 与 model（回落主模型）。 */
    resolveLlm: () => { llm: LlmClient; model: string }
    /** embedding 客户端（判定链通过时由装配方构造注入；缺省 = 向量路关闭）。 */
    embed?: EmbeddingClient
    emit?: (e: MemoryWrittenEvent) => void
    log?: (msg: string) => void
    now?: () => Date
  }) {
    this.#layout = new MemoryLayout(opts.memoryDir)
    this.#sessions = opts.sessions
    this.#config = opts.config
    this.#resolveLlm = opts.resolveLlm
    this.#embed = opts.embed
    this.#emit = opts.emit
    this.#log = opts.log ?? ((m) => console.error(m))
    this.#now = opts.now ?? (() => new Date())
    this.#audit = (e) => {
      const id = e.sessionId
      if (id === undefined) return // 无归属会话：跳过（admin/手动内化在无会话项目上不落事件）
      if (this.#sessions.meta(id) === undefined) return // 归属会话不存在：跳过（不落事件、不建幻影会话）
      const { sessionId: _sid, at, ...rest } = e
      // 事件体不携带 sessionId（Ruling 5：由所在会话目录决定）
      this.#sessions.appendEvent(id, { type: "memory", at: at ?? this.#now().toISOString(), ...rest } as MemoryEvent)
    }
    this.#pipeline = new MemoryPipeline(opts.memoryDir, opts.sessions, {
      resolveLlm: () => {
        // extractModel 回落主模型的解析集中在这里，resolveLlm 只调一次
        const { llm, model } = this.#resolveLlm()
        return { llm, model: this.#config.memory.extractModel || model }
      },
      embed: opts.embed, emit: opts.emit, audit: this.#audit, log: this.#log, now: this.#now,
      threadInactiveDays: opts.config.memory.threadInactiveDays,
      consolidateEnabled: opts.config.memory.consolidate,
    })
  }

  // ---- 注入与检索（run.ts 消费） ----

  /**
   * L2 常驻注入：scope 过滤（global + 当前项目）+ token 预算 +
   * rule>persona>wiki 整文件取舍（装不下整文件跳过并 log，不截断）；空认知/异常返回 ""。
   * 块序：[关于用户] → [项目认知] → [通用规则]。
   */
  cognitionPrompt(workdir: string): string {
    try {
      const projectId = projectIdFor(workdir)
      const budget = this.#config.memory.injectTokenBudget
      const globalDir = this.#layout.globalDir
      const files: CogFile[] = []
      const addFile = (path: string, kind: CogKind, name: string): void => {
        const raw = readFileSafe(path)
        if (raw === undefined) return
        const cf = parseCognitionFile(raw, kind, name)
        if (cf === undefined) return
        if (cf.scope !== "global" && cf.scope !== `project:${projectId}`) return
        files.push({ kind, name, title: cf.title, body: cf.body, scope: cf.scope })
      }
      addFile(join(globalDir, "persona.md"), "persona", "persona")
      for (const f of readDirSafe(join(globalDir, "wiki"))) if (f.endsWith(".md")) addFile(join(globalDir, "wiki", f), "wiki", f.slice(0, -3))
      for (const f of readDirSafe(join(globalDir, "rule"))) if (f.endsWith(".md")) addFile(join(globalDir, "rule", f), "rule", f.slice(0, -3))
      if (files.length === 0) return ""

      // 预算取舍：按 rule > persona > wiki 优先级逐文件记账，超预算整文件跳过
      const kept: CogFile[] = []
      let used = 0
      for (const kind of L2_PRIORITY) {
        const group = files.filter((f) => f.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
        for (const f of group) {
          const tokens = estimateTokens(`${f.title}\n${f.body}`)
          if (used + tokens > budget) {
            this.#log(`kclaw memory cognition skipped (over inject budget): ${f.kind}/${f.name}`)
            continue
          }
          used += tokens
          kept.push(f)
        }
      }

      // 块序固定：[关于用户] → [项目认知] → [通用规则]
      const renderBlock = (block: string, group: CogFile[]): string => {
        if (group.length === 0) return ""
        return `${block}\n\n${group.map((f) => `## ${f.title}\n\n${f.body}`).join("\n\n")}`
      }
      const parts: string[] = []
      const persona = renderBlock("[关于用户]", kept.filter((f) => f.kind === "persona"))
      const project = renderBlock("[项目认知]", kept.filter((f) => f.scope.startsWith("project:")))
      const globalRuleWiki = renderBlock("[通用规则]", kept.filter((f) => f.kind !== "persona" && f.scope === "global"))
      if (persona !== "") parts.push(persona)
      if (project !== "") parts.push(project)
      if (globalRuleWiki !== "") parts.push(globalRuleWiki)
      return parts.join("\n\n")
    } catch (err) {
      this.#log(`kclaw memory cognition prompt failed: ${String(err)}`)
      return ""
    }
  }

  /**
   * 混合打分：FTS 归一化 + 向量余弦（#embed 存在时）融合（0.5/0.5），
   * 乘时效因子，按分降序取 limit；单边缺失降级，全部不抛错。
   */
  async #scoreIndex(idx: VectorIndex, query: string, limit: number, now: Date): Promise<ScoredHit[]> {
    const ftsHits = idx.searchFts(query, FTS_RECALL)
    if (ftsHits.length === 0) return []
    let queryVec: Float32Array | undefined
    if (this.#embed !== undefined) {
      try { queryVec = (await this.#embed.embed([query]))[0] } catch (err) { this.#log(`kclaw memory embed query failed: ${String(err)}`) }
    }
    const scored: ScoredHit[] = []
    for (const { key, rank } of ftsHits) {
      const meta = idx.metaOf(key)
      if (meta === undefined) continue
      const fts = normalizeFtsRank(rank)
      let vec: number | undefined
      if (queryVec !== undefined) {
        const v = idx.vectorOf(key)
        vec = v === undefined ? undefined : cosine(queryVec, v)
      }
      const fused = fusedScore(fts, vec)
      const score = fused * recencyFactor(meta.date ?? "", now)
      scored.push({ key, topic: meta.topic ?? "", title: meta.title ?? "", date: meta.date ?? "", text: meta.text ?? "", score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** 情节正文从线文件回读（文件是真相）；找不到则退回索引正文。 */
  #readEpisodeText(projectId: string, topic: string, date: string, fallback: string): string {
    if (topic === "") return fallback
    const raw = readFileSafe(join(this.#layout.projectDir(projectId), `${topic}.md`))
    if (raw === undefined) return fallback
    const tf = parseThreadFile(raw)
    if (tf === undefined) return fallback
    const byDate = tf.sections.filter((s) => s.date === date)
    if (byDate.length === 0) return fallback
    return byDate.find((s) => s.body === fallback)?.body ?? byDate[0]!.body
  }

  /** L1 混合检索：当前项目情节 top-N，正文从线文件回读；注入格式由调用方拼。 */
  async searchEpisodes(workdir: string, query: string, limit = 5): Promise<EpisodeHit[]> {
    const { id } = this.#layout.resolveProject(workdir)
    if (!existsSync(this.#layout.projectDir(id))) return [] // 项目尚无记忆：不建目录
    try { this.#pipeline.reindexProject(id) } catch (err) { this.#log(`kclaw memory search: project index refresh failed: ${String(err)}`) }
    const hits = await this.#scoreIndex(this.#pipeline.indexFor(id), query, limit, this.#now())
    return hits.map((h) => ({
      topic: h.topic, title: h.title, date: h.date,
      text: this.#readEpisodeText(id, h.topic, h.date, h.text),
      score: h.score,
    }))
  }

  /** 认知正文与 scope 从文件回读（文件是真相）。 */
  #readCognition(kind: CogKind, name: string, fallback: string): { text: string; scope: string } {
    const raw = readFileSafe(cognitionPath(this.#layout.globalDir, kind, name))
    if (raw === undefined) return { text: fallback, scope: "global" }
    const cf = parseCognitionFile(raw, kind, name)
    if (cf === undefined) return { text: fallback, scope: "global" }
    return { text: cf.body, scope: cf.scope }
  }

  /** memory_search 工具：跨全部项目库 + 全局库，带 [经历]/[认知] 与 [project:x]/[global] 标注。 */
  async searchAll(query: string, limit = 5): Promise<MemorySearchHit[]> {
    const now = this.#now()
    const scored: Array<{ score: number; hit: MemorySearchHit }> = []
    for (const id of this.#layout.listProjectIds()) {
      try {
        this.#pipeline.reindexProject(id)
        const hits = await this.#scoreIndex(this.#pipeline.indexFor(id), query, FTS_RECALL, now)
        for (const h of hits) {
          scored.push({ score: h.score, hit: {
            kind: "episode", scope: `project:${id}`,
            label: `[经历] ${h.title} [project:${id}]`,
            text: this.#readEpisodeText(id, h.topic, h.date, h.text),
          } })
        }
      } catch (err) {
        this.#log(`kclaw memory search: project ${id} skipped: ${String(err)}`)
      }
    }
    try {
      await this.#pipeline.reindexGlobal()
      const hits = await this.#scoreIndex(this.#pipeline.globalIndex(), query, FTS_RECALL, now)
      for (const h of hits) {
        const slash = h.key.indexOf("/")
        if (slash === -1) continue
        const kind = h.key.slice(0, slash) as CogKind
        const name = h.key.slice(slash + 1)
        const { text, scope } = this.#readCognition(kind, name, h.text)
        scored.push({ score: h.score, hit: { kind: "cognition", scope, label: `[认知] ${h.title} [${scope}]`, text } })
      }
    } catch (err) {
      this.#log(`kclaw memory search: global skipped: ${String(err)}`)
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((x) => x.hit)
  }

  // ---- 触发入口（工具/调度器消费） ----

  /** 项目最近活动会话（interval/admin-threads 无显式归属时的回落目标）；子会话（subagent）不参与回落。 */
  #recentSessionId(workdir: string): string | undefined {
    return this.#sessions.list().filter((m) => (m.workdir ?? "") === workdir && m.parentSessionId === undefined)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0]?.id
  }

  /** 全局最近活动会话（global 认知 admin 事件归属）；子会话同样不参与。 */
  #recentGlobalSessionId(): string | undefined {
    return this.#sessions.list().find((m) => m.parentSessionId === undefined)?.id
  }

  /** 立刻写入（memory_save 工具）：增量提取自最近水位的消息（水位推进两路）。
   *  返回是否真的执行了提取（false = 该会话无增量），工具据此给不误导的回复。 */
  async triggerImmediate(sessionId: string): Promise<boolean> {
    const meta = this.#sessions.meta(sessionId)
    const workdir = meta?.workdir ?? this.#config.workspace
    return (await this.#pipeline.runTrigger(workdir, "immediate", sessionId)) > 0
  }

  /** 手动写入（/memory save）：默认当前项目。 */
  async triggerManual(workdir: string, sessionId?: string): Promise<void> {
    await this.#pipeline.runTrigger(workdir, "manual", sessionId ?? this.#recentSessionId(workdir))
  }

  /** 切会话写入（/clear、/new 与新建会话入口共用 POST /sessions 时触发）：增量提取自最近水位的消息。 */
  async triggerClear(workdir: string, sessionId?: string): Promise<void> {
    await this.#pipeline.runTrigger(workdir, "clear", sessionId ?? this.#recentSessionId(workdir))
  }

  /** 项目维度最近活动会话（POST /sessions 建 new 会话前取旧会话作归属用）。 */
  recentSessionId(workdir: string): string | undefined {
    return this.#recentSessionId(workdir)
  }

  /** 手动内化。 */
  async consolidate(workdir: string, topic: string): Promise<void> {
    await this.#pipeline.consolidate(workdir, topic)
  }

  // ---- 定时/跟随触发与跟随门禁（scheduler / run.ts 消费） ----

  /** 定时触发（scheduler interval 兜底）：无显式归属会话，pipeline 对
   *  该项目全部会话逐个补增量（每会话各一本水位，谁的增量归谁的批次）。 */
  async triggerInterval(workdir: string): Promise<void> {
    await this.#pipeline.runTrigger(workdir, "interval")
  }

  /** 跟随触发（scheduler 对挂起检查补查）。 */
  async triggerFollow(workdir: string, sessionId?: string): Promise<void> {
    await this.#pipeline.runTrigger(workdir, "follow", sessionId ?? this.#recentSessionId(workdir))
  }

  /** 夜间闲时内化（scheduler 每日 consolidateHour 触发）：对有新情节的线（含 active）逐条内化。 */
  async triggerNightly(workdir: string, sessionId?: string): Promise<void> {
    await this.#pipeline.runNightly(workdir, sessionId ?? this.#recentSessionId(workdir))
  }

  // ---- 调度簿记（scheduler 消费） ----

  /**
   * 账本唯一入口：state.json 的全部读写收口到这里，两条通道。
   * 每次现开现读（WriteLedger 写时整文件原子重写，长命实例会覆盖别人的
   * 写入）——禁止在调用间缓存实例。
   */
  /** 写通道：项目目录不存在则创建（写语义）。 */
  #ledgerForWrite(workdir: string): WriteLedger {
    const { dir } = this.#layout.ensureProject(workdir)
    return new WriteLedger(join(dir, "state.json"))
  }

  /** 读通道路径：解析项目目录但不创建（读语义）；文件存在性由调用方按各自语义处理。 */
  #ledgerPath(workdir: string): string {
    const { id } = this.#layout.resolveProject(workdir)
    return join(this.#layout.projectDir(id), "state.json")
  }

  /** 记录最近一次定时触发的墙钟时间（落 <projectDir>/state.json，scheduler 判节拍）。 */
  markIntervalRun(workdir: string, iso: string): void {
    this.#ledgerForWrite(workdir).setIntervalLastRun(iso)
  }

  /** 最近一次定时触发的墙钟时间；从未触发过 → undefined（scheduler 据此立刻首跑）。 */
  intervalLastRun(workdir: string): string | undefined {
    return new WriteLedger(this.#ledgerPath(workdir)).getIntervalLastRun()
  }

  /** 记录最近一次夜间内化触发的本地日期（落 <projectDir>/state.json，scheduler 防同日重跑）。 */
  markNightlyRun(workdir: string, localDate: string): void {
    this.#ledgerForWrite(workdir).setNightlyLastRun(localDate)
  }

  /** 最近一次夜间内化触发的本地日期；从未触发过 → undefined。 */
  nightlyLastRun(workdir: string): string | undefined {
    return new WriteLedger(this.#ledgerPath(workdir)).getNightlyLastRun()
  }

  /**
   * 跟随门禁挂起检查：run 收尾（任何 stopReason）时经 WriteLedger
   * 落盘 <projectDir>/state.json，daemon 重启后 scheduler 补查。
   */
  scheduleFollowCheck(sessionId: string, endTurnAt: string): void {
    const meta = this.#sessions.meta(sessionId)
    const workdir = meta?.workdir ?? this.#config.workspace
    this.#ledgerForWrite(workdir).scheduleFollowCheck(sessionId, endTurnAt)
  }

  /** 清除某项目的挂起检查（幂等：无账本/无该检查则无事可做——不因清理而建文件）。 */
  clearFollowCheck(workdir: string, sessionId: string): void {
    const path = this.#ledgerPath(workdir)
    if (!existsSync(path)) return
    new WriteLedger(path).clearFollowCheck(sessionId)
  }

  /** 某项目的全部挂起检查（含 daemon 重启恢复）。 */
  pendingFollowChecks(workdir: string): Array<{ sessionId: string; endTurnAt: string }> {
    const path = this.#ledgerPath(workdir)
    if (!existsSync(path)) return []
    return new WriteLedger(path).pendingFollowChecks()
  }

  /** 项目全部会话 meta 的最大 updatedAt（scheduler 判跟随门禁的"新活动"）。 */
  lastActivity(workdir: string): string {
    let max = ""
    for (const m of this.#sessions.list()) {
      if ((m.workdir ?? "") === workdir && m.updatedAt > max) max = m.updatedAt
    }
    return max
  }

  /**
   * 停机（daemon stop 序列调用）：索引连接的唯一所有者是 pipeline，这里只经
   * 它统一关闭（不再有第二份连接缓存）。
   */
  async stop(): Promise<void> {
    this.#pipeline.close()
  }

  // ---- 对账与迁移（daemon 消费） ----

  /** 全部项目库 + 全局库对账 + 向量补算；异常逐目录 log 跳过。 */
  reconcile(): void {
    for (const id of this.#layout.listProjectIds()) {
      try {
        this.#pipeline.reindexProject(id)
        void this.#pipeline.backfillProjectVectors(id).catch((err) => this.#log(`kclaw memory reconcile vectors: ${id} skipped: ${String(err)}`))
      } catch (err) {
        this.#log(`kclaw memory reconcile: project ${id} skipped: ${String(err)}`)
      }
    }
    try {
      void this.#pipeline.reindexGlobal().catch((err) => this.#log(`kclaw memory reconcile: global skipped: ${String(err)}`))
    } catch (err) {
      this.#log(`kclaw memory reconcile: global skipped: ${String(err)}`)
    }
  }

  /** 旧 notes 三路分流，幂等：偏好→persona、规则→rule/general、其余→wiki/misc；迁移后删 notes/。 */
  migrateV1Notes(notesDir: string): void {
    if (!existsSync(notesDir)) return
    const files = readDirSafe(notesDir).filter((f) => f.endsWith(".md"))
    // M-1：空 notes 目录（resolvePaths 恒建）不产生迁移日志噪音，直接返回。
    if (files.length === 0) return
    this.#log(`memory v1 migration: ${files.length} notes`)
    const globalDir = this.#layout.globalDir
    const today = todayOf(this.#now())
    const appendTo = (kind: CogKind, name: string, text: string): void => {
      // create 回调返回空 body：writeCognitionFile 对新建文件执行 mutate(create())，
      // append 分支统一在 mutate 里拼文本，避免首条重复
      writeCognitionFile(cognitionPath(globalDir, kind, name), kind, name,
        (cf) => ({ ...cf, body: `${cf.body}${cf.body === "" ? "" : "\n\n"}${text}`, updated: today }),
        () => ({ kind, name, title: name, scope: "global", created: today, updated: today, body: "" }))
    }
    for (const f of files) {
      const note = parseV1Note(readFileSafe(join(notesDir, f)) ?? "")
      if (note === undefined) {
        this.#log(`memory v1 migration: skipped unparseable note ${f}`)
        continue
      }
      if (/偏好|喜欢|希望/.test(note.text)) appendTo("persona", "persona", note.text)
      else if (/必须|不要|决定/.test(note.text)) appendTo("rule", "general", note.text)
      else appendTo("wiki", "misc", note.text)
    }
    // v1 只写 .md，但目录里若有其它对象会随 rmSync 一并删除——补一条警告，不无痕消失（M-5）。
    for (const e of readdirSync(notesDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) continue
      this.#log(`memory v1 migration: skipping non-md ${e.name}`)
    }
    rmSync(notesDir, { recursive: true, force: true })
  }

  // ---- 管理界面（routes/web/cli 消费） ----

  projects(): MemoryProjectInfo[] {
    const out: MemoryProjectInfo[] = []
    for (const id of this.#layout.listProjectIds()) {
      const dir = this.#layout.projectDir(id)
      let threads = 0
      let last = ""
      for (const f of readDirSafe(dir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md")) {
        const tf = parseThreadFile(readFileSafe(join(dir, f)) ?? "")
        if (tf === undefined) continue
        threads += 1
        if (tf.updated > last) last = tf.updated
      }
      out.push({ id, workdir: this.#layout.workdirOf(id) ?? "", threads, lastActivity: last })
    }
    return out
  }

  projectThreads(projectId: string): Array<{ topic: string; title: string; status: string; updated: string }> {
    const dir = this.#layout.projectDir(projectId)
    if (!existsSync(dir)) return [] // 项目不存在：不建目录，返回空（调用方按 404 处理）
    const memoryMd = join(dir, "MEMORY.md")
    if (!existsSync(memoryMd)) this.#pipeline.rebuildMemoryMd(projectId)
    const raw = readFileSafe(memoryMd)
    return raw === undefined ? [] : parseMemoryMd(raw)
  }

  threadContent(projectId: string, topic: string): string | undefined {
    const raw = readFileSafe(join(this.#layout.projectDir(projectId), `${topic}.md`))
    if (raw === undefined) return undefined
    return parseThreadFile(raw) === undefined ? undefined : raw
  }

  /** 人工整文件覆写入口：直接原子写（人即是真相），写后 reindex + MEMORY.md 重建。 */
  writeThread(projectId: string, topic: string, content: string): void {
    writeFileAtomic(join(this.#layout.projectDir(projectId), `${topic}.md`), content)
    this.#pipeline.reindexProject(projectId)
    this.#pipeline.rebuildMemoryMd(projectId)
    this.#audit({ trigger: "admin", kind: "episode", op: "overwrite", topic, sessionId: this.#recentSessionId(this.#layout.workdirOf(projectId) ?? "") })
  }

  /** 删线文件 + 重建索引与 MEMORY.md。 */
  deleteThread(projectId: string, topic: string): void {
    rmSync(join(this.#layout.projectDir(projectId), `${topic}.md`), { force: true })
    this.#pipeline.reindexProject(projectId)
    this.#pipeline.rebuildMemoryMd(projectId)
    this.#audit({ trigger: "admin", kind: "episode", op: "delete", topic, sessionId: this.#recentSessionId(this.#layout.workdirOf(projectId) ?? "") })
  }

  globalFiles(): CognitionFileInfo[] {
    const out: CognitionFileInfo[] = []
    const globalDir = this.#layout.globalDir
    const add = (path: string, kind: CogKind, name: string): void => {
      const raw = readFileSafe(path)
      if (raw === undefined) return
      const cf = parseCognitionFile(raw, kind, name)
      if (cf === undefined) return
      out.push({ kind, name, path, scope: cf.scope, updated: cf.updated })
    }
    add(join(globalDir, "persona.md"), "persona", "persona")
    for (const f of readDirSafe(join(globalDir, "wiki"))) if (f.endsWith(".md")) add(join(globalDir, "wiki", f), "wiki", f.slice(0, -3))
    for (const f of readDirSafe(join(globalDir, "rule"))) if (f.endsWith(".md")) add(join(globalDir, "rule", f), "rule", f.slice(0, -3))
    return out
  }

  cognitionContent(kind: CogKind, name: string): string | undefined {
    const raw = readFileSafe(cognitionPath(this.#layout.globalDir, kind, name))
    if (raw === undefined) return undefined
    return parseCognitionFile(raw, kind, name) === undefined ? undefined : raw
  }

  writeCognition(kind: CogKind, name: string, content: string): void {
    const today = todayOf(this.#now())
    writeCognitionFile(cognitionPath(this.#layout.globalDir, kind, name), kind, name,
      (cf) => ({ ...cf, body: content, updated: today }),
      () => ({ kind, name, title: name, scope: "global", created: today, updated: today, body: content }))
    // 与 writeThread 对齐：写后立即重建全局索引，检索无需等下次对账。
    void this.#pipeline.reindexGlobal().catch((err) => this.#log(`kclaw memory writeCognition reindex failed: ${String(err)}`))
    this.#audit({ trigger: "admin", kind: "cognition", op: "overwrite", file: `${kind}/${name}`, sessionId: this.#recentGlobalSessionId() })
  }

  deleteCognition(kind: CogKind, name: string): void {
    rmSync(cognitionPath(this.#layout.globalDir, kind, name), { force: true })
    void this.#pipeline.reindexGlobal().catch((err) => this.#log(`kclaw memory deleteCognition reindex failed: ${String(err)}`))
    this.#audit({ trigger: "admin", kind: "cognition", op: "delete", file: `${kind}/${name}`, sessionId: this.#recentGlobalSessionId() })
  }
}
