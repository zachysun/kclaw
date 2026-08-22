/**
 * Slash-command registry unit tests (v2 Phase 2, Task 2.1). Covers `dispatch`
 * parsing, the ACTUAL `run()` behaviour of the `new` / `sessions` commands,
 * and the unknown-command hint (`runOrHint`) — all with a fake `KclawClient`
 * (stubbed `request`) plus a recording `SlashCtx`; no daemon, no real
 * HTTP/WS. chat.test.ts exercises the full REPL loop end-to-end, but the
 * command implementations and the hint are asserted directly here. The
 * `sessions` select is mocked via `vi.mock("@clack/prompts")` so its
 * `select`/`isCancel` behaviour (and the pause/resume around it) is asserted
 * without a real terminal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { isCancel, select } from "@clack/prompts"
import { createRegistry, dispatch, runOrHint, type SlashCtx } from "../src/slash.js"
import type { KclawClient } from "../src/client.js"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(),
}))

const selectMock = vi.mocked(select)
const isCancelMock = vi.mocked(isCancel)

/** A recording SlashCtx whose `sessionId` is mutable (switchSession rewrites it, like the real chat loop). */
function makeFakeCtx(requestImpl: (method: string, path: string, body?: unknown) => unknown) {
  let sessionId = "ses_start"
  const request = vi.fn(requestImpl)
  const switchSession = vi.fn(async (id: string) => {
    sessionId = id
  })
  const print = vi.fn((_text: string) => {})
  const pauseInput = vi.fn(() => {})
  const resumeInput = vi.fn(() => {})
  const ctx: SlashCtx = {
    client: { request } as unknown as KclawClient,
    get sessionId() {
      return sessionId
    },
    switchSession,
    exit: () => {},
    print,
    pauseInput,
    resumeInput,
  }
  return { ctx, request, switchSession, print, pauseInput, resumeInput }
}

beforeEach(() => {
  selectMock.mockReset()
  isCancelMock.mockReset()
})

describe("slash command dispatch", () => {
  it("dispatch 解析 / 命令与参数", () => {
    expect(dispatch("/new 标题", new Map())).toEqual({ command: "new", args: "标题" })
    expect(dispatch("/help", new Map())).toEqual({ command: "help", args: "" })
    expect(dispatch("普通消息", new Map())).toBeNull()
  })

  it("dispatch 处理无参数命令与空白裁剪", () => {
    expect(dispatch("/new", new Map())).toEqual({ command: "new", args: "" })
    expect(dispatch("/new   标题  ", new Map())).toEqual({ command: "new", args: "标题" })
    expect(dispatch("/exit now", new Map())).toEqual({ command: "exit", args: "now" })
  })
})

