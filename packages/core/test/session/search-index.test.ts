/**
 * The cross-session message full-text index: CJK/ASCII recall, raw-text
 * display, truncation mirroring, purge removal, idempotent backfill.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HistorySearchIndex } from "../../src/session/search-index.js"
import { newMessage } from "../../src/protocol/messages.js"
import { newBlockId } from "../../src/protocol/blocks.js"
import type { Message } from "../../src/protocol/messages.js"

let home: string
let index: HistorySearchIndex
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-hsearch-"))
  index = HistorySearchIndex.open(join(home, "search.db"))
})
afterEach(() => {
  index.close()
  rmSync(home, { recursive: true, force: true })
})

/** A text message in the store's shape (fixed ids where truncation tests need them). */
function msg(id: string, role: "user" | "assistant", text: string): Message {
  const m = newMessage("ses_x", role, [{ id: newBlockId(), type: "text", text }])
  return { ...m, id } as Message
}

describe("HistorySearchIndex", () => {
  it("records and recalls messages across sessions, CJK and ASCII, returning raw text", () => {
    index.recordMessage("ses_a", msg("m1", "user", "上次是怎么修复登录重定向问题的"))
    index.recordMessage("ses_a", msg("m2", "assistant", "修改了 auth.ts 里的 redirect 逻辑"))
    index.recordMessage("ses_b", msg("m3", "user", "把 compress 流程改成增量"))

    const hits = index.search("登录重定向")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.sessionId).toBe("ses_a")
    // raw 列原文展示，不是分词结果
    expect(hits[0]!.text).toContain("上次是怎么修复登录重定向问题的")

    const ascii = index.search("redirect 逻辑")
    expect(ascii.map((h) => h.text)).toContain("修改了 auth.ts 里的 redirect 逻辑")
  })

  it("returns nothing for empty queries and respects the limit", () => {
    for (let i = 0; i < 8; i++) index.recordMessage("ses_a", msg(`m${i}`, "user", `占位消息 ${i} keyword`))
    expect(index.search("   ")).toEqual([])
    expect(index.search("keyword", 3)).toHaveLength(3)
  })

  it("truncation mirrors the view: rows from the marker id drop; missing id drops the session tail", () => {
    index.recordMessage("ses_a", msg("m1", "user", "第一次讨论的内容"))
    index.recordMessage("ses_a", msg("m2", "user", "第二轮的展开"))
    index.recordMessage("ses_a", msg("m3", "user", "被编辑重试的旧答案 stale"))
    index.recordMessage("ses_a", msg("m4", "assistant", "stale 的后续"))

    index.recordTruncation("ses_a", "m3")
    expect(index.search("被编辑重试的旧答案")).toHaveLength(0)
    expect(index.search("stale")).toHaveLength(0)
    expect(index.search("第一次讨论的内容")).toHaveLength(1)

    // from id 不在索引里（理论竞态）：保守清空该会话，绝不留陈旧行
    index.recordMessage("ses_b", msg("m9", "user", "b会话特有的保留行"))
    index.recordTruncation("ses_b", "msg_absent")
    expect(index.search("b会话特有的保留行")).toHaveLength(0)
  })

  it("removeSession drops rows and the backfilled marker (purge support)", () => {
    index.recordMessage("ses_a", msg("m1", "user", "待清除的消息"))
    index.backfill([{ sessionId: "ses_a", messages: [msg("m2", "user", "回填的消息")] }])
    index.removeSession("ses_a")
    expect(index.search("待清除的消息")).toHaveLength(0)
    expect(index.search("回填的消息")).toHaveLength(0)
  })

  it("backfill indexes only untracked sessions, replaces their rows (no duplicates), and is idempotent", () => {
    index.recordMessage("ses_a", msg("live1", "user", "live 行先到索引"))
    // ses_a 从未回填：整段替换——先到的行不会产生重复
    index.backfill([
      { sessionId: "ses_a", messages: [msg("live1", "user", "live 行先到索引"), msg("old1", "user", "cold 档案补录行")] },
      { sessionId: "ses_b", messages: [msg("old2", "user", "warm 另一会话补录行")] },
    ])
    expect(index.search("live")).toHaveLength(1)
    expect(index.search("cold")).toHaveLength(1)
    // 已回填的会话跳过：第二次 backfill 零写入
    const again = index.backfill([{ sessionId: "ses_b", messages: [msg("old2", "user", "warm 另一会话补录行")] }])
    expect(again).toBe(0)
    expect(index.search("warm")).toHaveLength(1)
  })

  it("tool messages and empty-text messages are not indexed", () => {
    const toolMsg = newMessage("ses_a", "tool", [{ id: newBlockId(), type: "tool_result", callId: "c1", status: "ok", output: "大量工具输出", durationMs: 1 }])
    index.recordMessage("ses_a", toolMsg)
    index.recordMessage("ses_a", msg("m_text", "user", "正常文本"))
    expect(index.search("大量工具输出")).toHaveLength(0)
    expect(index.search("正常文本")).toHaveLength(1)
  })
})
