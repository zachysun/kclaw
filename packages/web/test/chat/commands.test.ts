/**
 * WebUI slash-command dispatcher tests — `runWebCommand` executes the shared
 * table's web-surface commands against the panel's existing actions (REST
 * api, session/model callbacks) and never rejects; unknown commands get the
 * same hint text as the CLI. `help` is intercepted by the view (it renders
 * the command panel), so the dispatcher only treats it as a defensive no-op.
 */
import { describe, it, expect, vi } from "vitest"
import { runWebCommand, type WebCommandCtx } from "../../src/chat/commands.js"

function makeCtx(): WebCommandCtx & {
  notify: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  openSessions: ReturnType<typeof vi.fn>
  switchModel: ReturnType<typeof vi.fn>
  api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
} {
  return {
    api: {
      get: vi.fn(async () => ({ readonly: true, model: "gpt-5" })),
      post: vi.fn(async () => ({ message: "压缩了 3 段，剩 4 条原文消息" })),
    },
    sessionId: "s1",
    workdir: "",
    notify: vi.fn(),
    createSession: vi.fn(async () => {}),
    openSessions: vi.fn(),
    switchModel: vi.fn(),
    models: ["gpt-5", "glm-4"],
    currentModel: "gpt-5",
  } as unknown as WebCommandCtx & {
    notify: ReturnType<typeof vi.fn>
    createSession: ReturnType<typeof vi.fn>
    openSessions: ReturnType<typeof vi.fn>
    switchModel: ReturnType<typeof vi.fn>
    api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
  }
}

describe("runWebCommand", () => {
  it("hints on an unknown command and reports the miss", async () => {
    const ctx = makeCtx()
    const handled = await runWebCommand({ command: "frobnicate", args: "" }, ctx)
    expect(handled).toBe(false)
    expect(ctx.notify).toHaveBeenCalledWith("没有这个命令，/help 看看")
  })

  it("creates a titled session for /new and an untitled one for /clear", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "new", args: "重构讨论" }, ctx)).toBe(true)
    expect(ctx.createSession).toHaveBeenCalledWith("重构讨论")
    expect(await runWebCommand({ command: "clear", args: "" }, ctx)).toBe(true)
    expect(ctx.createSession).toHaveBeenCalledWith(undefined)
  })

  it("opens the session list for /sessions", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "sessions", args: "" }, ctx)).toBe(true)
    expect(ctx.openSessions).toHaveBeenCalled()
  })

  it("lists models and the current value for a bare /model", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "model", args: "" }, ctx)).toBe(true)
    expect(ctx.switchModel).not.toHaveBeenCalled()
    const notice = vi.mocked(ctx.notify).mock.calls[0]?.[0] as string
    expect(notice).toContain("gpt-5")
    expect(notice).toContain("glm-4")
    expect(notice).toContain("当前模型")
  })

  it("switches the model for /model <name> and maps default to the daemon default", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "model", args: "glm-4" }, ctx)).toBe(true)
    expect(ctx.switchModel).toHaveBeenCalledWith("glm-4")
    expect(await runWebCommand({ command: "model", args: "default" }, ctx)).toBe(true)
    expect(ctx.switchModel).toHaveBeenCalledWith("")
  })

  it("/mode <name> POSTs the mode and syncs the selector; a bare /mode prints the current value", async () => {
    const ctx = makeCtx()
    const setMode = vi.fn()
    ctx.setMode = setMode
    expect(await runWebCommand({ command: "mode", args: "readonly" }, ctx)).toBe(true)
    expect(ctx.api.post).toHaveBeenCalledWith("/sessions/s1/mode", { mode: "readonly" })
    expect(setMode).toHaveBeenCalledWith("readonly")
    expect(await runWebCommand({ command: "mode", args: "" }, ctx)).toBe(true)
    expect(ctx.api.get).toHaveBeenCalledWith("/sessions/s1")
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("当前权限模式"))
  })

  it("/mode rejects an unknown mode name without a POST", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "mode", args: "trusted" }, ctx)).toBe(true)
    expect(ctx.api.post).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("未知模式"))
  })

  it("compacts with and without a focus argument", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "compact", args: "" }, ctx)).toBe(true)
    expect(ctx.api.post).toHaveBeenCalledWith("/sessions/s1/compact", {})
    expect(ctx.notify).toHaveBeenCalledWith("压缩了 3 段，剩 4 条原文消息")
    expect(await runWebCommand({ command: "compact", args: "保留工具调用" }, ctx)).toBe(true)
    expect(ctx.api.post).toHaveBeenCalledWith("/sessions/s1/compact", { focus: "保留工具调用" })
  })

  it("lands compact failures in the notice instead of rejecting", async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.api.post).mockRejectedValueOnce(new Error("会话正在运行"))
    expect(await runWebCommand({ command: "compact", args: "" }, ctx)).toBe(true)
    expect(ctx.notify).toHaveBeenCalledWith("压缩失败: 会话正在运行")
  })

  it("treats /help as a handled no-op (the view renders the panel)", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "help", args: "" }, ctx)).toBe(true)
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it("points /memory at the memory page", async () => {
    const ctx = makeCtx()
    expect(await runWebCommand({ command: "memory", args: "" }, ctx)).toBe(true)
    expect(ctx.notify).toHaveBeenCalledWith("记忆管理请用顶部的「记忆」页")
  })

  it("/memory save triggers a manual write with the session workdir", async () => {
    const ctx = makeCtx()
    ctx.workdir = "/w/kclaw"
    expect(await runWebCommand({ command: "memory", args: "save" }, ctx)).toBe(true)
    expect(ctx.api.post).toHaveBeenCalledWith("/memory/trigger-manual", { workdir: "/w/kclaw" })
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("已触发手动写入"))
  })
})
