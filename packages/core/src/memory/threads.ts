import { existsSync, readFileSync } from "node:fs"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "../storage/atomic.js"

export interface ThreadSection { date: string; heading: string; body: string }
export interface ThreadFile {
  topic: string; title: string; status: "active" | "inactive"
  created: string; updated: string; sections: ThreadSection[]
}

const today = (): string => new Date().toISOString().slice(0, 10)

/** 解析线文件（宽容原则）；非线文件返回 undefined。 */
export function parseThreadFile(content: string): ThreadFile | undefined {
  const lines = content.split("\n")
  if (lines[0] !== "---") return undefined
  const end = lines.indexOf("---", 1)
  if (end === -1) return undefined
  let fm: unknown
  try { fm = parse(lines.slice(1, end).join("\n")) } catch { return undefined }
  if (typeof fm !== "object" || fm === null) return undefined
  const f = fm as Record<string, unknown>
  const sections: ThreadSection[] = []
  let cur: ThreadSection | null = null
  for (const line of lines.slice(end + 1)) {
    const m = /^## (\d{4}-\d{2}-\d{2}) · (.+)$/.exec(line)
    if (m !== null) {
      if (cur !== null) sections.push(cur)
      cur = { date: m[1]!, heading: m[2]!, body: "" }
    } else if (cur !== null) {
      cur.body += (cur.body === "" ? "" : "\n") + line
    }
  }
  if (cur !== null) sections.push(cur)
  for (const s of sections) s.body = s.body.replace(/^\n+/, "").replace(/\n+$/, "")
  return {
    topic: typeof f.topic === "string" && f.topic !== "" ? f.topic : "",
    title: typeof f.title === "string" ? f.title : "",
    status: f.status === "inactive" ? "inactive" : "active",
    created: typeof f.created === "string" ? f.created : today(),
    updated: typeof f.updated === "string" ? f.updated : today(),
    sections,
  }
}

export function renderThreadFile(tf: ThreadFile): string {
  const fm = stringify({ topic: tf.topic, title: tf.title, status: tf.status, created: tf.created, updated: tf.updated })
  const body = tf.sections.map((s) => `## ${s.date} · ${s.heading}\n\n${s.body}`).join("\n\n")
  return `---\n${fm}---\n\n${body}\n`
}

/**
 * 防覆盖写：永远读最新磁盘内容做基准 —— 人工改动因此先被重解析
 * 再合并，永不静默丢失。文件不存在时用 create() 起稿；存在但不可解析（如
 * 人工手写无 frontmatter）时抛错、绝不覆盖，宁可不写也不丢数据。
 */
export function writeThreadFile(
  path: string,
  mutate: (tf: ThreadFile) => ThreadFile,
  create: () => ThreadFile,
): ThreadFile {
  let base: ThreadFile | undefined
  const exists = existsSync(path)
  if (exists) {
    const parsed = parseThreadFile(readFileSync(path, "utf8"))
    if (parsed === undefined) {
      throw new Error(`memory thread file exists but is unparseable (won't overwrite): ${path}`)
    }
    base = parsed
  }
  const next = mutate(base ?? create())
  writeFileAtomic(path, renderThreadFile(next))
  return next
}

export function appendSection(tf: ThreadFile, section: ThreadSection): ThreadFile {
  return { ...tf, sections: [...tf.sections, section], updated: today() }
}

/** 修正已有情节：就地改写该小节，不另开小节；找不到时退化为追加。 */
export function updateSection(tf: ThreadFile, heading: string, newBody: string): ThreadFile {
  const idx = tf.sections.findIndex((s) => s.heading === heading)
  if (idx === -1) return appendSection(tf, { date: today(), heading, body: newBody })
  const sections = tf.sections.slice()
  sections[idx] = { ...sections[idx]!, body: newBody }
  return { ...tf, sections, updated: today() }
}

export function renderMemoryMd(projectId: string, threads: ThreadFile[]): string {
  const rows = threads
    .slice().sort((a, b) => (a.updated < b.updated ? 1 : -1))
    .map((t) => `| ${t.topic} | ${t.title} | ${t.status} | ${t.updated} |`)
  return [`# ${projectId} 项目记忆`, "", "| topic | 一句话 | 状态 | 最近活动 |", "|---|---|---|---|", ...rows, ""].join("\n")
}

export function parseMemoryMd(content: string): Array<{ topic: string; title: string; status: string; updated: string }> {
  const out: Array<{ topic: string; title: string; status: string; updated: string }> = []
  for (const line of content.split("\n")) {
    const m = /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/.exec(line)
    if (m === null || m[1]!.trim() === "topic") continue
    out.push({ topic: m[1]!.trim(), title: m[2]!.trim(), status: m[3]!.trim(), updated: m[4]!.trim() })
  }
  return out
}
