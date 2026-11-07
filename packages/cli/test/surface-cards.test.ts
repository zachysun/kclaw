/**
 * surface-cards 单测：卡片语义正本（四选项、裁决行、自动应答行）逐字钉住，
 * 两表面与 run 渲染都从这里取——任何一处文案改动必须过这里。
 */
import { describe, expect, it } from "vitest"
import { AUTO_CONFIRM_VERDICTS, CONFIRM_OPTIONS, CONFIRM_VERDICT_LABELS } from "../src/surface-cards.js"

describe("confirmation card semantics (single source)", () => {
  it("offers exactly the four verdicts in strictest-first display order", () => {
    expect(CONFIRM_OPTIONS.map((o) => o.value)).toEqual(["once", "project", "global", "reject"])
    expect(CONFIRM_OPTIONS.map((o) => o.label)).toEqual(["允许（仅本次）", "总是允许（本项目）", "总是允许（全局）", "拒绝"])
  })

  it("labels every possible verdict notice", () => {
    expect(Object.keys(CONFIRM_VERDICT_LABELS).sort()).toEqual(["global", "once", "project", "reject"])
    expect(CONFIRM_VERDICT_LABELS.once).toBe("已允许（仅本次）")
    expect(CONFIRM_VERDICT_LABELS.reject).toBe("已拒绝")
  })

  it("pins the unattended verdict lines shared by chat and kclaw run", () => {
    expect(AUTO_CONFIRM_VERDICTS.yes).toBe("[--yes] 已自动允许（仅本次）")
    expect(AUTO_CONFIRM_VERDICTS.no).toBe("[--no] 已自动拒绝")
    expect(AUTO_CONFIRM_VERDICTS.default).toBe("已自动拒绝（未指定 --yes）")
  })
})

