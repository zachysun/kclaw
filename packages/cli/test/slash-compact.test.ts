import { describe, expect, it } from "vitest"
import { createRegistry, type SlashCtx } from "../src/slash.js"

function ctxWith(calls: Array<{ method: string; path: string; body?: unknown }>): SlashCtx {
  return {
    client: {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body })
        return { message: "压缩了 2 段，剩 5 条原文消息" }
      },
    } as unknown as SlashCtx["client"],
    sessionId: "ses_1",
    switchSession: async () => {},
    exit: () => {},
    print: () => {},
    pauseInput: () => {},
    resumeInput: () => {},
    pendingAttachments: [],
    send: () => {},
  }
}

describe("/compact", () => {
  it("posts to the compact endpoint and prints the result", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const printed: string[] = []
    const ctx = { ...ctxWith(calls), print: (t: string) => printed.push(t) }
    const registry = createRegistry(ctx)
    const cmd = registry.get("compact")!
    await cmd.run("", ctx)
    expect(calls).toEqual([{ method: "POST", path: "/sessions/ses_1/compact", body: {} }])
    expect(printed[0]).toContain("压缩了 2 段")
  })

  it("passes the args as focus", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const ctx = ctxWith(calls)
    await createRegistry(ctx).get("compact")!.run("重点保留登录模块", ctx)
    expect(calls[0]!.body).toEqual({ focus: "重点保留登录模块" })
  })
})
