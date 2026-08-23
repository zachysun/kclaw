/**
 * fs tools: read / list / write / edit files.
 *
 * Boundary: every path is resolved with `path.resolve(workspace, p)` only —
 * no hard "path escapes workspace" rejection here. Whether an out-of-workspace
 * target may actually be read/written is enforced by the permission gate
 * (packages/core/src/permissions/engine.ts), which turns an escaping path into
 * a confirmation the human can approve. Rejecting it here would make a
 * confirmed approval fail anyway.
 *
 * read/list are safe + parallel (no mutation); write/edit are sensitive +
 * serial (they change workspace state).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import path from "node:path"
import type { ToolExecutor } from "../agent/tools.js"
import { errMsg, makeTool, requireString, ToolError } from "./shared.js"

const DEFAULT_MAX_READ_BYTES = 1024 * 1024

export function createFsTools(opts: {
  workspace: string
  maxReadBytes?: number
}): {
  "fs_read": ToolExecutor & { name: "fs_read" }
  "fs_list": ToolExecutor & { name: "fs_list" }
  "fs_write": ToolExecutor & { name: "fs_write" }
  "fs_edit": ToolExecutor & { name: "fs_edit" }
} {
  const root = path.resolve(opts.workspace)
  const maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES

  /**
   * Resolve `p` against the workspace. No escape check lives here: the
   * permission gate decides whether an out-of-workspace target is allowed.
   */
  const sandboxed = (p: string): string => path.resolve(root, p)

  const fs_read = makeTool("fs_read", "safe", "parallel", (args) => {
    const p = requireString(args, "path")
    const resolved = sandboxed(p)

    let size: number
    try {
      const st = statSync(resolved)
      if (st.isDirectory()) throw new ToolError(`not a file: ${p} is a directory`)
      size = st.size
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    if (size > maxReadBytes) {
      throw new ToolError(`file too large: ${p} is ${size} bytes (max ${maxReadBytes})`)
    }
    try {
      return { status: "ok", output: readFileSync(resolved, "utf8") }
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
  })

  const fs_list = makeTool("fs_list", "safe", "parallel", (args) => {
    const p = requireString(args, "path")
    const resolved = sandboxed(p)

    let entries: Dirent[]
    try {
      entries = readdirSync(resolved, { withFileTypes: true })
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    if (entries.length === 0) return { status: "ok", output: "(empty directory)" }

    const lines = entries.map((d) => {
      if (d.isDirectory()) return `${d.name}/`
      // Files (and symlinks/fifos/...): stat the target so symlink-to-dir
      // lists as a directory and everything else gets its size.
      try {
        const st = statSync(path.join(resolved, d.name))
        return st.isDirectory() ? `${d.name}/` : `${d.name} (${st.size})`
      } catch {
        return `${d.name} (broken symlink)`
      }
    })
    return { status: "ok", output: lines.join("\n") }
  })

  const fs_write = makeTool("fs_write", "sensitive", "serial", (args) => {
    const p = requireString(args, "path")
    const content = requireString(args, "content", { allowEmpty: true })
    const resolved = sandboxed(p)

    try {
      mkdirSync(path.dirname(resolved), { recursive: true })
      writeFileSync(resolved, content, "utf8")
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    return {
      status: "ok",
      output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${resolved}`,
    }
  })

  const fs_edit = makeTool("fs_edit", "sensitive", "serial", (args) => {
    const p = requireString(args, "path")
    const oldStr = requireString(args, "old")
    const newStr = requireString(args, "new", { allowEmpty: true })
    const resolved = sandboxed(p)

    let content: string
    try {
      content = readFileSync(resolved, "utf8")
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }

    // Binary guard: decoding a binary file as UTF-8 turns invalid bytes into
    // U+FFFD replacement chars, and writing the edited string back would
    // overwrite the original bytes with that mojibake. NUL bytes never occur
    // in UTF-8 text either. Refuse before any write instead of corrupting.
    if (content.includes("\uFFFD") || content.includes("\0")) {
      throw new ToolError(`fs_edit only supports text files (binary content detected): ${p}`)
    }

    const count = content.split(oldStr).length - 1
    if (count !== 1) {
      throw new ToolError(
        `expected exactly 1 occurrence of old in ${p}, found ${count} occurrences`,
      )
    }

    try {
      // Function replacer: a string replacer would interpret $ patterns
      // ($&, $$, $`, $') in newStr and silently rewrite the file.
      writeFileSync(resolved, content.replace(oldStr, () => newStr), "utf8")
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    return { status: "ok", output: "replaced 1 occurrence" }
  })

  return { "fs_read": fs_read, "fs_list": fs_list, "fs_write": fs_write, "fs_edit": fs_edit }
}
