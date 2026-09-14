/**
 * Slash-command registry unit tests. Covers `dispatch`
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
import { createRegistry, createSlashCompleter, dispatch, refreshSkillCommands, runOrHint, type SlashCtx } from "../src/slash.js"
import { basename, join } from "node:path"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
  /** ws 帧收集器：queueCancel 按真实实现的帧形状写入（all 不带 messageId）。 */
  const sent: unknown[] = []
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
    send: vi.fn(),
    commandsDir: undefined,
    setDisposition: vi.fn((_d: "steer" | "wait") => {}),
    queueCancel: vi.fn(async (target: string | "all") => {
      // mirrors chat.ts 的实现：ws queue.cancel 帧，all = 不带 messageId
      sent.push(
        target === "all"
          ? { type: "queue.cancel", sessionId }
          : { type: "queue.cancel", sessionId, messageId: target },
      )
    }),
    sendInterrupt: vi.fn((text: string) => {
      // mirrors chat.ts 的实现：renderRun 发出的 send_message（disposition interrupt）
      sent.push({ type: "send_message", sessionId, text, disposition: "interrupt" })
    }),
  }
  return { ctx, request, switchSession, print, pauseInput, resumeInput, sent }
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

describe("slash /attach", () => {
  it("uploads the file and queues it for the next message", async () => {
    const file = join(tmpdir(), `kclaw-att-${Date.now()}.md`)
    writeFileSync(file, "# 备忘\n买牛奶")
    const uploaded: unknown[] = []
    const { ctx } = makeFakeCtx(() => ({}))
    ctx.client = {
      uploadAttachment: async (_s: string, name: string, body: Buffer, mime: string) => {
        uploaded.push({ name, mime, bytes: body.length })
        return { file: { path: "/att/" + name, name, size: body.length } }
      },
    } as unknown as KclawClient
    ctx.pendingAttachments = []

    const registry = createRegistry(ctx)
    const ok = await runOrHint(dispatch("/attach " + file, registry), registry, ctx)
    expect(ok).toBe(true)
    expect(uploaded).toHaveLength(1)
    expect(ctx.pendingAttachments).toHaveLength(1)
    expect(ctx.pendingAttachments[0]!.name).toBe(basename(file))
    expect(ctx.pendingAttachments[0]!.mimeType).toBe("text/markdown")
    rmSync(file, { force: true })
  })

  it("reports a missing file without crashing", async () => {
    const { ctx } = makeFakeCtx(() => ({}))
    ctx.pendingAttachments = []
    const registry = createRegistry(ctx)
    await runOrHint(dispatch("/attach /nonexistent/x.txt", registry), registry, ctx)
    expect(ctx.pendingAttachments).toHaveLength(0)
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("附件上传失败"))
  })
})

describe("slash /model", () => {
  it("lists available models and the current session model", async () => {
    const { ctx } = makeFakeCtx((method, path) => {
      if (method === "GET" && path === "/config") return { providers: { entries: { a: {}, b: {} }, default: "a" } }
      if (method === "GET" && path.startsWith("/sessions/")) return { model: "b" }
      return {}
    })
    ctx.pendingAttachments = []
    const registry = createRegistry(ctx)
    await runOrHint(dispatch("/model", registry), registry, ctx)
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("a, b"))
    expect(ctx.print).toHaveBeenCalledWith(expect.stringContaining("当前模型: b"))
  })

  it("switches the session model and clears with default", async () => {
    const posts: Array<{ model: string }> = []
    const { ctx } = makeFakeCtx((method, path, body) => {
      if (method === "POST") posts.push(body as { model: string })
      return {}
    })
    ctx.pendingAttachments = []
    const registry = createRegistry(ctx)
    await runOrHint(dispatch("/model b", registry), registry, ctx)
    expect(posts[0]).toEqual({ model: "b" })
    await runOrHint(dispatch("/model default", registry), registry, ctx)
    expect(posts[1]).toEqual({ model: "" })
  })
})

