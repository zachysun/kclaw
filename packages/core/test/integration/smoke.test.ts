/**
 * Integration smoke: the whole persistence/permission/tool stack wired
 * the way the daemon wires it, on a real temp KCLAW_HOME.
 *
 * SessionStore + MemorySystem + ConfigPermissionGate + createBuiltinTools
 * drive one runAgent turn with a scripted LlmClient that emits a tool_call
 * for `exec {command:"echo hi"}` then a final end_turn. Two scenarios: the
 * whitelist path (allow rule → no confirmation) and the confirmation path
 * (empty allow → confirm → auto-approve). Both assert the granted reason
 * landed on the tool message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as core from "../../src/index.js"
import { runAgent } from "../../src/agent/loop.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import type { Message, ToolMessage } from "../../src/protocol/messages.js"
import { ConfigPermissionGate } from "../../src/permissions/engine.js"
import { SessionStore } from "../../src/session/store.js"
import { MemorySystem } from "../../src/memory/system.js"
import { createBuiltinTools, deriveToolFacts } from "../../src/tools/index.js"
import { loadConfig, saveConfig, resolvePaths } from "../../src/storage/index.js"
import { chainOf } from "../agent/hook-utils.js"

let home: string
let workspace: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-smoke-home-"))
  workspace = mkdtempSync(join(tmpdir(), "kclaw-smoke-ws-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

// --- scripted LlmClient (the scripted-client pattern from test/agent/loop-tools.test.ts) ---

function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]
    },
  }
}

function toolCallStream(idx: number, callId: string, name: string, argsJson: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: idx, callId, name },
    { type: "tool_call_delta", index: idx, delta: argsJson },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const FINAL: LlmStreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
]

describe("integration smoke", () => {
  it("runs a full agent turn over the real storage/permission/tool stack", async () => {
    const paths = resolvePaths(home)

    // config roundtrip: defaults from disk, then a whitelist rule for echo
    const cfg = loadConfig(paths)
    cfg.permissions.allow = ["exec:echo*"]
    cfg.workspace = workspace
    saveConfig(paths, cfg)
    const loaded = loadConfig(paths)
    expect(loaded.permissions.allow).toEqual(["exec:echo*"])

    const sessionStore = new SessionStore(paths.sessionsDir)
    const memory = new MemorySystem({
      memoryDir: paths.memoryDir,
      sessions: sessionStore,
      config: loaded,
      resolveLlm: () => ({ llm: scriptClient([]), model: "test-model" }),
    })
    const { tools, toolDefs } = createBuiltinTools({
      workspace,
      memoryCtx: { system: memory, sessionId: "ses_1", workdir: workspace, immediateEnabled: false },
      tavilyApiKey: "test-key",
    })

    const session = sessionStore.create("冒烟会话")
    // 生产装配（run-assembly）会传 safeTools 与注册事实表——这里同构地传，
    // exec 的 echo* 白名单才能按 command 语义命中（issue #9 的事实派生）。
    const gate = new ConfigPermissionGate(loaded.permissions, { toolFacts: deriveToolFacts(tools, toolDefs) })

    const events: AgentEvent[] = []
    const onMessage = (m: Message) => sessionStore.appendMessage(session.id, m)

    const outcome = await runAgent(
      { sessionId: session.id, history: [], system: "", userText: "run echo hi" },
      {
        llm: scriptClient([
          toolCallStream(0, "call_1", "exec", '{"command":"echo hi"}'),
          FINAL,
        ]),
        model: "test-model",
        tools,
        toolDefs,
        permissions: gate,
        // auto-approve any confirmation (never reached on the whitelist path)
        resolveConfirmation: async () => ({ decision: "once" as const, by: "cli" as const }),
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage,
      },
    )

    // 1) run finished cleanly and the tool actually executed
    expect(outcome.stopReason).toBe("end_turn")
    const persisted = sessionStore.readMessages(session.id)
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolResult = persisted[2]!.blocks[0] as { type: string; status: string; output: string }
    expect(toolResult).toMatchObject({ type: "tool_result", status: "ok" })
    expect(toolResult.output).toContain("hi")

    // 2) the granted reason landed on the tool message (whitelisted exec call)
    expect((persisted[2] as ToolMessage).grantedBy).toEqual({ call_1: "whitelist" })

    // 3) event sequence ends with run.completed
    expect(events[events.length - 1]!.type).toBe("run.completed")

    // 4) memory notes dir untouched by the run (no note files created)
    const noteFiles = readdirSync(paths.memoryNotesDir).filter((f) => f.endsWith(".md"))
    expect(noteFiles).toEqual([])
  })

  it("routes an unlisted tool call through confirmation and records it as confirmed", async () => {
    const paths = resolvePaths(home)

    // defaults on disk: allow is EMPTY (deny only carries the blacklist), so
    // exec {command:"echo hi"} falls through to confirm, not whitelist
    const cfg = loadConfig(paths)
    cfg.workspace = workspace
    saveConfig(paths, cfg)
    const loaded = loadConfig(paths)
    expect(loaded.permissions.allow).toEqual([])

    const sessionStore = new SessionStore(paths.sessionsDir)
    const memory = new MemorySystem({
      memoryDir: paths.memoryDir,
      sessions: sessionStore,
      config: loaded,
      resolveLlm: () => ({ llm: scriptClient([]), model: "test-model" }),
    })
    const { tools, toolDefs } = createBuiltinTools({
      workspace,
      memoryCtx: { system: memory, sessionId: "ses_1", workdir: workspace, immediateEnabled: false },
      tavilyApiKey: "test-key",
    })

    const session = sessionStore.create("确认会话")
    // 生产装配（run-assembly）会传 safeTools 与注册事实表——这里同构地传，
    // exec 的 echo* 白名单才能按 command 语义命中（issue #9 的事实派生）。
    const gate = new ConfigPermissionGate(loaded.permissions, { toolFacts: deriveToolFacts(tools, toolDefs) })

    const events: AgentEvent[] = []
    const onMessage = (m: Message) => sessionStore.appendMessage(session.id, m)

    const outcome = await runAgent(
      { sessionId: session.id, history: [], system: "", userText: "run echo hi" },
      {
        llm: scriptClient([
          toolCallStream(0, "call_1", "exec", '{"command":"echo hi"}'),
          FINAL,
        ]),
        model: "test-model",
        tools,
        toolDefs,
        permissions: gate,
        // the human says yes: grantedBy "confirmed" lands on the tool message
        resolveConfirmation: async () => ({ decision: "once" as const, by: "cli" as const }),
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage,
      },
    )

    // 1) run finished cleanly and the confirmed tool actually executed
    expect(outcome.stopReason).toBe("end_turn")
    const persisted = sessionStore.readMessages(session.id)
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolResult = persisted[2]!.blocks[0] as { type: string; status: string; output: string }
    expect(toolResult).toMatchObject({ type: "tool_result", status: "ok" })
    expect(toolResult.output).toContain("hi")

    // 2) the tool message carries the confirmed granted reason
    expect((persisted[2] as ToolMessage).grantedBy).toEqual({ call_1: "confirmed" })

    // 3) the confirmation round-trip is visible and well-ordered in events
    const requested = events.find((e) => e.type === "confirmation.requested") as
      | Extract<AgentEvent, { type: "confirmation.requested" }>
      | undefined
    const resolved = events.find((e) => e.type === "confirmation.resolved") as
      | Extract<AgentEvent, { type: "confirmation.resolved" }>
      | undefined
    expect(requested).toBeDefined()
    expect(requested!.payload.toolCall).toMatchObject({ name: "exec" })
    expect(requested!.payload.risk).toBe("sensitive")
    expect(resolved).toBeDefined()
    expect(resolved!.payload).toMatchObject({ decision: "once", by: "cli" })
    expect(resolved!.payload.confirmationId).toBe(requested!.payload.confirmationId)
    const idx = (t: string) => events.findIndex((e) => e.type === t)
    expect(idx("confirmation.requested")).toBeLessThan(idx("confirmation.resolved"))
    expect(idx("confirmation.resolved")).toBeLessThan(idx("tool_result.created"))
    expect(events[events.length - 1]!.type).toBe("run.completed")
  })

  it("exposes the public surface from the package barrel", () => {
    for (const name of [
      "SessionStore", "MemorySystem", "JobScheduler",
      "ConfigPermissionGate", "createBuiltinTools", "createExecTool",
      "createFsTools", "createWebTools", "createMemoryTools",
      "resolvePaths", "loadConfig", "saveConfig", "runAgent",
    ] as const) {
      expect(core[name], `export ${name}`).toBeTruthy()
    }
    // GrantedBy is a type carried by the barrel via protocol/messages.ts.
    const grantedBy: core.GrantedBy = "safe"
    expect(grantedBy).toBe("safe")
  })
})
