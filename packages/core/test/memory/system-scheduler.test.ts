/**
 * MemorySystem 定时/跟随触发 + 跟随门禁 + stop() 句柄释放（Task 13）。
 * 直通方法：triggerInterval/triggerFollow/markIntervalRun/intervalLastRun/
 * scheduleFollowCheck/clearFollowCheck/pendingFollowChecks/lastActivity/stop。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySystem } from "../../src/memory/system.js"
import { SessionStore } from "../../src/session/store.js"
import { defaultConfig } from "../../src/storage/config.js"
import { projectIdFor } from "../../src/memory/layout.js"
import { scriptedLlm } from "./helpers.js"

let root: string
let sessions: SessionStore
const WORKDIR = "/w/kclaw"

const THREAD_ACTION = JSON.stringify({ actions: [{ file: "ws", op: "new-thread", thread: "ws", title: "重连线", content: "指数退避消灭了重连风暴" }] })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-syssched-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function makeSystem(): MemorySystem {
  return new MemorySystem({
    memoryDir: join(root, "memory"),
    sessions,
    config: structuredClone(defaultConfig),
    resolveLlm: () => ({ llm: scriptedLlm([THREAD_ACTION]), model: "m" }),
  })
}

describe("interval watermark (markIntervalRun / intervalLastRun)", () => {
  it("persists the last interval run time per project and survives reopen", () => {
    const sys = makeSystem()
    expect(sys.intervalLastRun(WORKDIR)).toBeUndefined()
    sys.markIntervalRun(WORKDIR, "2026-08-29T12:00:00Z")
    expect(sys.intervalLastRun(WORKDIR)).toBe("2026-08-29T12:00:00Z")
    // 重开（新实例读同一 memoryDir）仍可见
    const again = makeSystem()
    expect(again.intervalLastRun(WORKDIR)).toBe("2026-08-29T12:00:00Z")
  })
})

describe("trigger interval/follow (直通 pipeline)", () => {
  it("interval trigger writes episodes and advances the interval watermark", async () => {
    const sys = makeSystem()
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "重连风暴修好了" }], createdAt: new Date().toISOString() })
    await sys.triggerInterval(WORKDIR)
    const proj = join(root, "memory", "projects", projectIdFor(WORKDIR))
    expect(existsSync(join(proj, "ws.md"))).toBe(true)
    const state = JSON.parse(readFileSync(join(proj, "state.json"), "utf8")) as {
      watermarks: Record<string, { interval?: string }>
    }
    expect(state.watermarks[meta.id]?.interval).toBe("m1")
  })

  it("follow trigger advances the follow watermark", async () => {
    const sys = makeSystem()
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "重连风暴修好了" }], createdAt: new Date().toISOString() })
    await sys.triggerFollow(WORKDIR)
    const proj = join(root, "memory", "projects", projectIdFor(WORKDIR))
    const state = JSON.parse(readFileSync(join(proj, "state.json"), "utf8")) as {
      watermarks: Record<string, { follow?: string }>
    }
    expect(state.watermarks[meta.id]?.follow).toBe("m1")
  })
})

describe("follow checks (schedule/clear/pending)", () => {
  it("schedules, lists and clears a check on the session's project; survives reopen", () => {
    const sys = makeSystem()
    const meta = sessions.create("ses_1", undefined, WORKDIR)
    sys.scheduleFollowCheck(meta.id, "2026-08-29T10:00:00Z")
    expect(sys.pendingFollowChecks(WORKDIR)).toEqual([{ sessionId: meta.id, endTurnAt: "2026-08-29T10:00:00Z" }])
    const again = makeSystem()
    expect(again.pendingFollowChecks(WORKDIR)).toEqual([{ sessionId: meta.id, endTurnAt: "2026-08-29T10:00:00Z" }])
    again.clearFollowCheck(WORKDIR, meta.id)
    expect(again.pendingFollowChecks(WORKDIR)).toEqual([])
    // 幂等：不存在也 cleared；无记忆项目返回空
    expect(() => again.clearFollowCheck(WORKDIR, "ses_nope")).not.toThrow()
    expect(again.pendingFollowChecks("/w/other")).toEqual([])
  })
})

describe("lastActivity", () => {
  it("returns the max session updatedAt for the project's workdir only", () => {
    const sys = makeSystem()
    expect(sys.lastActivity(WORKDIR)).toBe("")
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "hi" }], createdAt: new Date().toISOString() })
    const activity = sys.lastActivity(WORKDIR)
    expect(activity).not.toBe("")
    expect(activity >= meta.createdAt).toBe(true)
    // 其他 workdir 的会话不计入
    expect(sys.lastActivity("/w/other")).toBe("")
  })
})

describe("stop() 句柄释放", () => {
  it("closes the vector indexes without throwing (idempotent-safe)", async () => {
    const sys = makeSystem()
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "重连风暴修好了" }], createdAt: new Date().toISOString() })
    await sys.triggerManual(WORKDIR) // 打开并写入项目索引
    sys.reconcile()                   // 打开全局索引
    await expect(sys.stop()).resolves.toBeUndefined()
    // 再次 stop 不应抛（各 close 已容错）
    await expect(sys.stop()).resolves.toBeUndefined()
  })
})
