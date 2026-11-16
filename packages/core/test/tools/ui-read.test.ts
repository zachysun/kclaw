import { describe, expect, it } from "vitest"
import { createUiReadToolEntries } from "../../src/tools/ui-read.js"
import type { Message } from "../../src/protocol/messages.js"
import { cardInteractiveNodes, isUiCardData } from "../../src/protocol/ui-cards.js"
import type { Block } from "../../src/protocol/blocks.js"

const entries = createUiReadToolEntries()
const tool = entries[0]!.tool
const call = (args: unknown) => tool.execute(args, { onOutput: () => {} })

/** A tool message carrying one ui_render-style card in its result block. */
function toolMsg(id: string, callId: string, card: unknown): Message {
  const blocks: Block[] = [
    { id: `blk_${id}`, type: "tool_result", callId, status: "ok", output: "已渲染", data: card, durationMs: 1 },
  ]
  return { id, sessionId: "ses_1", role: "tool", blocks, createdAt: "2026-01-01T00:00:00.000Z" }
}

const buttonCard = { kind: "button", label: "方案 A" }
const tableCard = { kind: "table", title: "对比", columns: [{ key: "a", label: "A" }], rows: [{ a: "1" }] }

describe("ui_read tool", () => {
  it("no cards → 固定文案；数据源缺席 → 不可读取文案", async () => {
    const empty = createUiReadToolEntries(() => [])[0]!.tool
    const r = await empty.execute({}, { onOutput: () => {} })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("还没有 UI 卡")

    const absent = createUiReadToolEntries()[0]!.tool
    const r2 = await absent.execute({}, { onOutput: () => {} })
    expect(r2.status).toBe("ok")
    expect(r2.output).toContain("无可读取")
  })

  it("不带 callId 列出最近的卡（callId/类型/标题/消息 id），非交互卡也列", async () => {
    const read = createUiReadToolEntries(() => [
      { id: "msg_1", sessionId: "s", role: "user", blocks: [], createdAt: "t" } as Message,
      toolMsg("msg_2", "call_1", tableCard),
      toolMsg("msg_3", "call_2", buttonCard),
    ])[0]!.tool
    const r = await read.execute({}, { onOutput: () => {} })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("call_1")
    expect(r.output).toContain("call_2")
    expect(r.output).toContain("《对比》")
    expect(r.output).toContain("msg_3")
    // 列表按时间正序（最近的最后）
    expect(r.output.indexOf("call_1")).toBeLessThan(r.output.indexOf("call_2"))
  })

  it("带 callId 返回完整 DSL；找不到时报错并附最近清单", async () => {
    const read = createUiReadToolEntries(() => [toolMsg("msg_1", "call_1", tableCard)])[0]!.tool
    const hit = await read.execute({ callId: "call_1" }, { onOutput: () => {} })
    expect(hit.status).toBe("ok")
    expect(hit.output).toContain(JSON.stringify(tableCard))
    expect(hit.output).toContain("msg_1")

    const miss = await read.execute({ callId: "call_x" }, { onOutput: () => {} })
    expect(miss.status).toBe("error")
    expect(miss.output).toContain("call_x")
    expect(miss.output).toContain("call_1")
  })

  it("只认 tool 消息的 tool_result 块；user/assistant 消息与非卡 data 不列", async () => {
    const read = createUiReadToolEntries(() => [
      { id: "msg_u", sessionId: "s", role: "user", blocks: [{ id: "b1", type: "text", text: "{}" }], createdAt: "t" } as Message,
      toolMsg("msg_t", "call_t", { exitCode: 0 }),
    ])[0]!.tool
    const r = await read.execute({}, { onOutput: () => {} })
    expect(r.output).toContain("还没有 UI 卡")
  })
})

describe("protocol card helpers", () => {
  it("isUiCardData 只认白名单 kind", () => {
    expect(isUiCardData(tableCard)).toBe(true)
    expect(isUiCardData({ kind: "stat", label: "L", value: "1" })).toBe(true)
    expect(isUiCardData({ kind: "widget" })).toBe(false)
    expect(isUiCardData({ exitCode: 0 })).toBe(false)
    expect(isUiCardData(null)).toBe(false)
    expect(isUiCardData([tableCard])).toBe(false)
  })

  it("cardInteractiveNodes 统计容器内外的按钮与表单，chart 不算交互", () => {
    expect(cardInteractiveNodes({ kind: "button", label: "a" })).toEqual({ buttons: 1, forms: 0 })
    expect(cardInteractiveNodes(tableCard)).toEqual({ buttons: 0, forms: 0 })
    expect(cardInteractiveNodes({ kind: "chart", items: [{ label: "a", value: 1 }] })).toEqual({ buttons: 0, forms: 0 })
    const nested = {
      kind: "card",
      body: [
        { kind: "button", label: "批准" },
        { kind: "carousel", slides: [[{ kind: "form", title: "f", fields: [{ kind: "input", name: "a", label: "A" }] }]] },
      ],
    }
    expect(cardInteractiveNodes(nested as never)).toEqual({ buttons: 1, forms: 1 })
    const tabs = {
      kind: "tabs",
      tabs: [
        { label: "一", content: [{ kind: "button", label: "a" }] },
        { label: "二", content: [{ kind: "button", label: "b" }] },
      ],
    }
    expect(cardInteractiveNodes(tabs as never)).toEqual({ buttons: 2, forms: 0 })
  })
})
