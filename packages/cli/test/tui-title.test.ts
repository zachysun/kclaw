/**
 * Terminal title sanitization unit tests (spec B13, codex terminal_title.rs
 * 四件套)：标题内容含模型输出与会话名，属不可信文本——控制字符、双向与不可见
 * 格式码点必须剔除，空白归一，240 字上限；GNU Screen（STY）下整体降级可打印
 * ASCII。写入函数本身在非 TTY 下静默跳过（测试环境即如此），这里测纯函数。
 */
import { describe, expect, it } from "vitest"
import { sanitizeTitle } from "../src/tui/title.js"

describe("sanitizeTitle", () => {
  it("strips control characters (C0 and C1); the printable payload of a broken escape stays plain text", () => {
    // ESC/BEL/CSI 本身剔除；标题是窗口管理器渲染的纯文本，OSC 载荷里不会再
    // 解析转义序列，剩余的 "[31m" 按普通文本保留（codex terminal_title 同语义）。
    expect(sanitizeTitle("ab\x07cd\x1b[31mef\x9b")).toBe("abcd[31mef")
  })

  it("strips bidi overrides and invisible formatting codepoints (Trojan Source family)", () => {
    expect(sanitizeTitle("good\u202Eretnec\u202Dname")).toBe("goodretnecname")
  })

  it("strips zero-width and direction marks", () => {
    expect(sanitizeTitle("a\u200bb\u200cc\u061cd\ufeffe\u2060f")).toBe("abcdef")
  })

  it("collapses whitespace runs and trims", () => {
    expect(sanitizeTitle("  a \t b\nc  ")).toBe("a b c")
  })

  it("caps at 240 characters", () => {
    expect(sanitizeTitle("x".repeat(500)).length).toBe(240)
  })

  it("keeps ordinary CJK and ASCII titles verbatim", () => {
    expect(sanitizeTitle("kclaw · 会话：修复登录")).toBe("kclaw · 会话：修复登录")
  })
})
