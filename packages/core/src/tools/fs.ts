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

/**
 * Read-state for the read-before-edit guard, scoped to one run (the tools
 * are constructed per run): path → size+mtime captured at read time. An
 * existing file may only be written/edited if it was read this run and has
 * not changed since — the model must not edit from imagination, and an
 * external change between read and write must not be silently clobbered.
 * Creating a new file is never blocked (there is nothing to have read).
 */
interface ReadRecord {
  size: number
  mtimeMs: number
}

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
  const readState = new Map<string, ReadRecord>()

  /**
   * Resolve `p` against the workspace. No escape check lives here: the
   * permission gate decides whether an out-of-workspace target is allowed.
   */
  const sandboxed = (p: string): string => path.resolve(root, p)

  /** Guard for an existing target; throws unless it was read and is unchanged. */
  const requireRead = (resolved: string, p: string): void => {
    let current: { size: number; mtimeMs: number }
    try {
      const st = statSync(resolved)
      current = { size: st.size, mtimeMs: st.mtimeMs }
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    const record = readState.get(resolved)
    if (record === undefined) {
      throw new ToolError(`该文件本 run 内未读取过，先用 fs_read 读取后再修改（防止盲改）: ${p}`)
    }
    if (record.size !== current.size || record.mtimeMs !== current.mtimeMs) {
      throw new ToolError(`文件在读取后被外部修改过，请重新 fs_read 后再修改: ${p}`)
    }
  }

  const record = (resolved: string): void => {
    try {
      const st = statSync(resolved)
      readState.set(resolved, { size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      readState.delete(resolved)
    }
  }

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
      const output = readFileSync(resolved, "utf8")
      // Record only on success: the guard's premise is that the content is
      // in the model's context — a failed read does not count as having read.
      record(resolved)
      return { status: "ok", output }
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

    // Read-before-overwrite guard: an existing file must have been read this
    // run and unchanged since. A missing target is a create — no guard.
    let exists = true
    try {
      statSync(resolved)
    } catch {
      exists = false
    }
    if (exists) requireRead(resolved, p)

    try {
      mkdirSync(path.dirname(resolved), { recursive: true })
      writeFileSync(resolved, content, "utf8")
    } catch (e) {
      throw new ToolError(`${errMsg(e)} (${p})`)
    }
    record(resolved)
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

    // Read-before-edit guard: reading inside this call does not count — the
    // model must have pulled the content into context via fs_read first.
    requireRead(resolved, p)

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
    record(resolved)
    return { status: "ok", output: "replaced 1 occurrence" }
  })

  return { "fs_read": fs_read, "fs_list": fs_list, "fs_write": fs_write, "fs_edit": fs_edit }
}
