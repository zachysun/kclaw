/** 出站剥离器：system-reminder 注入标记绝不上飞书（#45 测试决策：只断言可见行为）。 */
import { describe, it, expect } from "vitest"
import { stripOutboundText } from "../../src/feishu/strip.js"

describe("stripOutboundText", () => {
  it("removes closed system-reminder blocks", () => {
    const src = '开头<system-reminder kind="memory">内部注入</system-reminder>结尾'
    expect(stripOutboundText(src)).toBe("开头结尾")
  })

  it("removes a dangling opener to the end of the text", () => {
    expect(stripOutboundText("回答正文\n<system-reminder kind=\"note\">被截断的注入")).toBe("回答正文\n")
  })

  it("removes every occurrence", () => {
    const src = "<system-reminder>a</system-reminder>中<system-reminder>b</system-reminder>尾"
    expect(stripOutboundText(src)).toBe("中尾")
  })

  it("leaves ordinary text alone (including stray angle brackets)", () => {
    const src = "a < b 且 c > d，普通 <tag> 文本"
    expect(stripOutboundText(src)).toBe(src)
  })
})
