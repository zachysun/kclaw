import { describe, expect, it } from "vitest"
import { isContextOverflowError } from "../../src/provider/overflow.js"

describe("isContextOverflowError", () => {
  it("识别常见超限文案", () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 131072 tokens"))).toBe(true)
    expect(isContextOverflowError(new Error("prompt is too long: 200000 tokens > 128000 maximum"))).toBe(true)
    expect(isContextOverflowError(new Error("上下文长度超出限制"))).toBe(true)
  })
  it("不误伤普通错误", () => {
    expect(isContextOverflowError(new Error("401 unauthorized"))).toBe(false)
    expect(isContextOverflowError(new Error("network timeout"))).toBe(false)
  })
})
