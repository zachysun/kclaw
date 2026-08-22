import { describe, it, expect } from "vitest"
import { newId } from "../../src/protocol/ids.js"
import { isBlockType, type Block } from "../../src/protocol/blocks.js"

describe("newId", () => {
  it("prefixes ulid", () => {
    const id = newId("msg")
    expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
  })
  it("generates monotonic ids", () => {
    expect(newId("blk") < newId("blk")).toBe(true)
  })
})

describe("isBlockType", () => {
  it("narrows by type field", () => {
    const b = { id: newId("blk"), type: "text", text: "hi" }
    expect(isBlockType("text", b)).toBe(true)
    expect(isBlockType("thinking", b)).toBe(false)
    const wrong = { id: newId("blk"), type: "nope" }
    expect(isBlockType("text", wrong)).toBe(false)
  })
})
