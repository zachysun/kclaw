import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { LlmClient } from "../provider/types.js"
import { collectStreamText } from "../provider/collect.js"
import { renderSegment } from "../session/compaction.js"
import type { Message } from "../protocol/messages.js"
import type { SessionStore } from "../session/store.js"
import { MemoryLayout } from "./layout.js"
import { WriteLedger, type Watermark } from "./ledger.js"
import {
  parseThreadFile, renderMemoryMd, writeThreadFile, appendSection, updateSection,
  type ThreadFile,
} from "./threads.js"
import { VectorIndex, type IndexEntry } from "./indexer.js"
import type { EmbeddingClient } from "./embeddings.js"
import { writeCognitionFile, parseCognitionFile, cognitionPath, type CogKind } from "./cognition.js"
import { writeFileAtomic } from "../storage/atomic.js"

export type PipelineTrigger = "immediate" | "manual" | "interval" | "follow"

export interface ExtractAction {
  file: string                                   // 线文件名（不含 .md）
  op: "append" | "update" | "new-thread"
  section?: string                               // update 的小节短标题
  content: string                                // 情节正文（四要素列表）
  thread?: string                                // new-thread 的线名（kebab-case）
  status?: "active" | "inactive"                 // 提取判断的线收束（spec 5）
  title?: string                                 // new-thread 的人可读标题
}

export interface MemoryWrittenEvent {
  type: "memory.written"
  path: string
  kind: "episode" | "cognition"
  topic?: string
  scope?: string
}

export interface PipelineDeps {
  llm: LlmClient
  model: string                                  // 提取模型（已回落解析后的值）
  embed?: EmbeddingClient                        // 判定链通过时才传入；缺省 = 纯关键词
  emit?: (e: MemoryWrittenEvent) => void
  log?: (msg: string) => void                    // 缺省 console.error
  now?: () => Date
  /** 自动收束阈值（spec 5）：线最近活动距今超过该天数 → inactive；缺省 14。 */
  threadInactiveDays?: number
  /** 内化开关（spec 6）：缺省开；由 Task 10 的 system 从 config 传入。 */
  consolidateEnabled?: boolean
}

/** 提取器固定文案（spec 4.3，verbatim-pinned）。 */
const EXTRACT_SYSTEM_PROMPT = [
  "你是长期记忆的情节提取器。输入是一段会话消息（每行一条）与该项目已有的主题线清单（MEMORY.md 表格）。",
  "只输出 JSON：{\"actions\":[{...}]}，动作三选一：",
  "append（接到已有线：file=线名，content=情节正文）、update（修正已有线某小节：file=线名，section=小节短标题，content=修正后正文）、new-thread（开新线：thread=kebab-case 短名，title=人可读标题，content=首段情节）。",
  "情节要有叙事要素（做了什么/结果/说了什么/有何要求），不要孤立的一句话事实；能接上已有线就给该 topic，接不上才开新线。",
  "噪音（寒暄、与长期记忆无关的过程性内容）直接跳过；判断某条线这段对话之后再无下文迹象（如明确的完成结论）时在该线的动作上加 status:\"inactive\"。",
  "无值得记的内容输出 {\"actions\":[]}。",
].join("\n")

/** 内化器固定文案（spec 6，verbatim-pinned）。 */
const CONSOLIDATE_SYSTEM_PROMPT = [
  "你是认知内化器。输入是一条已完结主题线的全部情节，与现有的全局认知文件内容。",
  "回答\"从这条线的经历里理解到了什么\"：只输出 JSON {\"actions\":[...]}，动作目标三选一：persona（用户画像，连贯正文片段）、wiki:<name> 用 target:\"wiki\"+name（一个资源一个文件）、rule:<域> 用 target:\"rule\"+name（清单式，每条规则一个小节）。",
  "target:\"skill\" 本期不可用。每条新认知附 source 字段（格式 topic#日期）；已有认知被新经历印证的不动，被推翻的就地改写（op:\"rewrite\"，content 为改写后的完整小节/段落）；新增用 op:\"append\" 或 op:\"create\"。",
  "拿不准落 global 还是项目时倾向 global 谨慎、宁小勿大。无新认知输出 {\"actions\":[]}。",
].join("\n")

