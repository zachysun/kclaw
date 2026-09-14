import { describe, expect, it } from "vitest"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { McpManager } from "../../src/mcp/manager.js"
import type { McpServerConfig } from "../../src/mcp/manager.js"

/**
 * In-process fake MCP server pair. Every transportFactory call spins up a
 * fresh Server + linked InMemoryTransport pair, so reconnects get a new
 * working server.
 */
function fakeServerHarness() {
  const calls: string[] = []
  const serverTransports: InMemoryTransport[] = []
  const transportFactory = (): Transport => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    // McpServer constructs its own low-level Server internally.
    const mcp = new McpServer({ name: "fake", version: "1.0.0" })
    mcp.registerTool(
      "echo",
      { description: "Echo the given text back", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
    )
    mcp.registerTool(
      "boom",
      { description: "Always fails with isError", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }),
    )
    void mcp.connect(serverTransport)
    serverTransports.push(serverTransport)
    calls.push("connect")
    return clientTransport
  }
  return { transportFactory, calls, serverTransports }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("waitUntil: condition not met in time")
}

function managerOpts(servers: Record<string, McpServerConfig>, harness: ReturnType<typeof fakeServerHarness>) {
  return {
    servers,
    transportFactory: (_name: string, _cfg: McpServerConfig) => harness.transportFactory(),
    backoffBaseMs: 1,
    backoffCapMs: 4,
    connectTimeoutMs: 1000,
  }
}

describe("McpManager", () => {
  it("connects and exposes prefixed tools with defs", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ fake: { type: "stdio", command: "unused" } }, harness))
    await manager.start()

    const statuses = manager.status()
    expect(statuses).toHaveLength(1)
    expect(statuses[0].name).toBe("fake")
    expect(statuses[0].state).toBe("connected")
    expect(statuses[0].tools.map((t) => t.name)).toContain("mcp__fake__echo")

    const { executors, defs } = manager.tools()
    expect(executors.size).toBe(2)
    const echoDef = defs.find((d) => d.name === "mcp__fake__echo")
    expect(echoDef?.description).toBe("Echo the given text back")
    expect(echoDef?.parameters).toMatchObject({ type: "object" })
    await manager.stop()
  })

  it("executor forwards calls and surfaces tool errors", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ fake: { type: "stdio", command: "unused" } }, harness))
    await manager.start()
    const { executors } = manager.tools()
    const ctx = { onOutput: () => {} }

    const ok = await executors.get("mcp__fake__echo")!.execute({ text: "hi" }, ctx)
    expect(ok).toEqual({ status: "ok", output: "echo: hi" })

    const err = await executors.get("mcp__fake__boom")!.execute({}, ctx)
    expect(err.status).toBe("error")
    expect(err.output).toContain("kaboom")
    await manager.stop()
  })

  it("a disabled server is never connected", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(
      managerOpts({ off: { type: "stdio", command: "unused", enabled: false } }, harness),
    )
    await manager.start()
    expect(harness.calls).toHaveLength(0)
    const statuses = manager.status()
    expect(statuses[0].state).toBe("disabled")
    expect(manager.tools().executors.size).toBe(0)
    await manager.stop()
  })

  it("reconnects with backoff after a transport close", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ fake: { type: "stdio", command: "unused" } }, harness))
    await manager.start()
    expect(manager.status()[0].state).toBe("connected")

    // Kill the server side of the pair; the client sees a transport close.
    await harness.serverTransports[0].close()
    await waitUntil(() => manager.status()[0].state === "connected")
    expect(harness.calls.length).toBeGreaterThanOrEqual(2)
    const { executors } = manager.tools()
    expect(executors.has("mcp__fake__echo")).toBe(true)
    await manager.stop()
  })

  it("start never rejects on a failing server", async () => {
    const manager = new McpManager({
      servers: { bad: { type: "stdio", command: "unused" } },
      transportFactory: () => {
        throw new Error("no transport for you")
      },
      backoffBaseMs: 1,
      connectTimeoutMs: 500,
    })
    await expect(manager.start()).resolves.toBeUndefined()
    const statuses = manager.status()
    expect(statuses[0].state).toBe("failed")
    expect(statuses[0].lastError).toBeTruthy()
    await manager.stop()
  })
})

