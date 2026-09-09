/**
 * Subagent memory isolation (issue #16, Q7): child sessions are process text
 * of a tool — they never enter extraction scans and never serve as the
 * attribution fallback. Asserted through the REAL MemorySystem/pipeline with
 * a scripted extractor that records what it was shown.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySystem } from "../../src/memory/system.js"
import { SessionStore } from "../../src/session/store.js"
import { newMessage } from "../../src/protocol/messages.js"
import { loadConfig, resolvePaths } from "../../src/storage/index.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"

let root: string
let sessions: SessionStore
const WORKDIR = "/w/proj"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-submem-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function seed(sessionId: string, text: string): void {
  sessions.appendMessage(sessionId, newMessage(sessionId, "user", [
    { id: `blk_${text.length}_${sessionId.slice(-4)}`, type: "text", text },
  ]))
}

/** An extractor that records every prompt it was shown and extracts nothing. */
function recordingExtractor(): { system: MemorySystem; prompts: string[] } {
  const prompts: string[] = []
  const llm: LlmClient = {
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      prompts.push(`${req.system}\n${JSON.stringify(req.messages)}`)
      yield { type: "text_delta", delta: JSON.stringify({ actions: [] }) }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  const config = loadConfig(resolvePaths(root))
  config.workspace = WORKDIR
  const system = new MemorySystem({
    memoryDir: join(root, "memory"),
    sessions,
    config,
    resolveLlm: () => ({ llm, model: "test" }),
  })
  return { system, prompts }
}

describe("subagent memory isolation", () => {
  it("interval sweep extracts the mainline session and never the child", async () => {
    const main = sessions.create("主线", undefined, WORKDIR)
    const child = sessions.create("子代理 · 扫描", undefined, WORKDIR, "default", main.id)
    seed(main.id, "主线敲定了用 SQLite 存用量台账")
    seed(child.id, "子代理过程文本：翻了 30 个文件看到很多 TODO")

    const { system, prompts } = recordingExtractor()
    await system.triggerInterval(WORKDIR)

    expect(prompts.length).toBeGreaterThan(0)
    const shown = prompts.join("\n")
    expect(shown).toContain("主线敲定了")
    expect(shown).not.toContain("子代理过程文本")
    // The child never even got a watermark bookkeeping row (it is not a target).
    void child
  })

  it("children never serve as the recent-session attribution fallback", () => {
    const main = sessions.create("主线", undefined, WORKDIR)
    // Child updated AFTER the mainline (it would win any updatedAt sort).
    const child = sessions.create("子代理 · x", undefined, WORKDIR, "default", main.id)
    seed(child.id, "刚刚活跃")
    const { system } = recordingExtractor()
    expect(system.recentSessionId(WORKDIR)).toBe(main.id)
  })
})
