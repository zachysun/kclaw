/**
 * grep / glob: read-only workspace search tools.
 *
 * Both run over one shared file enumeration: inside a git repository the
 * tracked + untracked-not-ignored listing (`git ls-files --exclude-standard`,
 * NUL-delimited so non-ASCII names survive); outside git or when git fails,
 * a recursive walk that skips hidden dirs and node_modules. Enumeration is
 * capped: a runaway repo must fail with a narrowing hint instead of burning
 * minutes inside a "safe" tool.
 *
 * grep skips binary files (NUL byte probe, same rule as fs_edit) and bounds
 * its output: result cap with a truncation marker, and the full hit list
 * goes to spill (when wired) with a read pointer line — the same
 * "data not lost, context stays small" contract as the shell tool.
 *
 * Both are safe + parallel: pure reads, no workspace mutation.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import picomatch from "picomatch"
import type { ToolExecutor } from "../agent/tools.js"
import { def, errMsg, int, makeTool, optInt, optString, requireString, str, ToolError, type ToolEntry } from "./shared.js"
import { spillLocatorLine, spillToolOutput } from "./spill.js"

const MAX_ENUM_FILES = 20_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_MATCHES_PER_FILE = 1000
const MAX_PATTERN_CHARS = 512
const MAX_LINE_CHARS = 400
const GREP_DEFAULT_MAX = 50
const GREP_MAX_LIMIT = 200
const GLOB_MAX_RESULTS = 500

export function createSearchTools(opts: {
  workspace: string
  /** Full-result spill dir (<home>/spill); undefined = truncation drops data. */
  spillDir?: string
}): {
  "grep": ToolExecutor & { name: "grep" }
  "glob": ToolExecutor & { name: "glob" }
} {
  const root = path.resolve(opts.workspace)

  /**
   * Candidate files, as workspace-relative paths. `globFilter` (when given)
   * narrows the list before any file is read.
   */
  const enumerate = (globFilter?: string): string[] => {
    let rels: string[]
    try {
      const res = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      })
      if (res.status === 0) {
        rels = res.stdout.toString().split("\0").filter(Boolean)
      } else {
        rels = walk("")
      }
    } catch {
      rels = walk("")
    }
    if (rels.length > MAX_ENUM_FILES) {
      throw new ToolError(
        `workspace has ${rels.length} candidate files (max ${MAX_ENUM_FILES}); narrow the search with path or glob`,
      )
    }
    if (globFilter !== undefined) {
      const isMatch = picomatch(globFilter, { dot: false })
      rels = rels.filter((f) => isMatch(f))
    }
    return rels
  }

  /** Fallback enumeration when git is absent or fails: plain recursive walk. */
  const walk = (relDir: string): string[] => {
    const acc: string[] = []
    const visit = (rel: string): void => {
      if (acc.length > MAX_ENUM_FILES) throw new ToolError(`too many files (max ${MAX_ENUM_FILES}); narrow the search`)
      let entries
      try {
        entries = readdirSync(path.resolve(root, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const d of entries) {
        if (d.name.startsWith(".") || d.name === "node_modules") continue
        const child = rel === "" ? d.name : `${rel}/${d.name}`
        if (d.isDirectory()) visit(child)
        else acc.push(child)
      }
    }
    visit(relDir)
    return acc
  }

  /** Files under `baseRel` (empty = whole workspace), absolute-free output. */
  const scoped = (rels: string[], baseRel: string): string[] => {
    if (baseRel === "") return rels
    const prefix = baseRel.endsWith("/") ? baseRel : `${baseRel}/`
    return rels.filter((f) => f === baseRel || f.startsWith(prefix))
  }

  const readIfText = (rel: string): string | undefined => {
    const full = path.resolve(root, rel)
    let buf: Buffer
    try {
      const st = statSync(full)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined
      buf = readFileSync(full)
    } catch {
      return undefined
    }
    if (buf.includes(0)) return undefined
    return buf.toString("utf8")
  }

  const grep = makeTool("grep", "safe", "parallel", (args) => {
    const pattern = requireString(args, "pattern")
    if (pattern.length > MAX_PATTERN_CHARS) {
      throw new ToolError(`pattern too long (max ${MAX_PATTERN_CHARS} chars)`)
    }
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      throw new ToolError(`invalid regex: ${errMsg(e)}`)
    }
    const baseRel = scopedBase(optString(args, "path"))
    const rels = scoped(enumerate(optString(args, "glob")), baseRel)
    const max = optInt(args, "maxResults", GREP_DEFAULT_MAX, 1, GREP_MAX_LIMIT)

    const shown: string[] = []
    const all: string[] = []
    let truncated = false
    for (const rel of rels) {
      const text = readIfText(rel)
      if (text === undefined) continue
      const lines = text.split("\n")
      let fileHits = 0
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        fileHits++
        const line = `${rel}:${i + 1}: ${lines[i].slice(0, MAX_LINE_CHARS)}`
        all.push(line)
        if (shown.length < max) shown.push(line)
        if (fileHits >= MAX_MATCHES_PER_FILE) {
          truncated = true
          break
        }
      }
    }
    if (all.length === 0) return { status: "ok", output: "(no matches)" }

    const overCap = all.length > shown.length
    let output = shown.join("\n")
    if (overCap) output += `\n...[truncated, ${all.length - shown.length} more matches]`
    else if (truncated) output += "\n...[some files stopped after 1000 matches]"
    if ((overCap || truncated) && opts.spillDir !== undefined) {
      const spill = spillToolOutput(opts.spillDir, "grep", all.join("\n"))
      output += `\n${spillLocatorLine(spill)}`
    }
    return { status: "ok", output }
  })

  const glob = makeTool("glob", "safe", "parallel", (args) => {
    const pattern = requireString(args, "pattern")
    const baseRel = scopedBase(optString(args, "path"))
    const rels = scoped(enumerate(), baseRel)
    const isMatch = picomatch(pattern, { dot: false })
    const hits = rels.filter((f) => isMatch(f))
    if (hits.length === 0) return { status: "ok", output: "(no matches)" }

    const shown = hits.slice(0, GLOB_MAX_RESULTS)
    let output = shown.join("\n")
    if (hits.length > shown.length) {
      output += `\n...[truncated, ${hits.length - shown.length} more files]`
      if (opts.spillDir !== undefined) {
        const spill = spillToolOutput(opts.spillDir, "glob", hits.join("\n"))
        output += `\n${spillLocatorLine(spill)}`
      }
    }
    return { status: "ok", output }
  })

  /** Resolve an optional path argument to a workspace-relative scope prefix. */
  const scopedBase = (p: string | undefined): string => {
    if (p === undefined) return ""
    const resolved = path.resolve(root, p)
    const rel = path.relative(root, resolved)
    if (rel === "" || rel === ".") return ""
    return rel.split(path.sep).join("/")
  }

  return { "grep": grep, "glob": glob }
}

/** The registry-facing bundle: executors + schemas owned beside each other. */
export function createSearchToolEntries(opts: Parameters<typeof createSearchTools>[0]): ToolEntry[] {
  const tools = createSearchTools(opts)
  return [
    {
      name: "grep",
      tool: tools.grep,
      def: def(
        "grep",
        "Search file contents in the workspace with a regex (workspace-relative line output `path:lineNo: content`). Respects .gitignore inside git repos; skips binary files; results capped with a truncation marker and a spill-file pointer to the full list.",
        {
          pattern: str("Regular expression (JS RegExp syntax)"),
          path: str("Optional: workspace-relative directory or file to scope the search"),
          glob: str("Optional: glob filter on file paths, e.g. `**/*.ts`"),
          maxResults: int(1, 200),
        },
        ["pattern"],
      ),
    },
    {
      name: "glob",
      tool: tools.glob,
      def: def(
        "glob",
        "Find files in the workspace by filename pattern (standard glob like `**/*.ts`). Respects .gitignore inside git repos; results capped with a truncation marker and a spill-file pointer to the full list.",
        {
          pattern: str("Glob pattern to match file paths against"),
          path: str("Optional: workspace-relative directory to scope the search"),
        },
        ["pattern"],
      ),
    },
  ]
}
