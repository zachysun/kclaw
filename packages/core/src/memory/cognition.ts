import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "../storage/atomic.js"

export type CogKind = "persona" | "wiki" | "rule"
export interface CognitionFile {
  kind: CogKind; name: string; title: string; scope: string
  created: string; updated: string; body: string
}

const today = (): string => new Date().toISOString().slice(0, 10)

export function cognitionPath(globalDir: string, kind: CogKind, name: string): string {
  if (kind === "persona") return `${globalDir}/persona.md`
  return `${globalDir}/${kind}/${name}.md`
}

export function parseCognitionFile(content: string, kind: CogKind, name: string): CognitionFile | undefined {
  const lines = content.split("\n")
  if (lines[0] !== "---") return undefined
  const end = lines.indexOf("---", 1)
  if (end === -1) return undefined
  let fm: unknown
  try { fm = parse(lines.slice(1, end).join("\n")) } catch { return undefined }
  if (typeof fm !== "object" || fm === null) return undefined
  const f = fm as Record<string, unknown>
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
  return {
    kind, name,
    title: typeof f.title === "string" && f.title !== "" ? f.title : name,
    scope: typeof f.scope === "string" && f.scope !== "" ? f.scope : "global",
    created: typeof f.created === "string" ? f.created : today(),
    updated: typeof f.updated === "string" ? f.updated : today(),
    body,
  }
}

export function renderCognitionFile(cf: CognitionFile): string {
  const fm = stringify({ title: cf.title, scope: cf.scope, created: cf.created, updated: cf.updated })
  return `---\n${fm}---\n\n${cf.body}\n`
}

/** 防覆盖合并写（spec 2.5）：与 writeThreadFile 同语义。 */
export function writeCognitionFile(
  path: string, kind: CogKind, name: string,
  mutate: (cf: CognitionFile) => CognitionFile,
  create: () => CognitionFile,
): CognitionFile {
  let base: CognitionFile | undefined
  const exists = existsSync(path)
  if (exists) {
    const parsed = parseCognitionFile(readFileSync(path, "utf8"), kind, name)
    if (parsed === undefined) {
      throw new Error(`memory cognition file exists but is unparseable (won't overwrite): ${path}`)
    }
    base = parsed
  }
  const next = mutate(base ?? create())
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, renderCognitionFile(next))
  return next
}