interface CognitionAction {
  target: "persona" | "wiki" | "rule" | "skill"
  name?: string
  op: "rewrite" | "append" | "create"
  content: string
  source: string
}

/** 模块级全局 L2 写入锁（spec 4.1）：跨项目并发内化撞同一文件时串行化。 */
let l2WriteChain: Promise<void> = Promise.resolve()
function withL2Lock<T>(fn: () => Promise<T>): Promise<T> {
  const run = l2WriteChain.then(fn)
  l2WriteChain = run.then(() => undefined, () => undefined)
  return run
}

function readFileSyncSafe(path: string): string | undefined {
  try { return readFileSync(path, "utf8") } catch { return undefined }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

/** 情节正文的首个非空行（节选小节标题用）。 */
function firstLineTitle(content: string): string {
  return content.split("\n").find((l) => l.trim() !== "")?.trim() ?? ""
}

/** 把一条主题线渲染成内化提示里的情节正文。 */
function renderThreadBody(tf: ThreadFile): string {
  return tf.sections.map((s) => `## ${s.date} · ${s.heading}\n\n${s.body}`).join("\n\n")
}

function todayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * 两个水位谁更靠后（spec 4.1）：范围选取一律用最靠后的那个，任一触发先跑到哪，
 * 另一个触发都不再重复提取（后到者按最新水位重选范围）。水位所在会话/消息已
 * 不存在（被删）时按"更旧"处理 —— messagesSince 对删掉的会话退化为全量。
 */
function messagePosition(rows: Array<{ id: string; messages: Array<{ id: string }> }>, wm: Watermark): number {
  let pos = 0
  for (const s of rows) {
    const i = s.messages.findIndex((m) => m.id === wm.messageId)
    if (s.id === wm.sessionId && i !== -1) return pos + i
    pos += s.messages.length
  }
  return -1
}

function laterWatermark(
  rows: Array<{ id: string; messages: Array<{ id: string }> }>,
  a: Watermark | undefined,
  b: Watermark | undefined,
): Watermark | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const ia = messagePosition(rows, a)
  const ib = messagePosition(rows, b)
  if (ia === -1) return b
  if (ib === -1) return a
  return ia >= ib ? a : b
}

/** 内化 JSON 解析（宽容原则，同 #extract）。 */
function parseCognitionActions(raw: string, log: (m: string) => void): CognitionAction[] {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fenced !== null) text = fenced[1]!.trim()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { log("kclaw memory consolidate: unparseable response"); return [] }
  const actions = (parsed as { actions?: unknown }).actions
  if (!Array.isArray(actions)) return []
  return actions.filter((a): a is CognitionAction => {
    if (typeof a !== "object" || a === null) return false
    const x = a as Record<string, unknown>
    return typeof x.content === "string" && x.content !== "" && typeof x.target === "string"
  }).map((a) => {
    const x = a as unknown as Record<string, unknown>
    return {
      target: x.target as CognitionAction["target"],
      name: typeof x.name === "string" ? x.name : undefined,
      op: x.op === "create" || x.op === "append" ? x.op : "rewrite",
      content: x.content as string,
      source: typeof x.source === "string" ? x.source : "",
    }
  })
}

export class MemoryPipeline {
  readonly #layout: MemoryLayout
  readonly #sessions: SessionStore
  readonly #deps: PipelineDeps
  /** 项目级串行锁（spec 4.1）：同项目触发（含内化）排队执行。 */
  readonly #locks = new Map<string, Promise<void>>()
  /** 每项目打开的 VectorIndex（daemon 生命周期内复用连接）。 */
  readonly #indexes = new Map<string, VectorIndex>()
  /** 自动收束阈值（spec 5）；缺省 14 天。 */
  readonly #inactiveDays: number
  /** 内化开关（spec 6）；缺省开。 */
  readonly #consolidateEnabled: boolean

