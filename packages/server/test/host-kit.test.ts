/**
 * host-kit 纯函数测试：dailyGateDue（每日过点门禁，skill curator 与记忆
 * 夜间内化共用）。时刻判定、本地日期判重、负 hour 关闭三个决策全部钉死，
 * Date 用本地时区构造（判重键 = 本地日期，与时区无关）。
 */
import { describe, expect, it } from "vitest"
import { dailyGateDue, localDate } from "../src/host-kit.js"

describe("dailyGateDue", () => {
  it("过了 hour 且今天未跑 → due", () => {
    // 用本地时间构造：4:05 过了 4 点的门
    const t = new Date(2026, 9, 4, 4, 5)
    expect(dailyGateDue(t, 4, undefined)).toBe(true)
  })

  it("没到 hour → 不 due（等于 hour 即过点）", () => {
    expect(dailyGateDue(new Date(2026, 9, 4, 3, 59), 4, undefined)).toBe(false)
    expect(dailyGateDue(new Date(2026, 9, 4, 4, 0), 4, undefined)).toBe(true)
  })

  it("今天已跑（判重键=本地日期）→ 不 due；昨天跑过 → due", () => {
    const t = new Date(2026, 9, 4, 12, 0)
    expect(dailyGateDue(t, 4, localDate(t))).toBe(false)
    expect(dailyGateDue(t, 4, localDate(new Date(2026, 9, 3, 12, 0)))).toBe(true)
  })

  it("hour 负值 = 关闭（与各宿主原先的关闭写法等价）", () => {
    expect(dailyGateDue(new Date(2026, 9, 4, 23, 0), -1, undefined)).toBe(false)
  })
})
