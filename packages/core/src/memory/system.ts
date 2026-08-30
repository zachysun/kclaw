import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { estimateTokens } from "../session/compaction.js"
import type { KclawConfig } from "../storage/config.js"
import { writeFileAtomic } from "../storage/atomic.js"
import type { LlmClient } from "../provider/types.js"
import type { SessionStore } from "../session/store.js"
import { MemoryLayout, projectIdFor } from "./layout.js"
import { MemoryPipeline } from "./pipeline.js"
import type { MemoryWrittenEvent } from "./pipeline.js"
import { parseThreadFile, parseMemoryMd } from "./threads.js"
import { parseCognitionFile, cognitionPath, writeCognitionFile } from "./cognition.js"
import type { CogKind } from "./cognition.js"
import { VectorIndex } from "./indexer.js"
import { normalizeFtsRank, fusedScore, recencyFactor } from "./scoring.js"
import type { EmbeddingClient } from "./embeddings.js"
import { cosine } from "./embeddings.js"

export interface EpisodeHit { topic: string; title: string; date: string; text: string; score: number }
export interface MemorySearchHit { kind: "episode" | "cognition"; scope: string; label: string; text: string }
export interface MemoryProjectInfo { id: string; workdir: string; threads: number; lastActivity: string }
export interface CognitionFileInfo { kind: "persona" | "wiki" | "rule"; name: string; path: string; scope: string; updated: string }

/** 超预算保留优先级（spec 7.1）：规则漏了会出错 > 画像缺一段 > wiki 少一块。 */
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
 * MemorySystem —— 记忆系统 v2 的唯一 server 侧门面。装配 L1 情节管线 + L2 认知库，
 * 暴露注入（cognitionPrompt / searchEpisodes）、触发（trigger 系列 / consolidate）、
 * 对账迁移（reconcile / migrateV1Notes）与管理（projects / threads / global 文件读写删）四组接口。
 */
export class MemorySystem {
  readonly #layout: MemoryLayout
  readonly #sessions: SessionStore
  readonly #config: KclawConfig
  readonly #resolveLlm: () => { llm: LlmClient; model: string }
  readonly #embed?: EmbeddingClient
  readonly #emit?: (e: MemoryWrittenEvent) => void
  readonly #log: (m: string) => void
  readonly #now: () => Date
  readonly #pipeline: MemoryPipeline
  /** 检索用全局认知索引（写入侧重建在 pipeline；检索前先对账保证"文件是真相"）。 */
  readonly #globalIndex: VectorIndex
  readonly #projectIndexes = new Map<string, VectorIndex>()

  constructor(opts: {
    memoryDir: string
    sessions: SessionStore
    config: KclawConfig
    /** 每次触发时解析提取模型用的 llm 与 model（回落主模型，spec 4.3）。 */
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
    this.#globalIndex = new VectorIndex(join(this.#layout.globalDir, "vectors.db"))
    this.#pipeline = new MemoryPipeline(opts.memoryDir, opts.sessions, {
      resolveLlm: () => {
        // extractModel 回落主模型的解析集中在这里，resolveLlm 只调一次（spec 4.3）
        const { llm, model } = this.#resolveLlm()
        return { llm, model: this.#config.memory.extractModel || model }
      },
      embed: opts.embed, emit: opts.emit, log: this.#log, now: this.#now,
      threadInactiveDays: opts.config.memory.threadInactiveDays,
      consolidateEnabled: opts.config.memory.consolidate,
    })
  }

  #projectIndex(projectId: string): VectorIndex {
    let idx = this.#projectIndexes.get(projectId)
    if (idx === undefined) {
      idx = new VectorIndex(join(this.#layout.projectDir(projectId), "vectors.db"))
      this.#projectIndexes.set(projectId, idx)
    }
    return idx
  }

  // ---- 注入与检索（run.ts 消费） ----

  /**
   * L2 常驻注入（spec 7.1）：scope 过滤（global + 当前项目）+ token 预算 +
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

      // 预算取舍（spec 7.1）：按 rule > persona > wiki 优先级逐文件记账，超预算整文件跳过
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

      // 块序按 spec 7.1 的图：[关于用户] → [项目认知] → [通用规则]
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
   * 混合打分（spec 7.2）：FTS 归一化 + 向量余弦（#embed 存在时）融合（0.5/0.5），
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

  /** L1 混合检索（spec 7.2）：当前项目情节 top-N，正文从线文件回读；注入格式由调用方拼。 */
  async searchEpisodes(workdir: string, query: string, limit = 5): Promise<EpisodeHit[]> {
    const { id } = this.#layout.resolveProject(workdir)
    if (!existsSync(this.#layout.projectDir(id))) return [] // 项目尚无记忆：不建目录
    try { this.#pipeline.reindexProject(id) } catch (err) { this.#log(`kclaw memory search: project index refresh failed: ${String(err)}`) }
    const hits = await this.#scoreIndex(this.#projectIndex(id), query, limit, this.#now())
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
        const hits = await this.#scoreIndex(this.#projectIndex(id), query, FTS_RECALL, now)
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
      const hits = await this.#scoreIndex(this.#globalIndex, query, FTS_RECALL, now)
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

  /** 立刻写入（memory_save 工具，spec 7.3）：处理当前轮（水位推进两路）。 */
  async triggerImmediate(sessionId: string): Promise<void> {
    const meta = this.#sessions.meta(sessionId)
    const workdir = meta?.workdir ?? this.#config.workspace
    await this.#pipeline.runTrigger(workdir, "immediate")
  }

  /** 手动写入（/memory save，spec 4.2 手动行）：默认当前项目。 */
  async triggerManual(workdir: string): Promise<void> {
    await this.#pipeline.runTrigger(workdir, "manual")
  }

  /** 手动内化。 */
  async consolidate(workdir: string, topic: string): Promise<void> {
    await this.#pipeline.consolidate(workdir, topic)
  }

  // ---- 对账与迁移（daemon 消费） ----

  /** 全部项目库 + 全局库对账 + 向量补算（spec 2.5）；异常逐目录 log 跳过。 */
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

  /** 旧 notes 三路分流（spec 2.6），幂等：偏好→persona、规则→rule/general、其余→wiki/misc；迁移后删 notes/。 */
  migrateV1Notes(notesDir: string): void {
    if (!existsSync(notesDir)) return
    const files = readDirSafe(notesDir).filter((f) => f.endsWith(".md"))
    this.#log(`memory v1 migration: ${files.length} notes`)
    const globalDir = this.#layout.globalDir
    const today = todayOf(this.#now())
    const appendTo = (kind: CogKind, name: string, text: string): void => {
      // create 回调返回空 body：writeCognitionFile 对新建文件执行 mutate(create())，
      // append 分支统一在 mutate 里拼文本，避免首条重复（Task 9 同款修复）
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
  }

  /** 删线文件 + 重建索引与 MEMORY.md。 */
  deleteThread(projectId: string, topic: string): void {
    rmSync(join(this.#layout.projectDir(projectId), `${topic}.md`), { force: true })
    this.#pipeline.reindexProject(projectId)
    this.#pipeline.rebuildMemoryMd(projectId)
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
  }

  deleteCognition(kind: CogKind, name: string): void {
    rmSync(cognitionPath(this.#layout.globalDir, kind, name), { force: true })
    void this.#pipeline.reindexGlobal().catch((err) => this.#log(`kclaw memory deleteCognition reindex failed: ${String(err)}`))
  }
}