  constructor(memoryDir: string, sessions: SessionStore, deps: PipelineDeps) {
    this.#layout = new MemoryLayout(memoryDir)
    this.#sessions = sessions
    this.#deps = deps
    this.#inactiveDays = deps.threadInactiveDays ?? 14
    this.#consolidateEnabled = deps.consolidateEnabled ?? true
  }

  #now(): Date { return this.#deps.now?.() ?? new Date() }
  #log(msg: string): void { (this.#deps.log ?? ((m) => console.error(m)))(msg) }

  #lock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(projectId) ?? Promise.resolve()
    const run = prev.then(fn)
    this.#locks.set(projectId, run.then(() => undefined, () => undefined))
    return run
  }

  #indexFor(projectId: string): VectorIndex {
    let idx = this.#indexes.get(projectId)
    if (idx === undefined) {
      idx = new VectorIndex(join(this.#layout.projectDir(projectId), "vectors.db"))
      this.#indexes.set(projectId, idx)
    }
    return idx
  }

  /** 全局认知库索引：显式落 <memoryDir>/global/vectors.db，不走 projects 目录。 */
  #globalIndex(): VectorIndex {
    let idx = this.#indexes.get("__global__")
    if (idx === undefined) {
      idx = new VectorIndex(join(this.#layout.globalDir, "vectors.db"))
      this.#indexes.set("__global__", idx)
    }
    return idx
  }

  async runTrigger(workdir: string, trigger: PipelineTrigger): Promise<void> {
    const { id } = this.#layout.ensureProject(workdir)
    return this.#lock(id, () => this.#runLocked(id, workdir, trigger))
  }

  async #runLocked(projectId: string, workdir: string, trigger: PipelineTrigger): Promise<void> {
    const ledger = new WriteLedger(join(this.#layout.projectDir(projectId), "state.json"))
    // 选范围（项目维度，spec 4.1）：该项目全部会话的新消息。manual/immediate 覆盖到
    // 当前时刻（全量重扫）；interval/follow 按两个水位中最靠后的那个取增量，后到者不重复提取。
    const rows = this.#sessionRows(projectId)
    const watermark = trigger === "interval" || trigger === "follow"
      ? laterWatermark(rows, ledger.get("interval"), ledger.get("follow"))
      : undefined
    const range = this.#messagesSince(rows, watermark)
    if (range.length === 0) return
    const actions = await this.#extract(projectId, range)
    const touched = new Set<string>()
    for (const action of actions) {
      try { this.#applyThreadAction(projectId, action); touched.add(action.file) }
      catch (err) { this.#log(`kclaw memory action skipped: ${String(err)}`) }
    }
    this.#advance(ledger, trigger, range)
    // 时间自动（spec 5）：每次管线跑完顺带扫描全部 active 线收束；空批次也扫。
    const inactivated = await this.#maybeAutoInactivate(projectId)
    for (const t of inactivated) touched.add(t)
    if (touched.size > 0) {
      this.#reindexProject(projectId)
      this.#rebuildMemoryMd(projectId)
    }
    // 顺带内化检查（spec 4.2/6）：本次涉及的线若已 inactive 则总结一次。
    await this.#maybeConsolidateTouched(projectId, touched)
  }

  #sessionRows(projectId: string): Array<{ id: string; createdAt: string; messages: Message[] }> {
    const workdir = this.#layout.workdirOf(projectId) ?? ""
    return this.#sessions.list()
      .filter((m) => (m.workdir ?? "") === workdir)
      .map((m) => ({ id: m.id, createdAt: m.createdAt, messages: this.#sessions.readMessages(m.id) }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  #messagesSince(rows: Array<{ id: string; createdAt: string; messages: Message[] }>, watermark: Watermark | undefined): Message[] {
    const pairs = WriteLedger.messagesSince(watermark, rows)
    const byId = new Map<string, Message>()
    for (const s of rows) for (const msg of s.messages) byId.set(msg.id, msg)
    return pairs.map((p) => byId.get(p.messageId)).filter((m): m is Message => m !== undefined)
  }

  #advance(ledger: WriteLedger, trigger: PipelineTrigger, range: Message[]): void {
    const last = range[range.length - 1]!
    if (trigger === "interval" || trigger === "follow") ledger.advance(trigger, { sessionId: last.sessionId, messageId: last.id })
    else ledger.advanceAll({ sessionId: last.sessionId, messageId: last.id })
  }

  async #extract(projectId: string, range: Message[]): Promise<ExtractAction[]> {
    const memoryMdPath = join(this.#layout.projectDir(projectId), "MEMORY.md")
    let threadsTable = ""
    try { threadsTable = readFileSync(memoryMdPath, "utf8") } catch { /* 尚无索引表 */ }
    let raw: string
    try {
      raw = await collectStreamText(this.#deps.llm, {
        model: this.#deps.model,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${renderSegment(range)}\n\n--- 已有主题线 ---\n${threadsTable || "（暂无）"}` }],
        tools: [],
      })
    } catch (err) {
      this.#log(`kclaw memory extract failed (watermark not advanced): ${String(err)}`)
      throw err // 抛出走锁内 catch：水位不推进（spec 11），下次触发重试同一范围
    }
    let text = raw.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
    if (fenced !== null) text = fenced[1]!.trim()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      this.#log(`kclaw memory extract: unparseable response, batch abandoned`)
      return []
    }
    const actions = (parsed as { actions?: unknown }).actions
    if (!Array.isArray(actions)) { this.#log("kclaw memory extract: response has no actions array"); return [] }
    return actions.filter((a): a is ExtractAction => {
      if (typeof a !== "object" || a === null) return false
      const x = a as Record<string, unknown>
      const ok = typeof x.file === "string" && x.file !== ""
        && (x.op === "append" || x.op === "update" || x.op === "new-thread")
        && typeof x.content === "string" && x.content !== ""
      if (!ok) this.#log(`kclaw memory extract: dropping malformed action`)
      return ok
    })
  }

  #applyThreadAction(projectId: string, action: ExtractAction): void {
    const dir = this.#layout.projectDir(projectId)
    const path = join(dir, `${action.file}.md`)
    const date = todayOf(this.#now())
    if (action.op === "new-thread") {
      const tf = writeThreadFile(path, (tf) => tf, () => ({
        topic: action.thread ?? action.file, title: action.title ?? action.file,
        status: action.status ?? "active", created: date, updated: date, sections: [],
      }))
      writeThreadFile(path, (t) => appendSection({ ...t, title: t.title || (action.title ?? t.topic) }, { date, heading: action.title ?? action.file, body: action.content }), () => tf)
      this.#deps.emit?.({ type: "memory.written", path, kind: "episode", topic: action.file })
      return
    }
    // append / update：目标线不存在 → 按 new-thread 处理并记日志（spec 11）
    const raw = readFileSyncSafe(path)
    if (raw === undefined) {
      this.#log(`kclaw memory action targets missing thread ${action.file}: treating as new-thread`)
      this.#applyThreadAction(projectId, { ...action, op: "new-thread", thread: action.thread ?? action.file })
      return
    }
    const currentIsInactive = parseThreadFile(raw)?.status === "inactive"
    if (action.op === "append") {
      writeThreadFile(path, (tf) => appendSection(tf, { date, heading: firstLineTitle(action.content), body: action.content }), () => { throw new Error("unreachable") })
    } else {
      writeThreadFile(path, (tf) => updateSection(tf, action.section ?? "", action.content), () => { throw new Error("unreachable") })
    }
    // 复活：inactive 线又有新情节 → active（spec 5）；显式 status 覆盖
    if (action.status === "inactive") {
      writeThreadFile(path, (tf) => ({ ...tf, status: "inactive" }), () => { throw new Error("unreachable") })
    } else if (action.status === "active" || currentIsInactive) {
      writeThreadFile(path, (tf) => ({ ...tf, status: "active" }), () => { throw new Error("unreachable") }) // inactive → active 复活（spec 5）
    }
    this.#deps.emit?.({ type: "memory.written", path, kind: "episode", topic: action.file })
  }

  #reindexProject(projectId: string): void {
    const dir = this.#layout.projectDir(projectId)
    const idx = this.#indexFor(projectId)
    const onDisk = new Set<string>()
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")) {
      const tf = parseThreadFile(readFileSync(join(dir, f.name), "utf8"))
      if (tf === undefined) continue
      for (const s of tf.sections) {
        const key = `${tf.topic}#${s.date}#${s.heading}`
        onDisk.add(key)
        idx.upsert({ key, text: s.body, topic: tf.topic, title: tf.title, date: s.date, updatedAt: tf.updated })
      }
    }
    for (const key of idx.keys()) if (!onDisk.has(key)) idx.remove(key)
    // 向量补算在 reconcile（MemorySystem）统一做（embed 可用时批量）
  }

  #rebuildMemoryMd(projectId: string): void {
    const dir = this.#layout.projectDir(projectId)
    const threads: ThreadFile[] = []
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")) {
      const tf = parseThreadFile(readFileSync(join(dir, f.name), "utf8"))
      if (tf !== undefined) threads.push(tf)
    }
    writeFileAtomic(join(dir, "MEMORY.md"), renderMemoryMd(projectId, threads))
  }

  /** 时间自动 inactive（spec 5）：扫描全部 active 线，闲置超阈值则收束；返回本次收束的线。 */
  async #maybeAutoInactivate(projectId: string): Promise<string[]> {
    const dir = this.#layout.projectDir(projectId)
    const limitDays = this.#inactiveDays
    const inactivated: string[] = []
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")) {
      const topic = f.name.replace(/\.md$/, "")
      const tf = parseThreadFile(readFileSync(join(dir, f.name), "utf8"))
      if (tf === undefined || tf.status !== "active") continue
      const idleDays = (this.#now().getTime() - Date.parse(`${tf.updated}T00:00:00Z`)) / 86_400_000
      if (idleDays >= limitDays) {
        writeThreadFile(join(dir, f.name), (t) => ({ ...t, status: "inactive" }), () => { throw new Error("unreachable") })
        inactivated.push(topic)
      }
    }
    return inactivated
  }

  /** 顺带内化检查（spec 4.2/6）：本次涉及的线若已 inactive 则总结一次。 */
  async #maybeConsolidateTouched(projectId: string, touched: Set<string>): Promise<void> {
    const dir = this.#layout.projectDir(projectId)
    for (const topic of touched) {
      const tf = parseThreadFile(readFileSyncSafe(join(dir, `${topic}.md`)) ?? "")
      if (tf !== undefined && tf.status === "inactive") await this.#consolidateLocked(projectId, tf)
    }
  }

  async consolidate(workdir: string, topic: string): Promise<void> {
    const { id } = this.#layout.ensureProject(workdir)
    return this.#lock(id, async () => {
      const tf = parseThreadFile(readFileSyncSafe(join(this.#layout.projectDir(id), `${topic}.md`)) ?? "")
      if (tf === undefined) throw new Error(`thread not found: ${topic}`)
      await this.#consolidateLocked(id, tf)
    })
  }

  /** 内化实现（spec 6）；写 global 文件加全局 L2 锁。 */
  async #consolidateLocked(projectId: string, tf: ThreadFile): Promise<void> {
    if (!this.#consolidateEnabled) return
    await withL2Lock(async () => {
      const existing = this.#readExistingCognitions()
      let raw: string
      try {
        raw = await collectStreamText(this.#deps.llm, {
          model: this.#deps.model,
          system: CONSOLIDATE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: `主题线 ${tf.topic}（${tf.title}）的情节：\n\n${renderThreadBody(tf)}\n\n--- 现有认知 ---\n${existing}` }],
          tools: [],
        })
      } catch (err) {
        this.#log(`kclaw memory consolidate failed for ${tf.topic}: ${String(err)}`)
        return
      }
      const actions = parseCognitionActions(raw, this.#log.bind(this))
      const source = `${tf.topic}#${tf.sections[tf.sections.length - 1]?.date ?? ""}`
      for (const action of actions) await this.#applyCognitionAction(action, source)
    })
  }

  #readExistingCognitions(): string {
    const dir = this.#layout.globalDir
    const out: string[] = []
    const push = (path: string, kind: CogKind, name: string): void => {
      const raw = readFileSyncSafe(path)
      if (raw === undefined) return
      const cf = parseCognitionFile(raw, kind, name)
      if (cf === undefined) return
      out.push(`## ${kind}/${name}（${cf.title}）\n${cf.body}`)
    }
    push(join(dir, "persona.md"), "persona", "persona")
    for (const f of readDirSafe(join(dir, "wiki"))) if (f.endsWith(".md")) push(join(dir, "wiki", f), "wiki", f.replace(/\.md$/, ""))
    for (const f of readDirSafe(join(dir, "rule"))) if (f.endsWith(".md")) push(join(dir, "rule", f), "rule", f.replace(/\.md$/, ""))
    return out.join("\n\n")
  }

  async #applyCognitionAction(action: CognitionAction, source: string): Promise<void> {
    if (action.target === "skill") {
      this.#log(`kclaw memory consolidate: skill target reserved, skipped (spec 2.3)`)
      return
    }
    const kind = action.target // persona | wiki | rule
    const name = kind === "persona" ? "persona" : (action.name ?? "misc")
    const path = cognitionPath(this.#layout.globalDir, kind, name)
    const withSource = `${action.content}\n<!-- 来源：${action.source || source} -->`
    const result = writeCognitionFile(path, kind, name,
      (cf) => {
        if (action.op === "append") return { ...cf, body: `${cf.body}\n\n${withSource}`, updated: todayOf(this.#now()) }
        return { ...cf, body: action.content, updated: todayOf(this.#now()) } // rewrite：就地改写不保留旧版（spec 2.3）
      },
      () => ({ kind, name, title: name, scope: "global", created: todayOf(this.#now()), updated: todayOf(this.#now()), body: withSource }))
    this.#deps.emit?.({ type: "memory.written", path, kind: "cognition", scope: result.scope })
    await this.#reindexGlobal()
  }

  /** 全局认知库重建索引：每文件一个条目，key = <kind>/<name>。 */
  async #reindexGlobal(): Promise<void> {
    const idx = this.#globalIndex()
    const dir = this.#layout.globalDir
    const entries: IndexEntry[] = []
    const onDisk = new Set<string>()
    const addFile = (path: string, kind: CogKind, name: string): void => {
      const raw = readFileSyncSafe(path)
      if (raw === undefined) return
      const cf = parseCognitionFile(raw, kind, name)
      if (cf === undefined) return
      const key = `${kind}/${name}`
      onDisk.add(key)
      const entry: IndexEntry = { key, text: `${cf.title}\n${cf.body}`, title: cf.title, updatedAt: cf.updated }
      entries.push(entry)
      idx.upsert(entry)
    }
    addFile(join(dir, "persona.md"), "persona", "persona")
    for (const f of readDirSafe(join(dir, "wiki"))) if (f.endsWith(".md")) addFile(join(dir, "wiki", f), "wiki", f.replace(/\.md$/, ""))
    for (const f of readDirSafe(join(dir, "rule"))) if (f.endsWith(".md")) addFile(join(dir, "rule", f), "rule", f.replace(/\.md$/, ""))
    for (const key of idx.keys()) if (!onDisk.has(key)) idx.remove(key)
    // 向量补算（spec 7.2）：embed 可用时对无向量或正文变化的条目批量补。
    await this.#backfillVectors(idx, entries)
  }

  async #backfillVectors(idx: VectorIndex, entries: IndexEntry[]): Promise<void> {
    const embed = this.#deps.embed
    if (embed === undefined || entries.length === 0) return
    const need = entries.filter((entry) => {
      const cur = idx.metaOf(entry.key)
      return cur === undefined || cur.text !== entry.text || idx.vectorOf(entry.key) === undefined
    })
    if (need.length === 0) return
    try {
      const vecs = await embed.embed(need.map((n) => n.text))
      need.forEach((n, i) => idx.upsert(n, vecs[i]))
    } catch (err) {
      this.#log(`kclaw memory embed backfill failed: ${String(err)}`)
    }
  }
}
