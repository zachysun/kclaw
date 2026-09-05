import { describe, it, expect, vi } from "vitest"
import { HookChain } from "../../src/hooks/runner.js"
import type { HookEntry, HookPosition } from "../../src/hooks/types.js"

function entry(
  name: string,
  position: HookPosition,
  handler: (ctx: never) => unknown,
  opts: { order?: number; failure?: "fatal" | "skip"; enabled?: boolean } = {},
): HookEntry {
  return {
    meta: {
      name,
      position,
      enabled: opts.enabled ?? true,
      order: opts.order ?? 10,
      failure: opts.failure ?? "fatal",
      origin: "builtin",
    },
    handler,
  }
}

/** run-before 观察钩子：记录 name → current（改写链语义的最小载体）。 */
function spy(name: string, log: string[], result?: unknown, failure: "fatal" | "skip" = "fatal", order = 10): HookEntry {
  return entry(name, "run-before", (ctx: { message: { text: string } }) => {
    log.push(`${name}:${ctx.message.text}`)
    return result
  }, { failure, order })
}

const msg = (text: string) => ({ message: { text } })

describe("HookChain", () => {
  it("空位置短路：run 返回 undefined、has 为 false", async () => {
    const chain = new HookChain()
    expect(chain.has("run-before")).toBe(false)
    expect(await chain.run("run-before", msg("x"))).toBeUndefined()
  })

  it("按 order 升序执行，同 order 按名字稳定排序", async () => {
    const log: string[] = []
    const chain = new HookChain()
    chain.register(spy("beta", log, undefined, "skip"))
    chain.register(entry("late", "run-before", () => { log.push("late:0") }, { order: 20 }))
    chain.register(spy("alpha", log, undefined, "fatal", 10))
    chain.register(entry("early", "run-before", () => { log.push("early:0") }, { order: 5 }))
    await chain.run("run-before", msg("x"))
    expect(log).toEqual(["early:0", "alpha:x", "beta:x", "late:0"])
    expect(chain.has("run-before")).toBe(true)
  })

  it("改写链：非 undefined 返回值传给下一个 handler 并成为最终结果", async () => {
    const log: string[] = []
    const chain = new HookChain()
    chain.register(spy("first", log, { text: "rewritten-1" }))
    chain.register(entry("second", "run-before", (ctx: { message: { text: string } }) => {
      log.push(`second:${ctx.message.text}`)
      return { text: "rewritten-2" }
    }, { order: 20 }))
    chain.register(spy("observer", log, undefined, "fatal", 30)) // undefined → 不覆盖
    const out = await chain.run("run-before", msg("original"))
    expect(log).toEqual(["first:original", "second:rewritten-1", "observer:rewritten-2"])
    expect(out).toEqual({ text: "rewritten-2" })
  })

  it("skip 钩子抛错不中断：报告 hook.failed 后继续后面的 handler", async () => {
    const onFailure = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const log: string[] = []
      const chain = new HookChain({ onFailure })
      chain.register(spy("first", log))
      chain.register(entry("broken", "run-before", () => { throw new Error("boom") }, { failure: "skip", order: 20 }))
      chain.register(spy("after", log, undefined, "fatal", 30))
      const out = await chain.run("run-before", msg("x"))
      expect(out).toBeUndefined() // 无人改写：undefined 贯穿
      expect(log).toEqual(["first:x", "after:x"])
      expect(onFailure).toHaveBeenCalledTimes(1)
      const event = onFailure.mock.calls[0]![0] as { type: string; payload: Record<string, string> }
      expect(event.type).toBe("hook.failed")
      expect(event.payload).toEqual({ hook: "broken", position: "run-before", error: "boom", phase: "run" })
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it("fatal 钩子抛错让 run() 拒绝", async () => {
    const chain = new HookChain()
    chain.register(entry("fatal-broken", "run-before", () => { throw new Error("fatal reason") }))
    await expect(chain.run("run-before", msg("x"))).rejects.toThrow("fatal reason")
  })

  it("超时按失败处理：skip 报告、fatal 拒绝", async () => {
    const onFailure = vi.fn()
    const hang = () => new Promise(() => {}) // never settles
    const skipChain = new HookChain({ timeoutMs: () => 10, onFailure })
    skipChain.register(entry("slow", "run-before", hang, { failure: "skip" }))
    await skipChain.run("run-before", msg("x"))
    expect(onFailure).toHaveBeenCalledTimes(1)
    const event = onFailure.mock.calls[0]![0] as { payload: Record<string, string> }
    expect(event.payload.error).toContain("timed out")

    const fatalChain = new HookChain({ timeoutMs: () => 10 })
    fatalChain.register(entry("slow-fatal", "run-before", hang))
    await expect(fatalChain.run("run-before", msg("x"))).rejects.toThrow("timed out")
  })

  it("无限/非正 budget 不设超时（挂着的 handler 永不被掐）", async () => {
    const chain = new HookChain({ timeoutMs: () => 0 })
    chain.register(entry("forever", "run-before", () => "done"))
    expect(await chain.run("run-before", msg("x"))).toBe("done")
  })

  it("enabled:false 与带 error 的条目不注册", async () => {
    const log: string[] = []
    const chain = new HookChain()
    chain.register({ ...spy("off", log), meta: { ...spy("off", log).meta, enabled: false } })
    chain.register({
      ...spy("failed-load", log),
      meta: { ...spy("failed-load", log).meta, error: "load failed" },
    })
    expect(chain.has("run-before")).toBe(false)
    expect(await chain.run("run-before", msg("x"))).toBeUndefined()
    expect(log).toEqual([])
  })

  it("追加型位置（system-before）：段落累积而非互相覆盖", async () => {
    const chain = new HookChain()
    chain.register(entry("cognition", "system-before", () => ["认知段"], { order: 10 }))
    chain.register(entry("skills", "system-before", () => ["技能段"], { order: 20 }))
    const out = await chain.run("system-before", { base: "base prompt" })
    expect(out).toEqual(["认知段", "技能段"])
  })

  it("改写位置的回填：下一个 handler 的 ctx 拿到改写后的值，调用方对象不被改动", async () => {
    const seenBySecond: string[] = []
    const chain = new HookChain()
    chain.register(entry("rewrite", "run-before", () => ({ text: "rewritten" }), { order: 10 }))
    chain.register(entry("watch", "run-before", (ctx: { message: { text: string } }) => {
      seenBySecond.push(ctx.message.text)
    }, { order: 20 }))
    const input = msg("original")
    const out = await chain.run("run-before", input)
    expect(seenBySecond).toEqual(["rewritten"]) // 真链式：改写传递
    expect(out).toEqual({ text: "rewritten" })
    expect(input.message.text).toBe("original") // 调用方的 ctx 对象未被改动
  })

  it("位置互不串扰：一个位置的注册不影响另一个", async () => {
    const chain = new HookChain()
    chain.register(entry("only-llm", "llm-before", () => [{ role: "user", content: "rewritten" }]))
    expect(chain.has("llm-before")).toBe(true)
    expect(chain.has("run-before")).toBe(false)
    const out = await chain.run("llm-before", { messages: [{ role: "user", content: "orig" }] })
    expect(out).toEqual([{ role: "user", content: "rewritten" }])
  })
})
