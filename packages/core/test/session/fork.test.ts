import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import { forkSession, ForkPointNotFoundError } from "../../src/session/fork.js"
import { newMessage } from "../../src/protocol/messages.js"
import type { MessageEvent } from "../../src/protocol/session-events.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-fork-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 组一条两 run 的会话流，返回关键消息 id。 */
function seedTwoRuns(s: SessionStore, title = "原会话"): { id: string; u1: string; a1: string; u2: string; a2: string } {
  const m = s.create(title, undefined, "/w", "default")
  const sid = m.id
  const u1 = newMessage(sid, "user", [{ id: "blk_1", type: "text", text: "第一问" }])
  const a1 = newMessage(sid, "assistant", [{ id: "blk_2", type: "text", text: "第一答" }])
  const u2 = newMessage(sid, "user", [{ id: "blk_3", type: "text", text: "第二问" }])
  const a2 = newMessage(sid, "assistant", [{ id: "blk_4", type: "text", text: "第二答" }])
  s.appendRunStarted(sid, { at: new Date().toISOString(), trigger: "user" })
  s.appendMessage(sid, u1)
  s.appendMessage(sid, a1)
  s.appendRunEnded(sid, { at: new Date().toISOString(), stopReason: "end_turn" })
  s.appendRunStarted(sid, { at: new Date().toISOString(), trigger: "user" })
  s.appendMessage(sid, u2)
  s.appendMessage(sid, a2)
  s.appendRunEnded(sid, { at: new Date().toISOString(), stopReason: "end_turn" })
  return { id: sid, u1: u1.id, a1: a1.id, u2: u2.id, a2: a2.id }
}

const messageIds = (s: SessionStore, id: string): string[] =>
  s.readEvents(id).filter((e): e is MessageEvent => e.type === "message").map((e) => e.id)