describe("McpManager hot config methods", () => {
  it("addServer connects and persists", async () => {
    const harness = fakeServerHarness()
    const persisted: Array<Record<string, McpServerConfig>> = []
    const manager = new McpManager({ ...managerOpts({}, harness), persist: (s) => persisted.push(s) })
    manager.addServer("late", { type: "stdio", command: "unused" })
    await manager.flush()

    expect(manager.status().map((s) => s.name)).toEqual(["late"])
    expect(manager.status()[0].state).toBe("connected")
    expect(manager.tools().executors.has("mcp__late__echo")).toBe(true)
    expect(persisted.at(-1)).toEqual({ late: { type: "stdio", command: "unused" } })
    await manager.stop()
  })

  it("addServer with enabled:false never connects and lands disabled", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({}, harness))
    manager.addServer("off", { type: "stdio", command: "unused", enabled: false })
    await manager.flush()
    expect(harness.calls).toHaveLength(0)
    expect(manager.status()[0].state).toBe("disabled")
    await manager.stop()
  })

  it("addServer rejects blank and duplicate names", () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ dup: { type: "stdio", command: "unused" } }, harness))
    expect(() => manager.addServer("  ", { type: "stdio", command: "x" })).toThrow(/name/)
    expect(() => manager.addServer("dup", { type: "stdio", command: "x" })).toThrow(/already exists/)
  })

  it("removeServer tears the connection down and drops it from status", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ gone: { type: "stdio", command: "unused" } }, harness))
    await manager.start()
    manager.removeServer("gone")
    await manager.flush()
    expect(manager.status()).toEqual([])
    // the retired transport's close must not schedule a reconnect
    expect(manager.status()).toEqual([])
    await manager.stop()
  })

  it("removeServer throws for an unknown name", () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({}, harness))
    expect(() => manager.removeServer("nope")).toThrow(/unknown MCP server/)
  })

  it("updateServer reconnects with the new config", async () => {
    const seenConfigs: McpServerConfig[] = []
    const harness = fakeServerHarness()
    const manager = new McpManager({
      ...managerOpts({ srv: { type: "stdio", command: "old" } }, harness),
      transportFactory: (_name, cfg) => {
        seenConfigs.push(cfg)
        return harness.transportFactory()
      },
    })
    await manager.start()
    manager.updateServer("srv", { type: "stdio", command: "new" })
    await manager.flush()

    const status = manager.status()[0]
    expect(status.state).toBe("connected")
    expect(status.config).toEqual({ type: "stdio", command: "new" })
    expect(seenConfigs.at(-1)).toEqual({ type: "stdio", command: "new" })
    await manager.stop()
  })

  it("setEnabled false disables a connected server, true brings it back", async () => {
    const harness = fakeServerHarness()
    const persisted: Array<Record<string, McpServerConfig>> = []
    const manager = new McpManager({
      ...managerOpts({ fl: { type: "stdio", command: "unused" } }, harness),
      persist: (s) => persisted.push(s),
    })
    await manager.start()
    manager.setEnabled("fl", false)
    await manager.flush()
    expect(manager.status()[0].state).toBe("disabled")
    expect(manager.tools().executors.size).toBe(0)
    expect(persisted.at(-1)?.fl.enabled).toBe(false)

    manager.setEnabled("fl", true)
    await manager.flush()
    expect(manager.status()[0].state).toBe("connected")
    expect(manager.tools().executors.size).toBe(2)
    await manager.stop()
  })

  it("setEnabled to the current value is a no-op and does not reconnect", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ fl: { type: "stdio", command: "unused" } }, harness))
    await manager.start()
    const connectsBefore = harness.calls.length
    manager.setEnabled("fl", true)
    await manager.flush()
    expect(harness.calls.length).toBe(connectsBefore)
    await manager.stop()
  })

  it("reconnect revives a server that failed at startup", async () => {
    let shouldFail = true
    const harness = fakeServerHarness()
    const manager = new McpManager({
      ...managerOpts({ late: { type: "stdio", command: "unused" } }, harness),
      transportFactory: (name, cfg) => {
        if (shouldFail) throw new Error("spawn enoent")
        return harness.transportFactory()
      },
    })
    await manager.start()
    expect(manager.status()[0].state).toBe("failed")

    shouldFail = false
    manager.reconnect("late")
    await manager.flush()
    expect(manager.status()[0].state).toBe("connected")
    expect(manager.status()[0].lastError).toBeUndefined()
    await manager.stop()
  })

  it("reconnect records the failure but stays one-shot", async () => {
    let attempts = 0
    const manager = new McpManager({
      servers: { late: { type: "stdio", command: "unused" } },
      transportFactory: () => {
        attempts++
        throw new Error("still broken")
      },
      backoffBaseMs: 1,
      connectTimeoutMs: 200,
    })
    await manager.start()
    expect(manager.status()[0].state).toBe("failed")
    const attemptsAfterStart = attempts
    manager.reconnect("late")
    await manager.flush()
    expect(manager.status()[0].state).toBe("failed")
    expect(manager.status()[0].lastError).toContain("still broken")
    // one-shot: no backoff loop scheduled behind the manual attempt
    expect(attempts).toBe(attemptsAfterStart + 1)
    await manager.stop()
  })

  it("reconnect refuses disabled servers and no-ops connected ones", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ off: { type: "stdio", command: "unused", enabled: false } }, harness))
    await manager.start()
    expect(() => manager.reconnect("off")).toThrow(/disabled/)

    const live = fakeServerHarness()
    const manager2 = new McpManager(managerOpts({ up: { type: "stdio", command: "unused" } }, live))
    await manager2.start()
    const calls = live.calls.length
    manager2.reconnect("up")
    await manager2.flush()
    expect(live.calls.length).toBe(calls)
    await manager.stop()
    await manager2.stop()
  })

  it("status reflects a removed server's name never colliding with fresh state", async () => {
    const harness = fakeServerHarness()
    const manager = new McpManager(managerOpts({ a: { type: "stdio", command: "unused" } }, harness))
    await manager.start()
    manager.removeServer("a")
    manager.addServer("a", { type: "stdio", command: "unused" })
    await manager.flush()
    expect(manager.status()).toHaveLength(1)
    expect(manager.status()[0].state).toBe("connected")
    await manager.stop()
  })
})