describe("slash command registry", () => {
  it("createRegistry 注册 new 与 sessions", () => {
    const { ctx } = makeFakeCtx(async () => undefined)
    const registry = createRegistry(ctx)
    expect(registry.has("new")).toBe(true)
    expect(registry.has("sessions")).toBe(true)
    expect(registry.get("new")?.name).toBe("new")
    expect(registry.get("sessions")?.name).toBe("sessions")
  })

  it("registry 含 help/new/clear", () => {
    const { ctx } = makeFakeCtx(async () => undefined)
    const registry = createRegistry(ctx)
    expect(registry.has("help")).toBe(true)
    expect(registry.has("new")).toBe(true)
    expect(registry.has("clear")).toBe(true)
  })

  it("new: POST /sessions（带标题 + workdir）→ switchSession(meta.id) → print 新会话", async () => {
    const fake = makeFakeCtx(async () => ({
      id: "ses_new",
      title: "测试标题",
      createdAt: "t0",
      updatedAt: "t0",
    }))
    const registry = createRegistry(fake.ctx)
    await registry.get("new")!.run("测试标题", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("POST", "/sessions", { title: "测试标题", workdir: process.cwd() })
    expect(fake.switchSession).toHaveBeenCalledWith("ses_new")
    expect(fake.print).toHaveBeenCalledWith("已切换到新会话 ses_new")
  })

  it("new: 无标题时 POST /sessions 仍携带 workdir（绑定终端 cwd）", async () => {
    const fake = makeFakeCtx(async () => ({ id: "ses_new", title: "", createdAt: "", updatedAt: "" }))
    const registry = createRegistry(fake.ctx)
    await registry.get("new")!.run("", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("POST", "/sessions", { workdir: process.cwd() })
    expect(fake.switchSession).toHaveBeenCalledWith("ses_new")
  })

  it("clear: POST /sessions（workdir）→ switchSession(meta.id) → print 新会话", async () => {
    const fake = makeFakeCtx(async () => ({ id: "ses_clear", title: "", createdAt: "t0", updatedAt: "t0" }))
    const registry = createRegistry(fake.ctx)
    await registry.get("clear")!.run("", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("POST", "/sessions", { workdir: process.cwd() })
    expect(fake.switchSession).toHaveBeenCalledWith("ses_clear")
    expect(fake.print).toHaveBeenCalledWith("已切换到新会话 ses_clear")
  })

  it("help: 遍历 registry 逐行 print 名称 用法 — 描述（含自身与 new/clear/sessions）", async () => {
    const fake = makeFakeCtx(async () => undefined)
    const registry = createRegistry(fake.ctx)
    await registry.get("help")!.run("", fake.ctx)

    expect(fake.request).not.toHaveBeenCalled()
    expect(fake.print).toHaveBeenCalledTimes(registry.size)
    const lines = fake.print.mock.calls.map((c) => c[0] as string)
    expect(lines).toContain("help /help — 列出所有命令")
    expect(lines).toContain("new /new [标题] — 新建会话并切换过去")
    expect(lines).toContain("clear /clear — 新建会话（不带标题）")
    expect(lines).toContain("sessions /sessions — 选择会话并切换")
  })

  it("sessions: GET /sessions → select 选项（value=id label=title）→ 选中后 switchSession", async () => {
    const fake = makeFakeCtx(async (method, path) => {
      expect(method).toBe("GET")
      expect(path).toBe("/sessions")
      return [
        { id: "ses_a", title: "A", createdAt: "c", updatedAt: "t0" },
        { id: "ses_b", title: "B", createdAt: "c", updatedAt: "t1" },
      ]
    })
    selectMock.mockResolvedValue("ses_b")
    isCancelMock.mockReturnValue(false)

    const registry = createRegistry(fake.ctx)
    await registry.get("sessions")!.run("", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("GET", "/sessions")
    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(selectMock).toHaveBeenCalledWith({
      message: "选择会话",
      options: [
        { value: "ses_a", label: "A" },
        { value: "ses_b", label: "B" },
      ],
    })
    expect(isCancelMock).toHaveBeenCalledWith("ses_b")
    expect(fake.switchSession).toHaveBeenCalledWith("ses_b")
    expect(fake.print).not.toHaveBeenCalled()
    // readline 被暂停/恢复，@clack 拥有终端期间 readline 安静
    expect(fake.pauseInput).toHaveBeenCalledTimes(1)
    expect(fake.resumeInput).toHaveBeenCalledTimes(1)
  })

  it("sessions: Esc 取消（isCancel=true）不 switchSession，仍 resumeInput", async () => {
    const fake = makeFakeCtx(async () => [
      { id: "ses_a", title: "A", createdAt: "c", updatedAt: "t0" },
    ])
    const cancelSymbol = Symbol("cancel")
    selectMock.mockResolvedValue(cancelSymbol)
    isCancelMock.mockReturnValue(true)

    const registry = createRegistry(fake.ctx)
    await registry.get("sessions")!.run("", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("GET", "/sessions")
    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(fake.switchSession).not.toHaveBeenCalled()
    expect(fake.pauseInput).toHaveBeenCalledTimes(1)
    expect(fake.resumeInput).toHaveBeenCalledTimes(1)
  })

  it("sessions: select 抛错时 finally 仍 resumeInput（终端不锁死）", async () => {
    const fake = makeFakeCtx(async () => [
      { id: "ses_a", title: "A", createdAt: "c", updatedAt: "t0" },
    ])
    selectMock.mockRejectedValue(new Error("boom"))

    const registry = createRegistry(fake.ctx)
    await expect(registry.get("sessions")!.run("", fake.ctx)).rejects.toThrow("boom")

    expect(fake.pauseInput).toHaveBeenCalledTimes(1)
    expect(fake.resumeInput).toHaveBeenCalledTimes(1)
    expect(fake.switchSession).not.toHaveBeenCalled()
  })

  it("sessions: 空列表不弹 select，打印（还没有会话）", async () => {
    const fake = makeFakeCtx(async () => [])
    const registry = createRegistry(fake.ctx)
    await registry.get("sessions")!.run("", fake.ctx)

    expect(fake.request).toHaveBeenCalledWith("GET", "/sessions")
    expect(fake.print).toHaveBeenCalledWith("（还没有会话）")
    expect(selectMock).not.toHaveBeenCalled()
    expect(fake.switchSession).not.toHaveBeenCalled()
    expect(fake.pauseInput).not.toHaveBeenCalled()
    expect(fake.resumeInput).not.toHaveBeenCalled()
  })
})

describe("runOrHint", () => {
  it("未命中命令：print 未知命令提示并返回 false", async () => {
    const fake = makeFakeCtx(async () => undefined)
    const registry = createRegistry(fake.ctx)
    const result = await runOrHint({ command: "foobar", args: "" }, registry, fake.ctx)

    expect(result).toBe(false)
    expect(fake.print).toHaveBeenCalledWith("没有这个命令，/help 看看")
    expect(fake.request).not.toHaveBeenCalled()
  })

  it("命中命令：执行 run 并返回 true", async () => {
    const fake = makeFakeCtx(async () => [])
    const registry = createRegistry(fake.ctx)
    const result = await runOrHint({ command: "sessions", args: "" }, registry, fake.ctx)

    expect(result).toBe(true)
    expect(fake.request).toHaveBeenCalledWith("GET", "/sessions")
  })
})