describe("forkSession", () => {
  it("从中间消息 fork：复制到所属 run 结束（含），血缘与标题落投影，原会话一字节不动", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const before = s.readEvents(src.id)

    const forked = forkSession({ store: s }, { sourceId: src.id, messageId: src.u1 })

    // 血缘与标题
    expect(forked.forkedFrom).toEqual({ sessionId: src.id, messageId: src.u1 })
    expect(forked.title).toBe("原会话 · fork")
    // 复制区间 = 到第一个 run.ended（含 u1/a1，不含第二 run）
    expect(messageIds(s, forked.id)).toEqual([src.u1, src.a1])
    // 新流末尾是 session.forked；原会话事件数不变
    const events = s.readEvents(forked.id)
    expect(events[events.length - 1]!.type).toBe("session.forked")
    expect(s.readEvents(src.id)).toHaveLength(before.length)
    // 原会话元数据不动
    expect(s.meta(src.id)!.title).toBe("原会话")
  })

  it("不带 messageId：整段复制（最新状态 fork）", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const forked = forkSession({ store: s }, { sourceId: src.id })
    expect(messageIds(s, forked.id)).toEqual([src.u1, src.a1, src.u2, src.a2])
    expect(forked.forkedFrom?.messageId).toBe(src.a2)
  })

  it("同源二次 fork：标题带序号", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const f1 = forkSession({ store: s }, { sourceId: src.id, messageId: src.u1 })
    const f2 = forkSession({ store: s }, { sourceId: src.id, messageId: src.u2 })
    expect(f1.title).toBe("原会话 · fork")
    expect(f2.title).toBe("原会话 · fork 2")
  })

  it("fork 之 fork：血缘记直接来源，历史随流延续", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const f1 = forkSession({ store: s }, { sourceId: src.id })
    const f2 = forkSession({ store: s }, { sourceId: f1.id, messageId: src.a1 })
    expect(f2.forkedFrom?.sessionId).toBe(f1.id)
    expect(messageIds(s, f2.id)).toEqual([src.u1, src.a1])
  })

  it("投影继承：压缩状态、系统基线、mode/workdir 随重放重建", () => {
    const s = new SessionStore(dir)
    const m = s.create("原会话", undefined, "/w", "default")
    const u1 = newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "第一问" }])
    const a1 = newMessage(m.id, "assistant", [{ id: "blk_2", type: "text", text: "第一答" }])
    s.appendRunStarted(m.id, { at: new Date().toISOString(), trigger: "user" })
    s.appendMessage(m.id, u1)
    s.appendMessage(m.id, a1)
    // system 事件（每 run 一条）落在复制区间内：第一 run 结束前。
    s.appendSystem(m.id, { at: new Date().toISOString(), stable: "STABLE", live: "LIVE" })
    s.appendRunEnded(m.id, { at: new Date().toISOString(), stopReason: "end_turn" })

    const forked = forkSession({ store: s }, { sourceId: m.id, messageId: u1.id })
    const meta = s.meta(forked.id)!
    expect(meta.workdir).toBe("/w")
    expect(meta.mode).toBe("default")
    expect(meta.systemBaseline?.stable.text).toBe("STABLE")
    expect(meta.systemBaseline?.live?.text).toBe("LIVE")
  })

  it("messageId 不存在、源会话不存在、subagent 会话：抛错", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    expect(() => forkSession({ store: s }, { sourceId: src.id, messageId: "msg_nope" })).toThrow()
    expect(() => forkSession({ store: s }, { sourceId: "ses_nope" })).toThrow()
    const child = s.create("子会话", undefined, "/w", "default", src.id)
    expect(() => forkSession({ store: s }, { sourceId: child.id })).toThrow()
  })

  it("messageId 不存在抛 ForkPointNotFoundError（宿主据此映射 400）", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    try {
      forkSession({ store: s }, { sourceId: src.id, messageId: "msg_nope" })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ForkPointNotFoundError)
    }
  })

  it("截断标记随流复制：夹在两轮之间的标记照常带过去，readMessages 过滤语义不变", () => {
    const s = new SessionStore(dir)
    // 重试的真实形态：标记夹在旧 run 结束与新 run 开始之间（重做第一轮）。
    const meta = s.create("原会话", undefined, "/w", "default")
    const u1 = newMessage(meta.id, "user", [{ id: "blk_1", type: "text", text: "第一问" }])
    const a1 = newMessage(meta.id, "assistant", [{ id: "blk_2", type: "text", text: "第一答" }])
    const u2 = newMessage(meta.id, "user", [{ id: "blk_3", type: "text", text: "第二问" }])
    const a2 = newMessage(meta.id, "assistant", [{ id: "blk_4", type: "text", text: "第二答" }])
    s.appendRunStarted(meta.id, { at: new Date().toISOString(), trigger: "user" })
    s.appendMessage(meta.id, u1)
    s.appendMessage(meta.id, a1)
    s.appendRunEnded(meta.id, { at: new Date().toISOString(), stopReason: "end_turn" })
    s.appendMessageTruncated(meta.id, { at: new Date().toISOString(), fromMessageId: u1.id })
    s.appendRunStarted(meta.id, { at: new Date().toISOString(), trigger: "user" })
    s.appendMessage(meta.id, u2)
    s.appendMessage(meta.id, a2)
    s.appendRunEnded(meta.id, { at: new Date().toISOString(), stopReason: "end_turn" })

    const forked = forkSession({ store: s }, { sourceId: meta.id, messageId: a2.id })
    expect(s.readEvents(forked.id).map((e) => e.type)).toContain("message.truncated")
    // 标记前的 u1/a1 被隐藏；标记之后追加的 u2/a2 不受旧起点约束，照常可见。
    expect(s.readMessages(forked.id).map((m) => m.id)).toEqual([u2.id, a2.id])
  })

  it("空会话全量复制：sourceMessageId 省略（无消息可指）", () => {
    const s = new SessionStore(dir)
    const src = s.create("空会话", undefined, "/w", "default")
    const forked = forkSession({ store: s }, { sourceId: src.id })
    const ev = s.readEvents(forked.id).find((e) => e.type === "session.forked")!
    expect(ev.type === "session.forked" && ev.sourceMessageId).toBe(undefined)
    expect(s.meta(forked.id)?.forkedFrom).toEqual({ sessionId: src.id })
  })

  it("附件拷贝失败：会话目录与附件半成品目录都不残留", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const attachmentsDir = join(dir, "attachments")
    // 块引用的源文件不存在 → copyFileSync 抛错。
    const withAtt = newMessage(src.id, "user", [
      { id: "blk_1", type: "attachment", mimeType: "image/png", name: "gone.png", source: { type: "file", path: join(attachmentsDir, src.id, "att_1__gone.png") } },
    ])
    s.appendRunStarted(src.id, { at: new Date().toISOString(), trigger: "user" })
    s.appendMessage(src.id, withAtt)
    s.appendRunEnded(src.id, { at: new Date().toISOString(), stopReason: "end_turn" })
    expect(() => forkSession({ store: s, attachmentsDir }, { sourceId: src.id, messageId: withAtt.id })).toThrow()
    expect(existsSync(join(dir, "sessions", "sessions"))).toBe(false)
    // 新会话目录已清（allMetas 不含成功的新会话）且附件目录无 fork 半成品。
    expect(s.allMetas().filter((m) => m.forkedFrom !== undefined)).toHaveLength(0)
    expect(existsSync(attachmentsDir)).toBe(true) // 源会话附件目录未受伤
    expect(readdirSync(attachmentsDir).filter((d) => d !== src.id)).toHaveLength(0)
  })

  it("记忆进度播种与搜索标记回调：以 fork 点收尾", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const seeded: Array<[string, string]> = []
    const marked: string[] = []
    const forked = forkSession(
      { store: s, seedWatermarks: (sid, mid) => seeded.push([sid, mid]), markSearchBackfilled: (sid) => marked.push(sid) },
      { sourceId: src.id, messageId: src.u1 },
    )
    expect(seeded).toEqual([[forked.id, src.a1]])
    expect(marked).toEqual([forked.id])
  })

  it("附件：拷贝进新会话目录并改写块内绝对路径，原文件保留", () => {
    const s = new SessionStore(dir)
    const src = seedTwoRuns(s)
    const attachmentsDir = join(dir, "attachments")
    mkdirSync(join(attachmentsDir, src.id), { recursive: true })
    const stored = "att_1__pic.png"
    writeFileSync(join(attachmentsDir, src.id, stored), "binary")
    const withAtt = newMessage(src.id, "user", [
      { id: "blk_1", type: "attachment", mimeType: "image/png", name: "pic.png", source: { type: "file", path: join(attachmentsDir, src.id, stored) } },
    ])
    s.appendRunStarted(src.id, { at: new Date().toISOString(), trigger: "user" })
    s.appendMessage(src.id, withAtt)
    s.appendRunEnded(src.id, { at: new Date().toISOString(), stopReason: "end_turn" })

    const forked = forkSession({ store: s, attachmentsDir }, { sourceId: src.id, messageId: withAtt.id })
    const newPath = join(attachmentsDir, forked.id, stored)
    expect(existsSync(newPath)).toBe(true)
    expect(readFileSync(newPath, "utf8")).toBe("binary")
    expect(existsSync(join(attachmentsDir, src.id, stored))).toBe(true)
    const copied = s.readEvents(forked.id).find((e): e is MessageEvent => e.type === "message" && e.id === withAtt.id)!
    const block = copied.blocks[0]! as { source: { path: string } }
    expect(block.source.path).toBe(newPath)
  })
})
