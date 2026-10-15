/**
 * 时间戳格式化收敛测试：usage/format.ts 是全站唯一的 ISO/epoch → 本地短
 * 格式实现（此前五份副本分散在各视图）。所有断言用本地 Date 算术构造输入
 * （时区无关），`now` 走注入参数固定，不依赖真实时钟（午夜竞态归零）。
 */
import { describe, expect, it } from "vitest"
import { formatCompactStamp, formatStamp } from "../../src/usage/format.js"

/** 用本地时区分量构造确定性输入：toISOString 回写 UTC，formatX 解析回本地。 */
function isoOf(...parts: [y: number, m: number, d: number, hh: number, mm: number]): string {
  return new Date(parts[0], parts[1]! - 1, parts[2], parts[3], parts[4]).toISOString()
}

describe("formatStamp（YYYY-MM-DD HH:mm）", () => {
  it("本地时区输出年月日时分", () => {
    expect(formatStamp(isoOf(2026, 10, 15, 9, 5))).toBe("2026-10-15 09:05")
  })

  it("无法解析的输入原样返回", () => {
    expect(formatStamp("not-a-date")).toBe("not-a-date")
  })
})

describe("formatCompactStamp（列表紧凑戳）", () => {
  const now = new Date(2026, 9, 15, 18, 0) // 2026-10-15 18:00 本地

  it("今天 → HH:mm", () => {
    expect(formatCompactStamp(isoOf(2026, 10, 15, 9, 5), now)).toBe("09:05")
  })

  it("今年非今天 → MM/DD HH:mm", () => {
    expect(formatCompactStamp(isoOf(2026, 3, 2, 14, 30), now)).toBe("03/02 14:30")
  })

  it("往年 → YYYY/MM/DD HH:mm", () => {
    expect(formatCompactStamp(isoOf(2025, 12, 31, 23, 59), now)).toBe("2025/12/31 23:59")
  })

  it("epoch 毫秒输入（IM Channel 待发名单）走同一格式", () => {
    const ms = new Date(2026, 9, 15, 8, 1).getTime()
    expect(formatCompactStamp(ms, now)).toBe("08:01")
  })

  it("无法解析的字符串原样返回", () => {
    expect(formatCompactStamp("garbage", now)).toBe("garbage")
  })
})
