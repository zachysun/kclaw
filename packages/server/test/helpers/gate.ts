import type { LlmClient, LlmStreamEvent } from "@kclaw/core"

export interface Gate {
  /** 工具 executor 已开始执行（测试 await 它确认 run 已进入工具批次）。 */
  readonly toolEntered: Promise<void>
  /** 放行工具 executor（测试调用；此前工具停在执行中）。 */
  releaseTool(): void
  /** 后续 llm.stream 等待的闸门（配合 gateLlm 的 gateLaterCalls）。 */
  waitForLlm(): Promise<void>
  releaseLlm(): void
  /** executor 面：进入时报到（resolve toolEntered）。 */
  notifyEntered(): void
  /** executor 面：等待 releaseTool 才继续。 */
  waitForToolRelease(): Promise<void>
}

/** 一个门闩两个视角：测试面（toolEntered/releaseTool/releaseLlm）+ executor 面。 */
export function makeGate(): Gate {
  let notifyEntered!: () => void
  let openTool!: () => void
  let openLlm!: () => void
  const toolEntered = new Promise<void>((r) => (notifyEntered = r))
  const toolOpen = new Promise<void>((r) => (openTool = r))
  const llmOpen = new Promise<void>((r) => (openLlm = r))
  return {
    toolEntered,
    releaseTool: () => openTool(),
    waitForLlm: () => llmOpen,
    releaseLlm: () => openLlm(),
    notifyEntered,
    waitForToolRelease: () => toolOpen,
  }
}

/** 第一轮 tool_use（工具名 gate），此后每轮先等 gate.releaseLlm 再 end_turn。 */
export function gateLlm(gate: Gate, gateLaterCalls: boolean): LlmClient {
  let call = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      call += 1
      if (call === 1) {
        yield { type: "tool_call_started", index: 0, callId: "c1", name: "gate" }
        yield { type: "tool_call_delta", index: 0, delta: "{}" }
        yield { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }
        return
      }
      if (gateLaterCalls) await gate.waitForLlm()
      yield { type: "text_delta", delta: "done" }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

/** 进入即报到、等 releaseTool 才返回的工具 executor。 */
export function gateTool(gate: Gate) {
  return {
    name: "gate", risk: "safe" as const, concurrency: "parallel" as const,
    async execute() {
      gate.notifyEntered()
      await gate.waitForToolRelease()
      return { status: "ok" as const, output: "" }
    },
  }
}