describe("McpManager review fixes", () => {
  it("reconnect during a backoff window cancels the pending retry instead of racing it", async () => {
    let attempts = 0
    let failNext = false
    const harness = fakeServerHarness()
    const manager = new McpManager({
      servers: { flaky: { type: "stdio", command: "unused" } },
      transportFactory: () => {
        attempts++
        if (failNext) throw new Error("down")
        return harness.transportFactory()
      },
      backoffBaseMs: 40,
      backoffCapMs: 40,
      connectTimeoutMs: 500,
    })
    await manager.start()
    expect(manager.status()[0].state).toBe("connected")

    // Kill the server side; the backoff attempt fires ~40ms later and fails
    // (failNext), landing the server in "failed" with the NEXT retry timer
    // already pending — the window the WebUI's reconnect button shows in.
    failNext = true
    await harness.serverTransports[0]!.close()
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && manager.status()[0]!.state !== "failed") {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(manager.status()[0]!.state).toBe("failed")
    const attemptsInWindow = attempts

    failNext = false
    manager.reconnect("flaky")
    await manager.flush()
    expect(manager.status()[0]!.state).toBe("connected")

    // The cancelled backoff timer must NOT fire: exactly one more attempt
    // than the window had, ever.
    await new Promise((r) => setTimeout(r, 120))
    expect(attempts).toBe(attemptsInWindow + 1)
    await manager.stop()
  })
})
