/**
 * The channel manager (#46): lifecycle decisions behind injected fakes —
 * hot restart on save, disable, failure keeps the channel down with visible
 * status, one-click allowlist, masked snapshot. A minimal fake RunManager
 * suffices: the channel only touches it when runs flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, SessionStore, resolvePaths } from "@kclaw/core"
import type { RunManager } from "../../src/run.js"
import { createFeishuManager } from "../../src/feishu/manager.js"
import type { FeishuManagerDeps } from "../../src/feishu/manager.js"
import type { FeishuTransport, TransportHandlers } from "../../src/feishu/transport.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class CountingTransport implements FeishuTransport {
  started = false
  stopped = false
  handlers?: TransportHandlers
  constructor(readonly allowlist: string[]) {}
  async start(h: TransportHandlers): Promise<void> { this.handlers = h; this.started = true }
  async stop(): Promise<void> { this.stopped = true }
  async reactTyping(): Promise<void> {}
  async replyText(): Promise<void> {}
  async sendCard(): Promise<string> { return "c" }
  async updateCard(): Promise<void> {}
  async startStream(): Promise<string> { return "s" }
  async appendStream(): Promise<void> {}
  async finishStream(): Promise<void> {}
}

function makeBase(home: string): Omit<FeishuManagerDeps, "home"> {
  const paths = resolvePaths(home)
  return {
    run: {} as RunManager,
    sessions: new SessionStore(paths.sessionsDir),
    bus: new EventBus(),
    log: () => undefined,
  }
}

describe("feishu manager", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kclaw-feishu-mgr-"))
    dirs.push(home)
  })

  const writeConfig = (config: Record<string, unknown>): void => {
    writeFileSync(join(home, "feishu.json"), JSON.stringify({ ...config, app_id: config.appId ?? "cli_t", app_secret: "k" }))
  }

  it("reports disabled and builds no transport when feishu.json is off", async () => {
    writeConfig({ enabled: false })
    const createTransport = vi.fn(() => new CountingTransport([]))
    const manager = createFeishuManager({ ...makeBase(home), home, createTransport })
    await manager.start()
    expect(manager.status()).toEqual({ state: "disabled" })
    expect(createTransport).not.toHaveBeenCalled()
    expect(manager.snapshot().config).toEqual({
      enabled: false, appId: "cli_t", appSecretSet: true, allowlist: [],
    })
  })

  it("boots the channel when enabled and wires it", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"], primaryOpenId: "ou_1" })
    const wired: unknown[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home, createTransport: () => new CountingTransport([]),
      wireChannel: (ch) => wired.push(ch),
    })
    await manager.start()
    expect(manager.status()).toEqual({ state: "running" })
    // Every swap wires undefined first (the teardown step), then the live channel.
    expect(wired).toHaveLength(2)
    expect(wired[0]).toBeUndefined()
    expect(wired[1]).toBeDefined()
    await manager.stop()
    expect(wired.at(-1)).toBeUndefined()
  })

  it("save hot-restarts: old transport stops, a new one starts with the new config", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    const transports: CountingTransport[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: (config) => { const t = new CountingTransport(config.allowlist); transports.push(t); return t },
    })
    await manager.start()
    expect(transports).toHaveLength(1)

    const snapshot = await manager.save({
      enabled: true, appId: "cli_new", appSecret: "s2", allowlist: ["ou_2"], primaryOpenId: "ou_2",
    })
    expect(transports).toHaveLength(2)
    expect(transports[0]!.stopped).toBe(true)
    expect(transports[1]!.started).toBe(true)
    expect(transports[1]!.allowlist).toEqual(["ou_2"])
    expect(snapshot.config).toEqual({
      enabled: true, appId: "cli_new", appSecretSet: true, allowlist: ["ou_2"], primaryOpenId: "ou_2",
    })

    // Persisted in the disk shape (snake_case), loadable by hand-editors.
    const disk = JSON.parse(readFileSync(join(home, "feishu.json"), "utf8")) as Record<string, unknown>
    expect(disk.app_id).toBe("cli_new")
    expect(disk.app_secret).toBe("s2")
  })

  it("save with enabled=false stops the channel and reports disabled", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    const transports: CountingTransport[] = []
    const wired: unknown[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: (config) => { const t = new CountingTransport(config.allowlist); transports.push(t); return t },
      wireChannel: (ch) => wired.push(ch),
    })
    await manager.start()

    const snapshot = await manager.save({ enabled: false, appId: "cli_new", allowlist: [] })
    expect(transports[0]!.stopped).toBe(true)
    expect(manager.status()).toEqual({ state: "disabled" })
    expect(snapshot.config.enabled).toBe(false)
    expect(wired.at(-1)).toBeUndefined()
  })

  it("save rejects invalid drafts and leaves the running channel untouched", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    const transports: CountingTransport[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: (config) => { const t = new CountingTransport(config.allowlist); transports.push(t); return t },
    })
    await manager.start()

    await expect(manager.save({ enabled: true, appId: "cli_x", allowlist: ["ou_1"], primaryOpenId: "ou_9" }))
      .rejects.toThrow(/白名单/)
    await expect(manager.save({ enabled: true, appId: "", appSecret: "", allowlist: [] }))
      .rejects.toThrow(/app_secret/)
    // One transport, still the original config, file unchanged.
    expect(transports).toHaveLength(1)
    expect(existsSync(join(home, "feishu.json"))).toBe(true)
  })

  it("a failed start records the error and leaves the channel down", async () => {
    writeConfig({ enabled: true, allowlist: [] })
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: () => { throw new Error("sdk exploded") },
    })
    await manager.start()
    expect(manager.status().state).toBe("error")
    expect(manager.status().error).toContain("sdk exploded")
  })

  it("a half-started channel is torn down when its start fails (no zombie on the bus)", async () => {
    writeConfig({ enabled: true, allowlist: [] })
    const transports: CountingTransport[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: () => {
        const t = new CountingTransport([])
        transports.push(t)
        const originalStart = t.start.bind(t)
        t.start = async (h) => {
          // channel.start 先挂总线订阅，transport.start 再失败——半启动形态
          await originalStart(h)
          throw new Error("handshake refused")
        }
        return t
      },
    })
    await manager.start()
    expect(manager.status().state).toBe("error")
    // The half-started channel was stopped (bus unsubscribed + transport down),
    // so a later SDK self-heal cannot turn it into a second live channel.
    expect(transports[0]!.stopped).toBe(true)
  })

  it("a failed hot restart keeps the error visible and the old channel down", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    let failNext = false
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: () => {
        if (failNext) throw new Error("bad secret")
        return new CountingTransport([])
      },
    })
    await manager.start()
    expect(manager.status().state).toBe("running")

    failNext = true
    const snapshot = await manager.save({ enabled: true, appId: "cli_t", allowlist: ["ou_1"] })
    expect(snapshot.status).toEqual({ state: "error", error: expect.stringContaining("bad secret") })
  })

  it("allowAdd persists the new allowlist, hot-restarts and clears the pending entry", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    const transports: CountingTransport[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: (config) => { const t = new CountingTransport(config.allowlist); transports.push(t); return t },
    })
    await manager.start()
    // A rejected sender is recorded by the live channel (inbound via fake handlers).
    transports[0]!.handlers!.onMessage({ openId: "ou_9", messageId: "m1", text: "hi" })
    expect(manager.snapshot().pendingSenders.map((p) => p.openId)).toEqual(["ou_9"])

    const snapshot = await manager.allowAdd("ou_9")
    expect(transports).toHaveLength(2)
    expect(transports[1]!.allowlist).toEqual(["ou_1", "ou_9"])
    expect(snapshot.pendingSenders).toEqual([])

    // Idempotent: an existing member does not restart the channel again.
    await manager.allowAdd("ou_9")
    expect(transports).toHaveLength(2)
  })

  it("testCredentials falls back to the stored secret when the draft omits it", async () => {
    writeConfig({ enabled: false, allowlist: [] })
    const verify = vi.fn(async () => ({ ok: true }))
    const manager = createFeishuManager({ ...makeBase(home), home, verifyCredentials: verify })
    await manager.start()

    await manager.testCredentials("cli_t")
    expect(verify).toHaveBeenCalledWith("cli_t", "k")
    await manager.testCredentials("cli_t", "draft-secret")
    expect(verify).toHaveBeenLastCalledWith("cli_t", "draft-secret")

    const missing = await manager.testCredentials("")
    expect(missing).toEqual({ ok: false, error: expect.any(String) })
  })

  it("a broken feishu.json surfaces as error status instead of throwing", async () => {
    writeFileSync(join(home, "feishu.json"), "{not json")
    const manager = createFeishuManager({ ...makeBase(home), home })
    await expect(manager.start()).resolves.toBeUndefined()
    expect(manager.status().state).toBe("error")
  })

  it("serializes overlapping saves (the second restart starts after the first stop)", async () => {
    writeConfig({ enabled: true, allowlist: ["ou_1"] })
    const events: string[] = []
    const manager = createFeishuManager({
      ...makeBase(home), home,
      createTransport: (config) => {
        const t = new CountingTransport(config.allowlist)
        events.push(`create(${t.allowlist.join("+")})`)
        const originalStart = t.start.bind(t)
        const originalStop = t.stop.bind(t)
        t.start = async (h) => {
          if (t.allowlist.length === 2) await new Promise((r) => setTimeout(r, 50)) // 第一个 save 的启动拖慢
          events.push(`start(${t.allowlist.join("+")})`)
          await originalStart(h)
        }
        t.stop = async () => {
          events.push(`stop(${t.allowlist.join("+")})`)
          await originalStop()
        }
        return t
      },
    })
    await manager.start()
    events.length = 0

    // 两个并发 save 不得交错停/启：第二个的 create 必须排在第一个的 stop 之后
    await Promise.all([
      manager.save({ enabled: true, appId: "cli_t", allowlist: ["ou_1", "ou_2"] }),
      manager.save({ enabled: true, appId: "cli_t", allowlist: ["ou_3"] }),
    ])
    const stopFirst = events.findIndex((e) => e.startsWith("stop"))
    const createSecond = events.findIndex((e) => e.includes("ou_3"))
    expect(stopFirst).toBeGreaterThanOrEqual(0)
    expect(createSecond).toBeGreaterThan(stopFirst)
  })
})