describe("custom slash commands + mode", () => {
  it("loads <commandsDir>/*.md as commands with {{args}} expansion", async () => {
    const dir = join(tmpdir(), `kclaw-cmd-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "tldr.md"), "请用三句话总结：{{args}}")
    writeFileSync(join(dir, "help.md"), "不该加载（与内置重名）")
    const { ctx } = makeFakeCtx(() => ({}))
    ctx.pendingAttachments = []
    ctx.commandsDir = dir
    const registry = createRegistry(ctx)
    expect(registry.has("tldr")).toBe(true)
    // builtin wins: the custom help.md was skipped, the builtin kept its description
    expect(registry.get("help")!.description).toBe("列出所有命令")
    await runOrHint(dispatch("/tldr 项目管理", registry), registry, ctx)
    expect(ctx.send).toHaveBeenCalledWith("请用三句话总结：项目管理")
    rmSync(dir, { recursive: true, force: true })
  })

  it("/mode POSTs the requested mode and mirrors it via setMode", async () => {
    const posts: Array<{ mode: string }> = []
    const set: string[] = []
    const { ctx } = makeFakeCtx((_method, _path, body) => {
      posts.push(body as { mode: string })
      return {}
    })
    ctx.setMode = (m) => set.push(m)
    ctx.pendingAttachments = []
    const registry = createRegistry(ctx)
    await runOrHint(dispatch("/mode readonly", registry), registry, ctx)
    expect(posts[0]).toEqual({ mode: "readonly" })
    expect(set).toEqual(["readonly"])
    await runOrHint(dispatch("/mode acceptEdits", registry), registry, ctx)
    expect(posts[1]).toEqual({ mode: "acceptEdits" })
    expect(set).toEqual(["readonly", "acceptEdits"])
    await runOrHint(dispatch("/mode trusted", registry), registry, ctx)
    expect(posts[2]).toEqual({ mode: "trusted" })
    expect(set).toEqual(["readonly", "acceptEdits", "trusted"])
    await runOrHint(dispatch("/mode auto", registry), registry, ctx)
    expect(posts[3]).toEqual({ mode: "auto" })
    expect(set).toEqual(["readonly", "acceptEdits", "trusted", "auto"])
  })

  it("/mode with no args prints the current value; unknown names are rejected", async () => {
    const prints: string[] = []
    const posts: unknown[] = []
    const { ctx } = makeFakeCtx((method, _path, body) => {
      if (method === "POST") posts.push(body)
      return {}
    })
    ctx.setMode = () => {}
    ctx.pendingAttachments = []
    ctx.print = (t: string) => prints.push(t)
    const registry = createRegistry(ctx)
    await runOrHint(dispatch("/mode", registry), registry, ctx)
    expect(posts).toEqual([])
    expect(prints[0]).toContain("权限模式")
    await runOrHint(dispatch("/mode ADMIN", registry), registry, ctx)
    expect(posts).toEqual([])
    expect(prints[1]).toContain("未知模式")
  })
})

describe("/steer /wait", () => {
  it("POSTs the session override and prints the mode line", async () => {
    const posts: Array<[string, unknown]> = []
    const fake = makeFakeCtx((method, path, body) => {
      if (method === "POST") posts.push([path, body])
      return {}
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "steer", args: "" }, registry, fake.ctx)
    await runOrHint({ command: "wait", args: "" }, registry, fake.ctx)
    expect(posts).toEqual([
      [`/sessions/${fake.ctx.sessionId}/disposition`, { disposition: "steer" }],
      [`/sessions/${fake.ctx.sessionId}/disposition`, { disposition: "wait" }],
    ])
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("引导"))).toBe(true)
    expect(printed.some((t) => t.includes("等待"))).toBe(true)
  })

  it("request 失败：打印失败行、不切本地模式、命令正常 resolve（REPL 不被一次失败杀死）", async () => {
    const fake = makeFakeCtx(async () => {
      throw new Error("daemon down")
    })
    const registry = createRegistry(fake.ctx)
    await expect(runOrHint({ command: "steer", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    let printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("切换处置失败") && t.includes("daemon down"))).toBe(true)
    expect(vi.mocked(fake.ctx.setDisposition!)).not.toHaveBeenCalled()
    expect(printed.some((t) => t.includes("本会话处置模式"))).toBe(false)

    await expect(runOrHint({ command: "wait", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.filter((t) => t.includes("切换处置失败"))).toHaveLength(2)
    expect(vi.mocked(fake.ctx.setDisposition!)).not.toHaveBeenCalled()
    expect(printed.some((t) => t.includes("本会话处置模式"))).toBe(false)
  })
})

describe("/interrupt", () => {
  it("requires args and sends via ws with disposition interrupt", async () => {
    const fake = makeFakeCtx(() => ({}))
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "interrupt", args: "" }, registry, fake.ctx)
    expect(fake.sent).toEqual([])
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("用法"))).toBe(true)
    await runOrHint({ command: "interrupt", args: "换方向" }, registry, fake.ctx)
    expect(fake.sent).toEqual([{ type: "send_message", sessionId: fake.ctx.sessionId, text: "换方向", disposition: "interrupt" }])
  })
})

describe("/memory", () => {
  it("lists projects with no args", async () => {
    const calls: string[] = []
    const fake = makeFakeCtx(async (_m: string, path: string) => {
      calls.push(path)
      if (path === "/memory/projects") {
        return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", threads: 3, lastActivity: "2026-08-28" }]
      }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "memory", args: "" }, registry, fake.ctx)
    expect(calls).toEqual(["/memory/projects"])
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("kclaw-a3f2c9"))).toBe(true)
  })

  it("project arg lists threads; topic arg prints the thread file", async () => {
    const fake = makeFakeCtx(async (_m: string, path: string) => {
      if (path === "/memory/projects/kclaw-a3f2c9") {
        return { id: "kclaw-a3f2c9", threads: [{ topic: "ws", title: "重连", status: "active", updated: "2026-08-28" }] }
      }
      if (path === "/memory/threads/kclaw-a3f2c9/ws") return { content: "---\ntopic: ws\n---" }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "memory", args: "kclaw-a3f2c9" }, registry, fake.ctx)
    let printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("重连"))).toBe(true)
    await runOrHint({ command: "memory", args: "kclaw-a3f2c9 ws" }, registry, fake.ctx)
    printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("topic: ws"))).toBe(true)
  })

  it("request 失败（404/503 同路径）：打印失败行、命令正常 resolve（REPL 不被一次失败杀死）", async () => {
    // 真实 KclawClient 对非 2xx（含 404/503）抛 Error（body.error 或 HTTP <status>），
    // 与 /steer、/queue 的失败路径同构：打印失败行即返回，命令不抛未捕获异常。
    const fake = makeFakeCtx(async () => {
      throw new Error("HTTP 503")
    })
    const registry = createRegistry(fake.ctx)
    await expect(runOrHint({ command: "memory", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    await expect(runOrHint({ command: "memory", args: "kclaw-a3f2c9" }, registry, fake.ctx)).resolves.toBe(true)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.filter((t) => t.includes("查看记忆失败") && t.includes("HTTP 503"))).toHaveLength(2)
  })

  it("/memory save triggers a manual write for the current workdir", async () => {
    const calls: string[] = []
    const bodies: unknown[] = []
    const fake = makeFakeCtx(async (_m: string, path: string, body?: unknown) => {
      calls.push(path)
      bodies.push(body)
      return { ok: true }
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "memory", args: "save" }, registry, fake.ctx)
    expect(calls).toEqual(["/memory/trigger-manual"])
    // CLI 会话建在启动目录，当前项目 = process.cwd()（chat.ts 传 cwd 建会话）。
    expect(bodies[0]).toEqual({ workdir: process.cwd() })
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("已触发手动写入"))).toBe(true)
  })
})

describe("/queue", () => {
  it("lists numbered entries; cancel <n> and cancel all hit queue.cancel", async () => {
    const entries = [
      { messageId: "msg_1", disposition: "wait", text: "排队一", trigger: "user", enqueuedAt: "t" },
      { messageId: "msg_2", disposition: "steer", text: "排队二", trigger: "user", enqueuedAt: "t" },
    ]
    const fake = makeFakeCtx((_method, path) => (path.endsWith("/queue") ? entries : []))
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "queue", args: "" }, registry, fake.ctx)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("1. wait 排队一"))).toBe(true)
    await runOrHint({ command: "queue", args: "cancel 2" }, registry, fake.ctx)
    expect(fake.sent).toEqual([{ type: "queue.cancel", sessionId: fake.ctx.sessionId, messageId: "msg_2" }])
    await runOrHint({ command: "queue", args: "cancel all" }, registry, fake.ctx)
    expect(fake.sent).toEqual([
      { type: "queue.cancel", sessionId: fake.ctx.sessionId, messageId: "msg_2" },
      { type: "queue.cancel", sessionId: fake.ctx.sessionId },
    ])
  })

  it("empty queue prints the placeholder; an unknown index cancels nothing", async () => {
    const fake = makeFakeCtx((_method, path) => (path.endsWith("/queue") ? [] : []))
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "queue", args: "" }, registry, fake.ctx)
    expect(fake.print).toHaveBeenCalledWith("（队列为空）")
    await runOrHint({ command: "queue", args: "cancel 5" }, registry, fake.ctx)
    expect(fake.print).toHaveBeenCalledWith("没有这个序号")
    expect(fake.sent).toEqual([])
  })

  it("GET 失败：打印失败行、命令正常 resolve（不列出也不取消）", async () => {
    const fake = makeFakeCtx(async () => {
      throw new Error("boom")
    })
    const registry = createRegistry(fake.ctx)
    await expect(runOrHint({ command: "queue", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    let printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("读取队列失败") && t.includes("boom"))).toBe(true)

    // cancel 路径同样先读快照——读取失败即失败行，不发出任何 queue.cancel
    await expect(runOrHint({ command: "queue", args: "cancel all" }, registry, fake.ctx)).resolves.toBe(true)
    printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.filter((t) => t.includes("读取队列失败"))).toHaveLength(2)
    expect(fake.sent).toEqual([])
  })
})

describe("skill slash commands (dynamic registration)", () => {
  const skillCtx = (rows: unknown, send = vi.fn()) => {
    const fake = makeFakeCtx((_m: string, path: string) => {
      if (path === "/skills") return rows
      throw new Error(`unexpected ${path}`)
    })
    fake.ctx.send = send
    return { fake, send }
  }

  it("registers each installed skill as a command that sends the raw text (daemon wraps)", async () => {
    const { fake, send } = skillCtx([
      { name: "test", description: "验收技能", visibility: "all", origin: "global" },
      { name: "deploy", description: "部署", visibility: "user-only", origin: "project" },
    ])
    const registry = createRegistry(fake.ctx)
    const metas = await refreshSkillCommands(registry, fake.ctx)
    expect(metas.map((m) => m.name)).toEqual(["test", "deploy"])
    await runOrHint({ command: "test", args: "把 README 翻译成英文" }, registry, fake.ctx)
    expect(send).toHaveBeenCalledWith("/test 把 README 翻译成英文")
    await runOrHint({ command: "deploy", args: "" }, registry, fake.ctx)
    expect(send).toHaveBeenLastCalledWith("/deploy")
  })

  it("builtin names win: a skill named help is skipped", async () => {
    const { fake } = skillCtx([{ name: "help", description: "撞内置名" }])
    const registry = createRegistry(fake.ctx)
    const metas = await refreshSkillCommands(registry, fake.ctx)
    expect(metas).toEqual([])
    expect(registry.get("help")!.description).not.toBe("撞内置名")
  })

  it("createSlashCompleter suggests dynamic commands after builtins", () => {
    const completer = createSlashCompleter(() => [
      { name: "test", usage: "/test [要求]", description: "验收技能", surfaces: ["cli"] },
    ])
    const [hits] = completer("/te")
    expect(hits).toEqual(["/test"])
    const [bare] = completer("/")
    expect(bare.at(-1)).toBe("/test")
    expect(bare).not.toContain("/skill-test")
  })
})

describe("/skill", () => {
  const makeSkillCtx = (requestImpl: (method: string, path: string, body?: unknown) => unknown) =>
    makeFakeCtx(async (method, path, body) => {
      // makeFakeCtx 的默认会话是 ses_start：/skill 先取会话 meta 拿 workdir
      if (path === "/sessions/ses_start") return { id: "ses_start", workdir: "/w/proj" }
      return requestImpl(method, path, body)
    })

  it("lists user-visible skills scoped to the session workdir, marking origin and user-only", async () => {
    const calls: string[] = []
    const fake = makeSkillCtx((_m, path) => {
      calls.push(path)
      if (path === "/skills?workdir=%2Fw%2Fproj") {
        return [
          { name: "commit-helper", displayName: "commit-helper", description: "提交规范。", visibility: "all", origin: "global" },
          { name: "heavy-flow", displayName: "heavy-flow", description: "重流程。", visibility: "user-only", origin: "project" },
        ]
      }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "skill", args: "" }, registry, fake.ctx)
    expect(calls).toEqual(["/skills?workdir=%2Fw%2Fproj"])
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("commit-helper") && t.includes("全局") && t.includes("提交规范。"))).toBe(true)
    expect(printed.some((t) => t.includes("heavy-flow") && t.includes("项目") && t.includes("仅用户"))).toBe(true)
  })

  it("empty listing prints where to put skills", async () => {
    const fake = makeSkillCtx((_m, path) => {
      if (path === "/skills?workdir=%2Fw%2Fproj") return []
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "skill", args: "" }, registry, fake.ctx)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("还没有技能") && t.includes(".kclaw/skills"))).toBe(true)
  })

  it("skill arg prints the full body", async () => {
    const fake = makeSkillCtx((_m, path) => {
      if (path === "/skills/commit-helper?workdir=%2Fw%2Fproj") return { name: "commit-helper", content: "# 提交规程\n\n一行标题。" }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "skill", args: "commit-helper" }, registry, fake.ctx)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("# 提交规程"))).toBe(true)
  })

  it("request 失败：打印失败行、命令正常 resolve（REPL 不被一次失败杀死）", async () => {
    const fake = makeSkillCtx(async () => {
      throw new Error("HTTP 503")
    })
    const registry = createRegistry(fake.ctx)
    await expect(runOrHint({ command: "skill", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    await expect(runOrHint({ command: "skill", args: "nope" }, registry, fake.ctx)).resolves.toBe(true)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.filter((t) => t.includes("查看技能失败") && t.includes("HTTP 503"))).toHaveLength(2)
  })
})

describe("/mcp", () => {
  it("bare /mcp prints one line per server with state and tool count", async () => {
    const fake = makeFakeCtx(async (_m, path) => {
      if (path === "/mcp") {
        return {
          servers: [
            { name: "fs", state: "connected", tools: [{ name: "mcp__fs__read" }, { name: "mcp__fs__write" }] },
            { name: "remote", state: "failed", tools: [], lastError: "ECONNREFUSED" },
          ],
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "mcp", args: "" }, registry, fake.ctx)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("fs · 已连接 · 2 个工具"))).toBe(true)
    expect(printed.some((t) => t.includes("remote · 失败 · 0 个工具 · ECONNREFUSED"))).toBe(true)
    expect(printed.some((t) => t.includes("1 个失败"))).toBe(true)
  })

  it("/mcp <name> prints that server's tools with descriptions", async () => {
    const fake = makeFakeCtx(async (_m, path) => {
      if (path === "/mcp") {
        return {
          servers: [{ name: "fs", state: "connected", tools: [{ name: "mcp__fs__read", description: "Read a file" }] }],
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const registry = createRegistry(fake.ctx)
    await runOrHint({ command: "mcp", args: "fs" }, registry, fake.ctx)
    const printed = fake.print.mock.calls.map((c) => c[0] as string)
    expect(printed.some((t) => t.includes("fs（已连接）· 1 个工具"))).toBe(true)
    expect(printed.some((t) => t.includes("mcp__fs__read — Read a file"))).toBe(true)
  })

  it("handles the empty list and unknown names", async () => {
    const empty = makeFakeCtx(async (_m, path) => (path === "/mcp" ? { servers: [] } : (() => { throw new Error(`unexpected ${path}`) })()))
    const registry = createRegistry(empty.ctx)
    await runOrHint({ command: "mcp", args: "" }, registry, empty.ctx)
    expect(empty.print.mock.calls.map((c) => c[0] as string).some((t) => t.includes("还没有接入任何 MCP 服务器"))).toBe(true)

    const known = makeFakeCtx(async (_m, path) =>
      path === "/mcp" ? { servers: [{ name: "a", state: "connected", tools: [] }] } : (() => { throw new Error(`unexpected ${path}`) })(),
    )
    const registry2 = createRegistry(known.ctx)
    await runOrHint({ command: "mcp", args: "ghost" }, registry2, known.ctx)
    expect(known.print.mock.calls.map((c) => c[0] as string).some((t) => t.includes("未知 MCP 服务器: ghost"))).toBe(true)
  })

  it("request failures print a failure line and never reject", async () => {
    const fake = makeFakeCtx(async () => {
      throw new Error("HTTP 503")
    })
    const registry = createRegistry(fake.ctx)
    await expect(runOrHint({ command: "mcp", args: "" }, registry, fake.ctx)).resolves.toBe(true)
    expect(fake.print.mock.calls.map((c) => c[0] as string).some((t) => t.includes("查看 MCP 状态失败") && t.includes("HTTP 503"))).toBe(true)
  })
})
