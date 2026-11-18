import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "../storage/atomic.js"

/** 卡片类型四值（渲染层映射中文标签：成果 / 教训 / 卡点 / 观察）。 */
export type DailyCardKind = "achievement" | "lesson" | "blocker" | "insight"

/** 卡片的展开选项：label 是展示名，opener 是预写好的开场文案全文（自包含）。 */
export interface DailyCardOption {
  label: string
  opener: string
}

/** 一张日报卡片：一段一事，正文形象生动。 */
export interface DailyCard {
  kind: DailyCardKind
  title: string
  body: string
  options: DailyCardOption[]
}

/** 一天的日报文件（<projectDir>/daily/<日期>.json）正本。 */
export interface DailyReport {
  /** 生成本地日期（YYYY-MM-DD，文件名同源）。 */
  date: string
  /** 素材窗起点（ISO 时刻，不含）。 */
  windowStart: string
  /** 素材窗终点（ISO 时刻，含）。 */
  windowEnd: string
  /** 本次生成时刻（ISO）。 */
  generatedAt: string
  cards: DailyCard[]
}

/** 卡片上限：宁缺毋滥，挑最有讲头的。 */
export const DAILY_CARD_LIMIT = 8

const KINDS = new Set<DailyCardKind>(["achievement", "lesson", "blocker", "insight"])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDailyDate(date: string): boolean {
  return DATE_RE.test(date)
}

/** 本地日期 YYYY-MM-DD（日报文件名与调度判重键都用本地时间）。 */
export function localDateOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 当天本地 0 点的 ISO 时刻（首窗起点；createdAt 比较是时刻语义）。 */
export function localMidnightIso(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
}

/** 手动重新生成失败的带状态错误：路由按 status 映 404/400，与调用方约定稳定。 */
export class DailyRegenerateError extends Error {
  readonly status: "unknown-project" | "no-file" | "empty-window"
  constructor(status: DailyRegenerateError["status"], message: string) {
    super(message)
    this.status = status
  }
}

export function dailyDir(projectDir: string): string {
  return join(projectDir, "daily")
}

export function dailyFilePath(projectDir: string, date: string): string {
  return join(projectDir, "daily", `${date}.json`)
}

/**
 * 日报卡片解析（宽容原则，同提取/沉淀）：剥代码围栏 + JSON.parse + 逐卡
 * 字段校验，非法卡丢弃记日志；超出上限的卡截断。整体不合法返回空数组。
 * 字段名与 DAILY_SYSTEM_PROMPT 的约定逐字一致。
 * 围栏剥离与 JSON.parse 的前奏与提取/沉淀两处同形（第三份）：三处共用的
 * 只有这两行，后面的逐条校验各管各的字段域，抽共享 helper 的扩散面大于
 * 收益，故保留重复（AGENTS 原则 7）。
 */
export function parseDailyCards(raw: string, log: (m: string) => void): DailyCard[] {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fenced !== null) text = fenced[1]!.trim()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { log("kclaw daily: unparseable response"); return [] }
  const cards = (parsed as { cards?: unknown }).cards
  if (!Array.isArray(cards)) { log("kclaw daily: response has no cards array"); return [] }
  const out: DailyCard[] = []
  for (const c of cards) {
    if (typeof c !== "object" || c === null) { log("kclaw daily: dropping malformed card"); continue }
    const x = c as Record<string, unknown>
    if (typeof x.kind !== "string" || !KINDS.has(x.kind as DailyCardKind)
      || typeof x.title !== "string" || x.title === ""
      || typeof x.body !== "string" || x.body === "") {
      log(`kclaw daily: dropping malformed card (kind=${String(x.kind)})`)
      continue
    }
    const options: DailyCardOption[] = []
    if (Array.isArray(x.options)) {
      for (const o of x.options) {
        if (typeof o !== "object" || o === null) continue
        const y = o as Record<string, unknown>
        if (typeof y.label !== "string" || y.label === "" || typeof y.opener !== "string" || y.opener === "") {
          log("kclaw daily: dropping malformed option")
          continue
        }
        options.push({ label: y.label, opener: y.opener })
      }
    }
    out.push({ kind: x.kind as DailyCardKind, title: x.title, body: x.body, options })
    if (out.length >= DAILY_CARD_LIMIT) break
  }
  return out
}

/** 读一天的日报；文件不存在或损坏 → undefined（派生物，损坏视同不存在）。 */
export function readDailyReport(projectDir: string, date: string): DailyReport | undefined {
  const raw = (() => {
    try { return readFileSync(dailyFilePath(projectDir, date), "utf8") } catch { return undefined }
  })()
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<DailyReport>
    if (typeof parsed.date !== "string" || typeof parsed.windowStart !== "string"
      || typeof parsed.windowEnd !== "string" || typeof parsed.generatedAt !== "string"
      || !Array.isArray(parsed.cards)) return undefined
    return parsed as DailyReport
  } catch {
    return undefined
  }
}

/** 项目已有的日报日期清单（新到旧）。 */
export function listDailyDates(projectDir: string): string[] {
  const dir = dailyDir(projectDir)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .map((f) => (f.endsWith(".json") ? f.slice(0, -".json".length) : ""))
      .filter((d) => isDailyDate(d))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  } catch {
    return []
  }
}

/** 写一天的日报（整文件原子覆盖；首次写时建 daily/ 目录，写时才建）。 */
export function writeDailyReport(projectDir: string, report: DailyReport): void {
  mkdirSync(dailyDir(projectDir), { recursive: true })
  writeFileAtomic(dailyFilePath(projectDir, report.date), JSON.stringify(report))
}
