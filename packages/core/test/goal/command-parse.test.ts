/**
 * /goal 参数解析接缝测试（issue #47）：双端共用 parseGoalCommandArgs——
 * 动作子命令优先、verify: 分隔验收命令区、空参数返回 empty。
 */
import { describe, it, expect } from "vitest"
import { parseGoalCommandArgs } from "../../src/commands.js"

describe("parseGoalCommandArgs", () => {
  it("empty args → empty (status hint)", () => {
    expect(parseGoalCommandArgs("")).toEqual({ kind: "empty" })
    expect(parseGoalCommandArgs("   ")).toEqual({ kind: "empty" })
  })

  it("action keywords win over goal text", () => {
    expect(parseGoalCommandArgs("stop")).toEqual({ kind: "action", action: "stop" })
    expect(parseGoalCommandArgs("status")).toEqual({ kind: "action", action: "status" })
    expect(parseGoalCommandArgs("pause")).toEqual({ kind: "action", action: "pause" })
    expect(parseGoalCommandArgs("resume")).toEqual({ kind: "action", action: "resume" })
    expect(parseGoalCommandArgs("clear")).toEqual({ kind: "action", action: "clear" })
  })

  it("plain text is the goal description with no acceptance", () => {
    expect(parseGoalCommandArgs("让 packages/core 的测试全部通过")).toEqual({
      kind: "set",
      text: "让 packages/core 的测试全部通过",
      acceptance: [],
    })
  })

  it("the first standalone verify: starts the acceptance section", () => {
    expect(parseGoalCommandArgs("测试全过 verify: pnpm test")).toEqual({
      kind: "set",
      text: "测试全过",
      acceptance: ["pnpm test"],
    })
  })

  it("each later verify: splits another acceptance command", () => {
    expect(parseGoalCommandArgs("修好构建 verify: pnpm build verify: pnpm test --filter core")).toEqual({
      kind: "set",
      text: "修好构建",
      acceptance: ["pnpm build", "pnpm test --filter core"],
    })
  })

  it("a verify: inside a sentence word (not standalone) stays part of the text", () => {
    expect(parseGoalCommandArgs("检查 verifier: none 配置")).toEqual({
      kind: "set",
      text: "检查 verifier: none 配置",
      acceptance: [],
    })
  })

  it("trailing verify with empty command is dropped", () => {
    expect(parseGoalCommandArgs("目标描述 verify:")).toEqual({
      kind: "set",
      text: "目标描述",
      acceptance: [],
    })
  })

  it("text starting WITH verify is still a set (empty text is rejected by the host, not here)", () => {
    expect(parseGoalCommandArgs("verify: pnpm test")).toEqual({ kind: "set", text: "", acceptance: ["pnpm test"] })
  })
})
