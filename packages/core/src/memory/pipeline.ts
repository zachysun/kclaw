import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { LlmClient } from "../provider/types.js"
import { collectStreamText } from "../provider/collect.js"
import { renderSegment } from "../session/compaction.js"
import type { Message } from "../protocol/messages.js"
import type { SessionStore } from "../session/store.js"
import type { MemoryEvent } from "../session/events.js"
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

export type PipelineTrigger = "immediate" | "manual" | "interval" | "follow" | "clear"

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

/** 记忆落盘通知（Task 6）：pipeline 在每次写入后回调，at 由 pipeline 补；
 *  sessionId 是触发该次写入的会话（interval 由 MemorySystem 回落为项目最近活动会话）。 */
export type MemoryAudit = Omit<MemoryEvent, "type" | "at"> & { at?: string; sessionId?: string }

export interface PipelineDeps {
  /** 每次触发时现取提取/内化用的 llm 与 model（model 为已回落解析后的提取模型）。
   *  由装配方（MemorySystem）在闭包里做 extractModel 回落主模型解析（spec 4.3）。 */
  resolveLlm: () => { llm: LlmClient; model: string }
  embed?: EmbeddingClient                        // 判定链通过时才传入；缺省 = 纯关键词
  emit?: (e: MemoryWrittenEvent) => void
  /** 记忆落盘通知（Task 6）：由装配方接成会话事件流 appendEvent。 */
  audit?: (e: MemoryAudit) => void
  log?: (msg: string) => void                    // 缺省 console.error
  now?: () => Date
  /** 自动收束阈值（spec 5）：线最近活动距今超过该天数 → inactive；缺省 14。 */
  threadInactiveDays?: number
  /** 内化开关（spec 6）：缺省开；由 Task 10 的 system 从 config 传入。 */
  consolidateEnabled?: boolean
}

/** 提取器固定文案（spec 4.3）。字段名必须与 #extract 的校验逐字一致——模型
 *  只从这里认识 JSON 结构（2026-09-01 回归：旧文案未点名 op/file，真实模型
 *  交回 type 判别 + 缺 file，动作全被丢弃且不重试）。 */
export const EXTRACT_SYSTEM_PROMPT = [
  "你是长期记忆的情节提取器。输入是一段会话消息（每行一条）与该项目已有的主题线清单（MEMORY.md 表格）。",
  "只输出一个 JSON 对象：{\"actions\":[…]}，actions 里每个动作都是 JSON 对象，字段名固定如下：",
  "- op：动作类型，只能取 \"append\"、\"update\"、\"new-thread\" 之一（判别字段名是 op，不是 type）。",
  "- file：目标线文件名（kebab-case、不含 .md），每个动作必填；new-thread 时它就是新线的文件名。",
  "- content：情节正文，每个动作必填。",
  "- update 动作额外带 section（要修正的小节短标题）；new-thread 动作额外带 thread（kebab-case 短名）与 title（人可读标题）。",
  "- 判断某条线这段对话之后再无下文迹象（如明确的完成结论）时，给该动作加 status:\"inactive\"。",
  "完整示例：{\"actions\":[{\"op\":\"new-thread\",\"file\":\"user-pref-plain-language\",\"thread\":\"user-pref-plain-language\",\"title\":\"用户偏好通俗语言\",\"content\":\"用户自称小白，要求所有解释都用通俗语言。\"}]}",
  "情节要有叙事要素（做了什么/结果/说了什么/有何要求），不要孤立的一句话事实；能接上已有线就对该线的 file 做 append/update，接不上才 new-thread。",
  "已有主题线里已记录过的内容不要重复记录；append/update 只落这段消息里出现的新信息，同一经历的转述不算新信息。",
  "区分说话人：只有用户消息里的话才算用户的表态；助手自己的复述、确认，以及记忆检索结果里的内容，都不算用户的新经历或新要求。",
  "噪音（寒暄、与长期记忆无关的过程性内容）直接跳过。无值得记的内容输出 {\"actions\":[]}。只输出 JSON，不要输出任何其他文字。",
].join("\n")

