/**
 * Run-assembly mention wiring tests — the workspace resolution of extracted
 * mention tokens (exists / missing / workspace escape) and the composition of
 * the skill wrap and the file wrap into one model-facing text.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { combineMentionTexts, resolveFileMentions } from "../../src/agent/run-assembly.js"

describe("resolveFileMentions", () => {
  let root: string // canonical workspace
  let outside: string

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-mention-ws-")))
    outside = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-mention-out-")))
    await writeFile(join(root, "a.ts"), "hello")
    await mkdir(join(root, "sub"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it("resolves an existing file relative to the workspace as ok", () => {
    expect(resolveFileMentions("看 @a.ts", root)).toEqual([{ token: "a.ts", status: "ok" }])
    expect(resolveFileMentions("@sub/../a.ts", root)).toEqual([{ token: "sub/../a.ts", status: "ok" }])
  })

  it("accepts absolute tokens that stay inside the workspace", () => {
    expect(resolveFileMentions(`@${join(root, "a.ts")}`, root)).toEqual([{ token: join(root, "a.ts"), status: "ok" }])
  })

  it("marks a missing path and a directory as missing", () => {
    expect(resolveFileMentions("@gone.ts", root)).toEqual([{ token: "gone.ts", status: "missing" }])
    expect(resolveFileMentions("@sub", root)).toEqual([{ token: "sub", status: "missing" }])
  })

  it("drops tokens that escape the workspace (symlink out)", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leak.ts"))
    await writeFile(join(outside, "secret.txt"), "nope")
    expect(resolveFileMentions("@leak.ts", root)).toEqual([])
  })

  it("keeps a symlink that resolves back inside the workspace", async () => {
    await symlink("a.ts", join(root, "alias.ts"))
    expect(resolveFileMentions("@alias.ts", root)).toEqual([{ token: "alias.ts", status: "ok" }])
  })

  it("marks a broken symlink as missing", async () => {
    await symlink("nope.ts", join(root, "dangling.ts"))
    expect(resolveFileMentions("@dangling.ts", root)).toEqual([{ token: "dangling.ts", status: "missing" }])
  })

  it("resolves a mention after Chinese text through to the file", () => {
    expect(resolveFileMentions("看看 @a.ts 这个", root)).toEqual([{ token: "a.ts", status: "ok" }])
  })
})

describe("combineMentionTexts", () => {
  const userText = "原文"

  it("returns undefined when neither wrap produced text", () => {
    expect(combineMentionTexts(userText, undefined, undefined)).toBeUndefined()
  })

  it("passes through a single wrap", () => {
    expect(combineMentionTexts(userText, "原文\n\n（技能行）", undefined)).toBe("原文\n\n（技能行）")
    expect(combineMentionTexts(userText, undefined, "\n\n（文件行）")).toBe("原文\n\n（文件行）")
  })

  it("appends the file lines after the skill wrap", () => {
    expect(combineMentionTexts(userText, "原文\n\n（技能行）", "\n\n（文件行）")).toBe("原文\n\n（技能行）\n\n（文件行）")
  })
})
