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
import { combineMentionTexts, executeRun, resolveFileMentions, type RunEngine } from "../../src/agent/run-assembly.js"
import { EventBus } from "../../src/bus.js"
import { SessionStore } from "../../src/session/store.js"
import { Compactor } from "../../src/session/compactor.js"
import { MemorySystem } from "../../src/memory/system.js"
import { ConfirmationBroker } from "../../src/permissions/broker.js"
import { loadConfig, resolvePaths } from "../../src/storage/index.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"

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

describe("executeRun file mention wiring (end to end)", () => {
  let root: string
  let home: string

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-mention-run-ws-")))
    home = await mkdtemp(join(tmpdir(), "kclaw-mention-run-home-"))
    await writeFile(join(root, "a.ts"), "hello")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  /** Minimal executeRun harness (hooks/assembly.test.ts is the full precedent). */
  async function runOnce(userText: string): Promise<{ persisted: string; modelView: string }> {
    const lastRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        lastRequests.push(req as { messages: Array<{ role: string; content: unknown }> })
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const paths = resolvePaths(home)
    const config = loadConfig(paths)
    const sessions = new SessionStore(paths.sessionsDir)
    const bus = new EventBus()
    const memory = new MemorySystem({
      memoryDir: paths.memoryDir,
      sessions,
      config,
      resolveLlm: () => ({ llm, model: "test-model" }),
    })
    const sessionId = sessions.create("点名").id
    const engine: RunEngine = {
      deps: {
        config,
        paths,
        sessions,
        memory,
        bus,
        llm,
        model: "test-model",
        workspace: root,
        broker: new ConfirmationBroker(),
      },
      compactor: new Compactor({ sessions, emit: (e) => bus.emit(e) }),
    }
    await executeRun(engine, {
      sessionId,
      input: { userText, trigger: "user" as const },
      controller: new AbortController(),
      drainSteer: () => [],
    })
    const persisted = sessions.readMessages(sessionId)
    const modelView = (lastRequests[0]!.messages.at(-1) as { role: string; content: string }).content
    return { persisted: (persisted[0]!.blocks[0] as { text: string }).text, modelView }
  }

  it("an existing mention ends the model view with the fs_read instruction; persistence keeps the raw text", async () => {
    const { persisted, modelView } = await runOnce("看 @a.ts")
    expect(modelView.startsWith("看 @a.ts")).toBe(true)
    expect(modelView).toContain("fs_read")
    expect(persisted).toBe("看 @a.ts")
  })

  it("a missing mention tells the model the file is gone instead of asking for a read", async () => {
    const { persisted, modelView } = await runOnce("看 @gone.ts")
    expect(modelView).toContain("「@gone.ts」引用的文件不存在或已删除")
    expect(modelView).not.toContain("fs_read")
    expect(persisted).toBe("看 @gone.ts")
  })
})
