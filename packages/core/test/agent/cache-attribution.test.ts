import { describe, it, expect } from "vitest"
import { diffFingerprints, fingerprintAssembled } from "../../src/agent/cache-attribution.js"
import type { ProviderMessage, ToolDefinition } from "../../src/provider/types.js"

const TOOL_A: ToolDefinition = { name: "reader", description: "reads", parameters: { type: "object", properties: {} } }
const TOOL_B: ToolDefinition = { name: "writer", description: "writes", parameters: { type: "object", properties: {} } }

const msg = (role: "user" | "assistant" | "tool", text: string): ProviderMessage =>
  role === "assistant"
    ? { role: "assistant", content: text === "" ? null : text }
    : role === "tool"
      ? { role: "tool", toolCallId: "c1", content: text }
      : { role: "user", content: text }

describe("fingerprintAssembled / diffFingerprints（缓存归因）", () => {
  const fpOf = (tools: ToolDefinition[], system: string, msgs: ProviderMessage[]): string =>
    fingerprintAssembled(system, msgs, tools)

  it("纯追加（上次是本次的真前缀）→ null：前缀应命中，无需归因", () => {
    const prev = fpOf([TOOL_A], "S", [msg("user", "a"), msg("assistant", "b")])
    const next = fpOf([TOOL_A], "S", [msg("user", "a"), msg("assistant", "b"), msg("user", "c")])
    expect(diffFingerprints(prev, next)).toBeNull()
  })

  it("tools 集合变化 → tools_changed", () => {
    const prev = fpOf([TOOL_A], "S", [msg("user", "a")])
    const next = fpOf([TOOL_A, TOOL_B], "S", [msg("user", "a")])
    expect(diffFingerprints(prev, next)?.reasons).toEqual(["tools_changed"])
  })

  it("system 变化 → system_changed", () => {
    const prev = fpOf([TOOL_A], "S1", [msg("user", "a")])
    const next = fpOf([TOOL_A], "S2", [msg("user", "a")])
    expect(diffFingerprints(prev, next)?.reasons).toEqual(["system_changed"])
  })

  it("窗口滑动 / 压缩生效：头部重建 → history_rebuilt", () => {
    const prev = fpOf([TOOL_A], "S", [msg("user", "a"), msg("assistant", "b"), msg("user", "c")])
    const next = fpOf([TOOL_A], "S", [msg("assistant", "b"), msg("user", "c")])
    const d = diffFingerprints(prev, next)
    expect(d?.reasons).toEqual(["history_rebuilt"])
    expect(d?.divergedAt).toBe(1)
  })

  it("中间消息字节变化（包装断裂）→ history_diverged + 序号与两端摘录", () => {
    const prev = fpOf([TOOL_A], "S", [msg("user", "a"), msg("user", "@file 包装后的文本"), msg("assistant", "ok")])
    const next = fpOf([TOOL_A], "S", [msg("user", "a"), msg("user", "@file 原文"), msg("assistant", "ok")])
    const d = diffFingerprints(prev, next)
    expect(d?.reasons).toEqual(["history_diverged"])
    expect(d?.divergedAt).toBe(2)
    expect(d?.prevHead).toContain("包装后的文本")
    expect(d?.nextHead).toContain("原文")
  })

  it("损坏的快照 JSON → null（归因绝不妨碍 run）", () => {
    const next = fpOf([TOOL_A], "S", [msg("user", "a")])
    expect(diffFingerprints("{broken", next)).toBeNull()
  })

  it("同指纹 → null（重复请求）", () => {
    const prev = fpOf([TOOL_A], "S", [msg("user", "a")])
    expect(diffFingerprints(prev, prev)).toBeNull()
  })

  it("空工具集与空消息也稳定成指纹", () => {
    const fp = fpOf([], "", [])
    expect(JSON.parse(fp)).toMatchObject({ s: expect.any(String), t: expect.any(String), m: [] })
  })
})