/** 内化器固定文案（spec 6）。字段名必须与 parseCognitionActions 的校验逐字一致
 *  （2026-09-01 回归：旧文案 "wiki:<name>" 记法诱导模型把名字嵌进 target）。 */
export const CONSOLIDATE_SYSTEM_PROMPT = [
  "你是认知内化器。输入是一条已完结主题线的全部情节，与现有的全局认知文件内容。",
  "回答\"从这条线的经历里理解到了什么\"：只输出一个 JSON 对象 {\"actions\":[…]}，每个动作的字段名固定如下：",
  "- target：认知目标，只能取 \"persona\"（用户画像，连贯正文片段）、\"wiki\"（一个资源一个文件）、\"rule\"（清单式，每条规则一个小节）之一；目标名不要拼进 target。",
  "- name：目标名，target 为 \"wiki\" 或 \"rule\" 时必填，为 \"persona\" 时省略。",
  "- op：\"append\"（新增条目）、\"create\"（新建文件）或 \"rewrite\"（就地改写，content 为改写后的完整小节/段落）。",
  "- content：认知正文。",
  "- source：来源，格式 topic#日期。",
  "target:\"skill\" 本期不可用。已有认知被新经历印证的不动，被推翻的就地改写（op:\"rewrite\"）；新增用 op:\"append\" 或 op:\"create\"。",
  "拿不准落 global 还是项目时倾向 global 谨慎、宁小勿大。无新认知输出 {\"actions\":[]}。只输出 JSON，不要输出任何其他文字。",
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
    // target 限三值 + wiki/rule 必带 name：#applyCognitionAction 会拿 target 拼目录
    // 路径，放行任意字符串会写出索引读不到的垃圾文件（2026-09-01 回归）。
    const targetOk = x.target === "persona" || x.target === "wiki" || x.target === "rule"
    const nameOk = x.target === "persona" || (typeof x.name === "string" && x.name !== "")
    const ok = targetOk && nameOk && typeof x.content === "string" && x.content !== ""
    if (!ok) log(`kclaw memory consolidate: dropping malformed cognition action (target=${String(x.target)})`)
    return ok
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

  /** 记忆落盘通知（Task 6）：缺省 no-op；at 由 pipeline 统一补（now 时刻）。 */
  #audit(e: MemoryAudit): void {
    this.#deps.audit?.({ ...e, at: e.at ?? this.#now().toISOString() })
  }

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

  async runTrigger(workdir: string, trigger: PipelineTrigger, sessionId?: string): Promise<void> {
    const { id } = this.#layout.ensureProject(workdir)
    return this.#lock(id, () => this.#runLocked(id, workdir, trigger, sessionId))
  }

  async #runLocked(projectId: string, workdir: string, trigger: PipelineTrigger, sessionId?: string): Promise<void> {
    const ledger = new WriteLedger(join(this.#layout.projectDir(projectId), "state.json"))
    // 选范围（项目维度，spec 4.1）：该项目全部会话的新消息。五个触发器统一走水位取
    // 增量（后到者按最新水位重选范围，谁先跑到都不重复提取）——重复内化回归
    // 2026-09-02：clear/manual/immediate 原先全量重扫，切一次会话就把已提取过的旧
    // 消息重新送审一遍，提取器照着已有主题线再转述一条（同一偏好被反复落线）。
    // 首跑水位为空 → 全量，属首次提取；提取失败水位不推进（spec 11），下次触发补上。
    const rows = this.#sessionRows(projectId)
    const watermark = laterWatermark(rows, ledger.get("interval"), ledger.get("follow"))
    const range = this.#messagesSince(rows, watermark)
    if (range.length === 0) {
      // 空批次也扫（spec 5）：项目静止（无新消息）时仍要收束到期的 active 线。
      const inactivated = await this.#maybeAutoInactivate(projectId, trigger, sessionId)
      if (inactivated.length > 0) {
        this.#reindexProject(projectId)
        this.#rebuildMemoryMd(projectId)
        // 顺带内化检查（spec 4.2/6）：本次收束的线同样要总结——否则静止项目的
        // 到期线收束为 inactive 后，认知永远不会被内化（线不复活、收束只扫
        // active，之后再无新情节触发）。
        await this.#maybeConsolidateTouched(projectId, new Set(inactivated), trigger, sessionId)
      }
      return
    }
    const actions = await this.#extract(projectId, range)
    const touched = new Set<string>()
    for (const action of actions) {
      try { this.#applyThreadAction(projectId, action, trigger, sessionId); touched.add(action.file) }
      catch (err) { this.#log(`kclaw memory action skipped: ${String(err)}`) }
    }
    this.#advance(ledger, trigger, range)
    // 时间自动（spec 5）：每次管线跑完顺带扫描全部 active 线收束；空批次也扫。
    const inactivated = await this.#maybeAutoInactivate(projectId, trigger, sessionId)
    for (const t of inactivated) touched.add(t)
    if (touched.size > 0) {
      this.#reindexProject(projectId)
      this.#rebuildMemoryMd(projectId)
      // 写路径即时向量补算（spec 7.2）：embed 可用时本次写入的线立即有向量，
      // 不必等下次重启 reconcile —— 否则运行期新经历的双路融合会结构性退化为纯关键词。
      if (this.#deps.embed !== undefined) {
        await this.#backfillVectors(this.#indexFor(projectId), this.#projectEntries(projectId))
      }
    }
    // 顺带内化检查（spec 4.2/6）：本次涉及的线若已 inactive 则总结一次。
    await this.#maybeConsolidateTouched(projectId, touched, trigger, sessionId)
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
      const { llm, model } = this.#deps.resolveLlm()
      raw = await collectStreamText(llm, {
        model,
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

  #applyThreadAction(projectId: string, action: ExtractAction, trigger: PipelineTrigger, sessionId?: string): void {
    const dir = this.#layout.projectDir(projectId)
    const path = join(dir, `${action.file}.md`)
    const date = todayOf(this.#now())
    if (action.op === "new-thread") {
      // 身份唯一性（读取线 404 回归 2026-09-02）：topic 必须等于 file——MEMORY.md
      // 行与检索键都取文件内部 topic，而读/改/删路由按文件名（=topic）定位；
      // 模型交回的 thread 字段与 file 不一致时曾把两者写劈，清单点开即 404。
      // thread 字段仅作兼容保留，不再参与身份。
      const tf = writeThreadFile(path, (tf) => tf, () => ({
        topic: action.file, title: action.title ?? action.file,
        status: action.status ?? "active", created: date, updated: date, sections: [],
      }))
      writeThreadFile(path, (t) => appendSection({ ...t, title: t.title || (action.title ?? t.topic) }, { date, heading: action.title ?? action.file, body: action.content }), () => tf)
      this.#deps.emit?.({ type: "memory.written", path, kind: "episode", topic: action.file })
      this.#audit({ trigger, kind: "episode", op: action.op, topic: action.file, sessionId })
      return
    }
    // append / update：目标线不存在 → 按 new-thread 处理并记日志（spec 11）
    const raw = readFileSyncSafe(path)
    if (raw === undefined) {
      this.#log(`kclaw memory action targets missing thread ${action.file}: treating as new-thread`)
      this.#applyThreadAction(projectId, { ...action, op: "new-thread" }, trigger, sessionId)
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
    this.#audit({ trigger, kind: "episode", op: action.op, topic: action.file, sessionId })
  }

  /** 项目库全部情节条目（从线文件读：文件是真相，索引是派生物）。 */
  #projectEntries(projectId: string): IndexEntry[] {
    const dir = this.#layout.projectDir(projectId)
    const entries: IndexEntry[] = []
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")) {
      const tf = parseThreadFile(readFileSync(join(dir, f.name), "utf8"))
      if (tf === undefined) continue
      for (const s of tf.sections) entries.push({ key: `${tf.topic}#${s.date}#${s.heading}`, text: s.body, topic: tf.topic, title: tf.title, date: s.date, updatedAt: tf.updated })
    }
    return entries
  }

  /**
   * upsert 时保留已补算的向量（spec 7.2）：正文没变 → 向量原样保留（检索/对账的
   * 重索引不再抹掉向量，双路融合不退化）；正文变了或新条目 → 弃掉旧向量，留待
   * reconcile 的 backfill 按新正文重 embed。注意 upsert 无 vector 参数会无条件
   * 清空该 key 的向量行，所以这里必须在有向量可留时才传回。
   */
  #upsertPreserve(idx: VectorIndex, entry: IndexEntry): void {
    const before = idx.metaOf(entry.key)
    const vec = before !== undefined && before.text === entry.text ? idx.vectorOf(entry.key) : undefined
    idx.upsert(entry, vec)
  }

  #reindexProject(projectId: string): void {
    const idx = this.#indexFor(projectId)
    const onDisk = new Set<string>()
    for (const entry of this.#projectEntries(projectId)) {
      onDisk.add(entry.key)
      this.#upsertPreserve(idx, entry)
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
  async #maybeAutoInactivate(projectId: string, trigger: PipelineTrigger, sessionId?: string): Promise<string[]> {
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
        this.#audit({ trigger, kind: "episode", op: "inactivate", topic, sessionId })
      }
    }
    return inactivated
  }

  /** 顺带内化检查（spec 4.2/6）：本次涉及的线若已 inactive 则总结一次。 */
  async #maybeConsolidateTouched(projectId: string, touched: Set<string>, trigger: PipelineTrigger, sessionId?: string): Promise<void> {
    const dir = this.#layout.projectDir(projectId)
    for (const topic of touched) {
      const tf = parseThreadFile(readFileSyncSafe(join(dir, `${topic}.md`)) ?? "")
      if (tf !== undefined && tf.status === "inactive") await this.#consolidateLocked(projectId, tf, trigger, sessionId)
    }
  }

  async consolidate(workdir: string, topic: string): Promise<void> {
    const { id } = this.#layout.ensureProject(workdir)
    return this.#lock(id, async () => {
      const tf = parseThreadFile(readFileSyncSafe(join(this.#layout.projectDir(id), `${topic}.md`)) ?? "")
      if (tf === undefined) throw new Error(`thread not found: ${topic}`)
      // 手动内化：无触发会话归属（调用方未提供 sessionId），attached 会话交给 MemorySystem 回落
      await this.#consolidateLocked(id, tf, "manual")
    })
  }

  /**
   * 夜间闲时内化（每日兜底，scheduler 按 memory.consolidateHour 调度）：对本项目
   * 自上次夜间内化以来有新情节的线逐条内化——判据 `updated >= #nightlyBaseline`
   * （UTC 日期，与线文件 updated 同源），**含 active 线**：活跃线的认知不再等
   * 14 天收束，每晚沉淀一次（收束时的顺带内化仍保留，二者幂等）。不提取、不动
   * 提取水位。返回本次内化的线数。
   *
   * 首跑（无 baseline）只内化当天更新的线——历史线已由顺带内化覆盖，不补跑。
   * 判据含等号：上次跑之后同日（UTC）新增的情节不能漏，宁可用一次幂等的重复
   * 内化去换。
   */
  async runNightly(workdir: string, sessionId?: string): Promise<number> {
    const { id } = this.#layout.ensureProject(workdir)
    return this.#lock(id, async () => {
      const dir = this.#layout.projectDir(id)
      const ledger = new WriteLedger(join(dir, "state.json"))
      const today = todayOf(this.#now())
      const baseline = ledger.getNightlyBaseline() ?? today
      const due: ThreadFile[] = []
      for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")) {
        const tf = parseThreadFile(readFileSync(join(dir, f.name), "utf8"))
        if (tf !== undefined && tf.updated >= baseline) due.push(tf)
      }
      for (const tf of due) await this.#consolidateLocked(id, tf, "nightly", sessionId)
      ledger.setNightlyBaseline(today)
      return due.length
    })
  }

  // ---- reconcile / 管理接口（Task 10 MemorySystem 消费） ----

  /** 项目库全量重建索引（FTS，派生物对齐磁盘；spec 2.5）。 */
  reindexProject(projectId: string): void {
    this.#reindexProject(projectId)
  }

  /** 项目库向量补算（spec 7.2）：embed 可用时对缺向量或正文变化的条目批量补。 */
  async backfillProjectVectors(projectId: string): Promise<void> {
    await this.#backfillVectors(this.#indexFor(projectId), this.#projectEntries(projectId))
  }

  /** 全局认知库全量重建索引（含 embed 可用时的向量补算）。 */
  reindexGlobal(): Promise<void> {
    return this.#reindexGlobal()
  }

  /** 重建项目 MEMORY.md 线索引表（派生物，spec 2.4）。 */
  rebuildMemoryMd(projectId: string): void {
    this.#rebuildMemoryMd(projectId)
  }

  /**
   * 关闭本管线打开的全部项目 + 全局 VectorIndex（daemon stop 序列调用，
   * Task 13）：防 better-sqlite3 句柄泄漏。已关闭/损坏的索引逐个容错。
   */
  close(): void {
    for (const idx of this.#indexes.values()) {
      try { idx.close() } catch { /* 已关闭/损坏：忽略 */ }
    }
    this.#indexes.clear()
  }

  /** 内化实现（spec 6）；写 global 文件加全局 L2 锁。trigger 放宽为审计枚举
   *  （"nightly"/"manual" 不是提取触发，仅用于 memory 事件归属）。 */
  async #consolidateLocked(projectId: string, tf: ThreadFile, trigger: MemoryAudit["trigger"], sessionId?: string): Promise<void> {
    if (!this.#consolidateEnabled) return
    await withL2Lock(async () => {
      const existing = this.#readExistingCognitions()
      let raw: string
      try {
        const { llm, model } = this.#deps.resolveLlm()
        raw = await collectStreamText(llm, {
          model,
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
      for (const action of actions) await this.#applyCognitionAction(action, source, trigger, sessionId)
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

  async #applyCognitionAction(action: CognitionAction, source: string, trigger: MemoryAudit["trigger"], sessionId?: string): Promise<void> {
    if (action.target === "skill") {
      this.#log(`kclaw memory consolidate: skill target reserved, skipped (spec 2.3)`)
      return
    }
    const kind = action.target // persona | wiki | rule
    const name = kind === "persona" ? "persona" : (action.name ?? "misc")
    const path = cognitionPath(this.#layout.globalDir, kind, name)
    const withSource = `${action.content}\n<!-- 来源：${action.source || source} -->`
    const isAppend = action.op === "append"
    const result = writeCognitionFile(path, kind, name,
      (cf) => {
        if (action.op === "append") return { ...cf, body: `${cf.body}${cf.body === "" ? "" : "\n\n"}${withSource}`, updated: todayOf(this.#now()) }
        return { ...cf, body: action.content, updated: todayOf(this.#now()) } // rewrite：就地改写不保留旧版（spec 2.3）
      },
      () => ({ kind, name, title: name, scope: "global", created: todayOf(this.#now()), updated: todayOf(this.#now()), body: isAppend ? "" : withSource }))
    this.#deps.emit?.({ type: "memory.written", path, kind: "cognition", scope: result.scope })
    this.#audit({ trigger, kind: "cognition", op: action.op, file: `${kind}/${name}`, scope: result.scope, source: action.source || source, sessionId })
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
      this.#upsertPreserve(idx, entry)
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
