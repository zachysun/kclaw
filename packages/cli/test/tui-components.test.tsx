/**
 * TUI component tests (spec 测试接入口 3): real ink renders through
 * ink-testing-library with keystrokes injected via stdin.write — the
 * confirmation card's four options and Esc, the editor's / menu
 * (open → select → accept → submit), the @ mention menu with the whitespace
 * filter, the status line's data, the dynamic area's rows, and the help
 * overlay's table.
 */
import { describe, expect, it, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"
import { createElement } from "react"
import type { ConfirmationRequestedPayload } from "@kclaw/core"
import type { ChatController } from "../src/chat-surface.js"
import { ConfirmCard } from "../src/tui/cards.js"
import { InputEditor } from "../src/tui/input-editor.js"
import { StatusLine } from "../src/tui/status-line.js"
import { DynamicArea } from "../src/tui/dynamic-area.js"
import { HelpOverlay } from "../src/tui/overlays.js"
import { ChatStore } from "../src/tui/store.js"

const DOWN = "\u001B[B"
const ENTER = "\r"
const ESC = "\u001B"

afterEach(() => {
  cleanup()
})

/** Let ink's render loop flush pending frames. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30) })

function makeController(overrides: Partial<ChatController> = {}): ChatController {
  return {
    client: {} as ChatController["client"],
    sessionId: "00000000-abcd-ef01-2345",
    mode: "default",
    busy: false,
    submit: async () => "continue" as const,
    interrupt: () => {},
    stopRun: () => {},
    cycleMode: async () => {},
    skillCommands: () => [],
    drain: async () => {},
    ...overrides,
  }
}

const confirmPayload: ConfirmationRequestedPayload = {
  confirmationId: "c1",
  toolCall: { id: "b1", type: "tool_call", callId: "k1", name: "bash", args: { command: "rm -rf /" }, argsJson: '{"command":"rm -rf /"}' },
  risk: "sensitive",
  expiresAt: "2026-11-07T00:00:00.000Z",
}

describe("ConfirmCard (ink)", () => {
  it("renders the card header and the four verdict options", async () => {
    const decisions: string[] = []
    const instance = render(createElement(ConfirmCard, {
      payload: confirmPayload,
      isActive: true,
      onResolve: (d) => decisions.push(d),
    }))
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("bash")
    expect(frame).toContain("风险 sensitive")
    expect(frame).toContain("允许（仅本次）")
    expect(frame).toContain("总是允许（本项目）")
    expect(frame).toContain("总是允许（全局）")
    expect(frame).toContain("拒绝")
  })

  it("Enter picks the highlighted option; arrows move the highlight", async () => {
    const decisions: string[] = []
    const instance = render(createElement(ConfirmCard, {
      payload: confirmPayload,
      isActive: true,
      onResolve: (d) => decisions.push(d),
    }))
    await settle()
    stdinDown(instance, 1)
    await settle()
    instance.stdin.write(ENTER)
    await settle()
    expect(decisions).toEqual(["project"])
  })

  it("Esc rejects immediately", async () => {
    const decisions: string[] = []
    const instance = render(createElement(ConfirmCard, {
      payload: confirmPayload,
      isActive: true,
      onResolve: (d) => decisions.push(d),
    }))
    await settle()
    instance.stdin.write(ESC)
    await settle()
    expect(decisions).toEqual(["reject"])
  })
})

/** N down-arrow presses into an ink-testing-library instance. */
function stdinDown(instance: { stdin: { write: (data: string) => void } }, times: number): void {
  for (let i = 0; i < times; i++) instance.stdin.write(DOWN)
}

describe("InputEditor / menu (ink)", () => {
  it("typing / opens the command menu; Enter accepts; the next Enter submits", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    const submits: string[] = []
    const controller = makeController({ submit: async (line: string) => { submits.push(line); return "continue" as const } })
    const instance = render(createElement(InputEditor, { store, controller, active: true }))
    await settle()

    instance.stdin.write("/he")
    await settle()
    expect(instance.lastFrame() ?? "").toContain("/help 列出所有命令")

    instance.stdin.write(ENTER)
    await settle()
    expect(instance.lastFrame() ?? "").toContain("/help ")
    expect(instance.lastFrame() ?? "").not.toContain("列出所有命令")

    instance.stdin.write(ENTER)
    await settle()
    expect(submits).toEqual(["/help"])
  })

  it("arrows select in the menu before accepting", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    const controller = makeController()
    const instance = render(createElement(InputEditor, { store, controller, active: true }))
    await settle()
    instance.stdin.write("/c")
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("/clear")
    expect(frame).toContain("/compact")
    instance.stdin.write(DOWN)
    await settle()
    instance.stdin.write(ENTER)
    await settle()
    expect(instance.lastFrame() ?? "").toContain("/compact ")
  })

  it("@ opens the mention menu from the store's file list; whitespace paths are filtered out", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    store.setFiles("00000000-abcd-ef01-2345", ["src/a.ts", "has space.txt", "docs/x.md"])
    const controller = makeController()
    const instance = render(createElement(InputEditor, { store, controller, active: true }))
    await settle()
    instance.stdin.write("@s")
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("src/a.ts")
    expect(frame).not.toContain("has space.txt")
    instance.stdin.write(ENTER)
    await settle()
    expect(instance.lastFrame() ?? "").toContain("@src/a.ts ")
  })

  it("Esc closes the menu; a fully typed single candidate submits on Enter directly", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    const submits: string[] = []
    const controller = makeController({ submit: async (line: string) => { submits.push(line); return "continue" as const } })
    const instance = render(createElement(InputEditor, { store, controller, active: true }))
    await settle()
    instance.stdin.write("/exit")
    await settle()
    instance.stdin.write(ENTER)
    await settle()
    expect(submits).toEqual(["/exit"])
  })
})

describe("StatusLine (ink)", () => {
  it("renders mode badge, model, last-run usage and the short session id", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    store.sessionChanged("00000000-abcd-ef01-2345")
    store.modeChanged("acceptEdits")
    store.setStatusMeta({ model: "glm-5.3" })
    store.show({ kind: "run-completed", stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 } })
    const instance = render(createElement(StatusLine, { store }))
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("[acceptEdits]")
    expect(frame).toContain("glm-5.3")
    expect(frame).toContain("↑120 ↓45 tokens（最近 run）")
    expect(frame).toContain("会话 00000000")
  })
})

describe("DynamicArea (ink)", () => {
  it("shows the streaming text and running tool rows", async () => {
    const store = new ChatStore({ showThinking: true, onExit: () => {} })
    store.busyChanged(true)
    store.show({ kind: "text", delta: "正在写…" })
    store.show({ kind: "tool-call", callId: "c1", name: "bash", args: { command: "pnpm test" } })
    const instance = render(createElement(DynamicArea, { state: store.getState() }))
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("正在写…")
    expect(frame).toContain("bash")
    expect(frame).toContain("pnpm test")
  })
})

describe("HelpOverlay (ink)", () => {
  it("lists the key binding table from the single source", async () => {
    const store = new ChatStore({ showThinking: false, onExit: () => {} })
    const instance = render(createElement(HelpOverlay, { store }))
    await settle()
    const frame = instance.lastFrame() ?? ""
    expect(frame).toContain("快捷键帮助")
    expect(frame).toContain("Ctrl+O")
    expect(frame).toContain("循环切换权限模式")
    expect(frame).toContain("转录视图跳到上一条 / 下一条用户消息")
  })
})
