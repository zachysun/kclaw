import { describe, expect, it } from "vitest"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { GLOBAL_GROUP, McpError, McpManager } from "../../src/mcp/manager.js"
import type { McpServerConfig } from "../../src/mcp/types.js"

/**
 * In-process fake MCP server pair. Every transportFactory call spins up a
 * fresh Server + linked InMemoryTransport pair, so reconnects get a new
 * working server. The factory records the SERVER NAME per attempt — the
 * lazy model's assertions are about which (group, name) pairs connected.
 */
function fakeServerHarness() {
  const attempts: string[] = []
  const serverTransports: InMemoryTransport[] = []
  const transportFactory = (name: string): Transport => {
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
    attempts.push(name)
    return clientTransport
  }
  return { transportFactory, attempts, serverTransports }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("waitUntil: condition not met in time")
}

const DIR_A = "/tmp/proj-a"
const DIR_B = "/tmp/proj-b"

interface Opts {
  global?: Record<string, McpServerConfig>
  projects?: Record<string, Record<string, McpServerConfig>>
  harness?: ReturnType<typeof fakeServerHarness>
  failFactory?: boolean
  persist?: (group: string, servers: Record<string, McpServerConfig>) => void
  idleTtlMs?: number
  maxConnections?: number
  maxReconnectAttempts?: number
}

function makeManager(opts: Opts = {}): McpManager {
  const harness = opts.harness ?? fakeServerHarness()
  return new McpManager({
    globalServers: opts.global ?? {},
    projects: opts.projects,
    transportFactory: (name) => {
      if (opts.failFactory === true) throw new Error("no transport for you")
      return harness.transportFactory(name)
    },
    backoffBaseMs: 1,
    backoffCapMs: 4,
    connectTimeoutMs: 1000,
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.maxConnections !== undefined ? { maxConnections: opts.maxConnections } : {}),
    ...(opts.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: opts.maxReconnectAttempts } : {}),
    ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
  })
}

function stateOf(manager: McpManager, group: string, name: string): string {
  const found = manager.status().groups.find((g) => g.id === group)?.servers.find((s) => s.name === name)
  return found?.state ?? "<absent>"
}

function toolsOf(manager: McpManager, group: string, name: string): string[] {
  return manager.status().groups.find((g) => g.id === group)?.servers.find((s) => s.name === name)?.tools.map((t) => t.name) ?? []
}

describe("McpManager lazy boot and per-project views", () => {
  it("boot connects nothing; the first toolsFor builds the view's connections in the background", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, global: { g1: { type: "stdio", command: "g" } } })
    manager.start()
    expect(harness.attempts).toEqual([])
    expect(stateOf(manager, GLOBAL_GROUP, "g1")).toBe("disconnected")

    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "g1")).toBe("connected")
    expect(toolsOf(manager, GLOBAL_GROUP, "g1")).toContain("mcp__g1__echo")
    await manager.stop()
  })

  it("repeated toolsFor on the same project reuses the live connection (no reconnect churn)", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, global: { g1: { type: "stdio", command: "g" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const afterFirst = harness.attempts.length
    manager.toolsFor(DIR_A)
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(harness.attempts).toHaveLength(afterFirst)
    await manager.stop()
  })

  it("different projects get separate project connections but share the global one", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { g1: { type: "stdio", command: "g" } },
      projects: {
        [DIR_A]: { pa: { type: "stdio", command: "a" } },
        [DIR_B]: { pb: { type: "stdio", command: "b" } },
      },
    })
    manager.toolsFor(DIR_A)
    manager.toolsFor(DIR_B)
    await manager.flush()
    // one shared connection for g1, one per project entry
    expect(harness.attempts.filter((n) => n === "g1")).toHaveLength(1)
    expect(harness.attempts.filter((n) => n === "pa")).toHaveLength(1)
    expect(harness.attempts.filter((n) => n === "pb")).toHaveLength(1)
    await manager.stop()
  })

  it("the use-view shadows: a same-name project entry wins and the shadowed global entry stays unconnected", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { weather: { type: "stdio", command: "global-cmd" } },
      projects: { [DIR_A]: { weather: { type: "stdio", command: "project-cmd" } } },
    })
    const first = manager.toolsFor(DIR_A) // first use only KICKS the connection in the background
    expect(first.defs).toEqual([])
    await manager.flush()
    // project entry won the view; the shadowed global entry never connected (view-driven)
    const { defs } = manager.toolsFor(DIR_A)
    expect(defs.map((d) => d.name).sort()).toEqual(["mcp__weather__boom", "mcp__weather__echo"])
    expect(harness.attempts).toEqual(["weather"])
    expect(stateOf(manager, DIR_A, "weather")).toBe("connected")
    expect(stateOf(manager, GLOBAL_GROUP, "weather")).toBe("disconnected")

    // another project without its own entry still reaches the global one
    manager.toolsFor(DIR_B) // kicks the global connection for this view
    await manager.flush()
    const b = manager.toolsFor(DIR_B)
    expect(b.executors.has("mcp__weather__echo")).toBe(true)
    expect(stateOf(manager, GLOBAL_GROUP, "weather")).toBe("connected")
    await manager.stop()
  })

  it("a project enabled:false entry shadows the global same-name entry for that project", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { weather: { type: "stdio", command: "global-cmd" } },
      projects: { [DIR_A]: { weather: { type: "stdio", command: "project-cmd", enabled: false } } },
    })
    const { defs, executors } = manager.toolsFor(DIR_A)
    await manager.flush()
    expect(defs).toEqual([])
    expect(executors.size).toBe(0)
    expect(harness.attempts).toEqual([])
    expect(stateOf(manager, DIR_A, "weather")).toBe("disabled")
    expect(stateOf(manager, GLOBAL_GROUP, "weather")).toBe("disconnected")
    await manager.stop()
  })

  it("tool executors forward calls and touch the idle marker", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, global: { fake: { type: "stdio", command: "unused" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const { executors } = manager.toolsFor(DIR_A)
    const ctx = { onOutput: () => {} }

    const ok = await executors.get("mcp__fake__echo")!.execute({ text: "hi" }, ctx)
    expect(ok).toEqual({ status: "ok", output: "echo: hi" })
    const err = await executors.get("mcp__fake__boom")!.execute({}, ctx)
    expect(err.status).toBe("error")
    expect(err.output).toContain("kaboom")

    const record = manager.peekRecord(GLOBAL_GROUP, "fake")!
    expect(record.lastUsed).toBeGreaterThan(0)
    await manager.stop()
  })

  it("an executor on a reclaimed connection fails honestly instead of writing into a dead client", async () => {
    const manager = makeManager({ idleTtlMs: 100, global: { fake: { type: "stdio", command: "unused" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const { executors } = manager.toolsFor(DIR_A)
    const record = manager.peekRecord(GLOBAL_GROUP, "fake")!
    manager.sweep(record.lastUsed + 100) // >= TTL: reclaimed
    expect(stateOf(manager, GLOBAL_GROUP, "fake")).toBe("disconnected")

    const err = await executors.get("mcp__fake__echo")!.execute({ text: "hi" }, { onOutput: () => {} })
    expect(err.status).toBe("error")
    expect(err.output).toContain("未连接")

    // the next use rebuilds the view with a live connection again
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "fake")).toBe("connected")
    await manager.stop()
  })
})

describe("McpManager idle reclaim and bounded retry", () => {
  it("idle connections are reclaimed after the TTL; fresh use reconnects", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, idleTtlMs: 100, global: { g1: { type: "stdio", command: "g" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const record = manager.peekRecord(GLOBAL_GROUP, "g1")!

    manager.sweep(record.lastUsed + 99)
    expect(stateOf(manager, GLOBAL_GROUP, "g1")).toBe("connected")

    manager.sweep(record.lastUsed + 100)
    expect(stateOf(manager, GLOBAL_GROUP, "g1")).toBe("disconnected")
    expect(toolsOf(manager, GLOBAL_GROUP, "g1")).toEqual([])

    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(harness.attempts).toHaveLength(2)
    expect(stateOf(manager, GLOBAL_GROUP, "g1")).toBe("connected")
    await manager.stop()
  })

  it("a busy executor call keeps the connection alive past the sweep", async () => {
    const manager = makeManager({ idleTtlMs: 50, global: { fake: { type: "stdio", command: "unused" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const { executors } = manager.toolsFor(DIR_A)
    await executors.get("mcp__fake__echo")!.execute({ text: "keepalive" }, { onOutput: () => {} })
    const record = manager.peekRecord(GLOBAL_GROUP, "fake")!
    manager.sweep(record.lastUsed + 49)
    expect(stateOf(manager, GLOBAL_GROUP, "fake")).toBe("connected")
    manager.sweep(record.lastUsed + 50)
    expect(stateOf(manager, GLOBAL_GROUP, "fake")).toBe("disconnected")
    await manager.stop()
  })

  it("reconnect attempts are bounded; exhaustion settles in failed and stops", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, failFactory: true, maxReconnectAttempts: 2, global: { bad: { type: "stdio", command: "x" } } })
    manager.toolsFor(DIR_A) // lazy kick: bounded backoff begins
    await waitUntil(() => stateOf(manager, GLOBAL_GROUP, "bad") === "failed" && manager.peekRecord(GLOBAL_GROUP, "bad")?.reconnectTimer === undefined, 3000)
    const record = manager.peekRecord(GLOBAL_GROUP, "bad")!
    expect(record.attempts).toBe(2)
    expect(record.lastError).toContain("上限")
    const attemptsAtExhaustion = harness.attempts.length

    // exhaustion is final: no further churn while nothing new asks for it
    await new Promise((r) => setTimeout(r, 30))
    expect(harness.attempts).toHaveLength(attemptsAtExhaustion)
    await manager.stop()
  })

  it("a lazy kick resets the counter; a manual connect is one-shot", async () => {
    const harness = fakeServerHarness()
    let factoryCalls = 0
    let fail = true
    const rawFactory = harness.transportFactory
    const manager = new McpManager({
      globalServers: { flaky: { type: "stdio", command: "x" } },
      transportFactory: (name) => {
        factoryCalls += 1
        if (fail) throw new Error("down")
        return rawFactory(name)
      },
      backoffBaseMs: 1,
      backoffCapMs: 4,
      connectTimeoutMs: 500,
      maxReconnectAttempts: 1,
    })
    manager.toolsFor(DIR_A) // lazy kick: one attempt + one scheduled retry, then capped
    await waitUntil(() => stateOf(manager, GLOBAL_GROUP, "flaky") === "failed" && manager.peekRecord(GLOBAL_GROUP, "flaky")?.reconnectTimer === undefined, 3000)
    const callsAfterKick = factoryCalls
    expect(callsAfterKick).toBeGreaterThanOrEqual(2)

    // manual connect resets the counter and is one-shot: exactly one more attempt
    fail = false
    manager.connect(GLOBAL_GROUP, "flaky")
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "flaky")).toBe("connected")
    expect(factoryCalls).toBe(callsAfterKick + 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(factoryCalls).toBe(callsAfterKick + 1)
    await manager.stop()
  })

  it("connect refuses disabled entries and no-ops connected ones", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { off: { type: "stdio", command: "x", enabled: false }, up: { type: "stdio", command: "y" } },
    })
    expect(() => manager.connect(GLOBAL_GROUP, "off")).toThrow(/disabled/)

    manager.toolsFor(DIR_A)
    await manager.flush()
    const calls = harness.attempts.length
    manager.connect(GLOBAL_GROUP, "up")
    await manager.flush()
    expect(harness.attempts).toHaveLength(calls)
    await manager.stop()
  })
})

describe("McpManager connection cap", () => {
  it("a lazy kick past the cap records the failure instead of connecting", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      maxConnections: 1,
      global: { first: { type: "stdio", command: "1" }, second: { type: "stdio", command: "2" } },
    })
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "first")).toBe("connected")
    const second = manager.status().groups[0]!.servers.find((s) => s.name === "second")!
    expect(second.state).toBe("failed")
    expect(second.lastError).toContain("上限")
    await manager.stop()
  })

  it("a manual connect past the cap refuses with a conflict", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      maxConnections: 1,
      global: { first: { type: "stdio", command: "1" }, second: { type: "stdio", command: "2" } },
    })
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(() => manager.connect(GLOBAL_GROUP, "second")).toThrow(McpError)
    await manager.stop()
  })
})

describe("McpManager grouped actions", () => {
  it("addServer targets its group, connects in the background, and persists that group whole", async () => {
    const harness = fakeServerHarness()
    const persisted: Array<{ group: string; servers: Record<string, McpServerConfig> }> = []
    const manager = makeManager({
      harness,
      projects: { [DIR_A]: { existing: { type: "stdio", command: "e" } } },
      persist: (group, servers) => persisted.push({ group, servers }),
    })
    manager.ensureProject(DIR_B, {})
    manager.addServer(GLOBAL_GROUP, "late", { type: "stdio", command: "unused" })
    await manager.flush()

    expect(stateOf(manager, GLOBAL_GROUP, "late")).toBe("connected")
    expect(manager.toolsFor(DIR_B).executors.has("mcp__late__echo")).toBe(true)
    expect(persisted.at(-1)).toEqual({ group: GLOBAL_GROUP, servers: { late: { type: "stdio", command: "unused" } } })
    manager.addServer(DIR_A, "proj", { type: "stdio", command: "p" })
    const last = persisted.at(-1)!
    expect(last.group).toBe(DIR_A)
    expect(Object.keys(last.servers).sort()).toEqual(["existing", "proj"])
    await manager.stop()
  })

  it("addServer rejects an empty name, an unknown group, and a same-group duplicate — but allows cross-group same names", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, global: { dup: { type: "stdio", command: "x" } }, projects: { [DIR_A]: {} } })
    expect(() => manager.addServer(GLOBAL_GROUP, "  ", { type: "stdio", command: "x" })).toThrow(/name/)
    expect(() => manager.addServer("/nope", "a", { type: "stdio", command: "x" })).toThrow(/unknown MCP server group/)
    expect(() => manager.addServer(GLOBAL_GROUP, "dup", { type: "stdio", command: "x" })).toThrow(/already exists/)
    expect(() => manager.addServer(DIR_A, "dup", { type: "stdio", command: "y" })).not.toThrow()
    await manager.flush()
    expect(stateOf(manager, DIR_A, "dup")).toBe("connected")
    await manager.stop()
  })

  it("removeServer tears the connection down and drops the entry from its group only", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { gone: { type: "stdio", command: "x" } },
      projects: { [DIR_A]: { stays: { type: "stdio", command: "y" } } },
    })
    manager.toolsFor(DIR_A)
    await manager.flush()
    manager.removeServer(GLOBAL_GROUP, "gone")
    await manager.flush()
    const globalGroup = manager.status().groups.find((g) => g.id === GLOBAL_GROUP)!
    expect(globalGroup.servers).toEqual([])
    expect(stateOf(manager, DIR_A, "stays")).toBe("connected")
    expect(() => manager.removeServer(GLOBAL_GROUP, "ghost")).toThrow(/unknown MCP server/)
    await manager.stop()
  })

  it("updateServer reconnects with the new config; setEnabled flips with hot transitions", async () => {
    const seenConfigs: McpServerConfig[] = []
    const harness = fakeServerHarness()
    const manager = new McpManager({
      globalServers: { srv: { type: "stdio", command: "old" }, fl: { type: "stdio", command: "x" } },
      transportFactory: (name, cfg) => {
        seenConfigs.push(cfg)
        return harness.transportFactory(name)
      },
      backoffBaseMs: 1,
      backoffCapMs: 4,
      connectTimeoutMs: 500,
    })
    manager.toolsFor(DIR_A)
    await manager.flush()

    manager.updateServer(GLOBAL_GROUP, "srv", { type: "stdio", command: "new" })
    await manager.flush()
    const srv = manager.status().groups[0]!.servers.find((s) => s.name === "srv")!
    expect(srv.state).toBe("connected")
    expect(srv.config).toEqual({ type: "stdio", command: "new" })
    expect(seenConfigs.at(-1)).toEqual({ type: "stdio", command: "new" })

    manager.setEnabled(GLOBAL_GROUP, "fl", false)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "fl")).toBe("disabled")
    expect(manager.toolsFor(DIR_A).executors.has("mcp__fl__echo")).toBe(false)
    manager.setEnabled(GLOBAL_GROUP, "fl", true)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "fl")).toBe("connected")

    // same-value enable is a no-op (no reconnect churn)
    const calls = harness.attempts.length
    manager.setEnabled(GLOBAL_GROUP, "fl", true)
    await manager.flush()
    expect(harness.attempts).toHaveLength(calls)
    await manager.stop()
  })

  it("updateServer with an unchanged config is a no-op: the live connection survives", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, global: { srv: { type: "stdio", command: "same" } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "srv")).toBe("connected")

    const calls = harness.attempts.length
    manager.updateServer(GLOBAL_GROUP, "srv", { type: "stdio", command: "same" })
    await manager.flush()
    expect(harness.attempts).toHaveLength(calls)
    expect(stateOf(manager, GLOBAL_GROUP, "srv")).toBe("connected")
    await manager.stop()
  })

  it("disabling the global entry leaves the same-named project entry enabled and connected", async () => {
    const harness = fakeServerHarness()
    const persisted: Array<{ group: string; servers: Record<string, McpServerConfig> }> = []
    const manager = makeManager({
      harness,
      global: { fs: { type: "stdio", command: "g" } },
      projects: { [DIR_A]: { fs: { type: "stdio", command: "p" } } },
      persist: (group, servers) => persisted.push({ group, servers: structuredClone(servers) }),
    })
    // Connect both same-name entries: the project one via the view (it wins
    // the shadow), the global one via an explicit connect.
    manager.toolsFor(DIR_A)
    await manager.flush()
    manager.connect(GLOBAL_GROUP, "fs")
    await manager.flush()
    expect(stateOf(manager, GLOBAL_GROUP, "fs")).toBe("connected")
    expect(stateOf(manager, DIR_A, "fs")).toBe("connected")

    manager.setEnabled(GLOBAL_GROUP, "fs", false)
    await manager.flush()

    expect(stateOf(manager, GLOBAL_GROUP, "fs")).toBe("disabled")
    expect(stateOf(manager, DIR_A, "fs")).toBe("connected")
    expect(persisted.filter((p) => p.group === DIR_A)).toHaveLength(0)
    const projectConfig = manager.status().groups.find((g) => g.id === DIR_A)!.servers[0]!.config
    expect(projectConfig.enabled).not.toBe(false)
    await manager.stop()
  })

  it("move is atomic: same-name target refuses up front, both groups persist, a pure move stays lazy", async () => {
    const harness = fakeServerHarness()
    const persisted: Array<{ group: string; servers: Record<string, McpServerConfig> }> = []
    const manager = makeManager({
      harness,
      global: { weather: { type: "stdio", command: "global-cmd" }, nomove: { type: "stdio", command: "n" } },
      projects: { [DIR_A]: { weather: { type: "stdio", command: "project-cmd" } }, [DIR_B]: {} },
      persist: (group, servers) => persisted.push({ group, servers }),
    })
    manager.toolsFor(DIR_B) // connect the global entries
    await manager.flush()
    const callsBefore = harness.attempts.length
    persisted.length = 0

    // same-name target refuses BEFORE any mutation
    expect(() => manager.updateServer(GLOBAL_GROUP, "weather", { type: "stdio", command: "global-cmd" }, DIR_A)).toThrow(/already exists/)
    expect(stateOf(manager, GLOBAL_GROUP, "weather")).toBe("connected")
    expect(persisted).toEqual([])

    // pure move to a free target: atomic, lazy (no reconnect), both files persist
    manager.updateServer(GLOBAL_GROUP, "nomove", { type: "stdio", command: "n" }, DIR_B)
    expect(stateOf(manager, GLOBAL_GROUP, "nomove")).toBe("<absent>")
    expect(stateOf(manager, DIR_B, "nomove")).toBe("disconnected")
    expect(harness.attempts).toHaveLength(callsBefore)
    expect(persisted.map((p) => p.group).sort((a, b) => a.localeCompare(b))).toEqual([DIR_B, GLOBAL_GROUP].sort((a, b) => a.localeCompare(b)))
    const globalPersist = persisted.find((p) => p.group === GLOBAL_GROUP)!
    expect(globalPersist.servers).toEqual({ weather: { type: "stdio", command: "global-cmd" } })
    expect(persisted.find((p) => p.group === DIR_B)!.servers).toEqual({ nomove: { type: "stdio", command: "n" } })
    await manager.stop()
  })

  it("a move carrying a config change reconnects in the target group", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      global: { weather: { type: "stdio", command: "global-cmd" } },
      projects: { [DIR_A]: {} },
    })
    manager.toolsFor(DIR_A)
    await manager.flush()
    manager.updateServer(GLOBAL_GROUP, "weather", { type: "stdio", command: "moved-cmd" }, DIR_A)
    await manager.flush()
    expect(stateOf(manager, DIR_A, "weather")).toBe("connected")
    expect(manager.status().groups.find((g) => g.id === DIR_A)!.servers[0]!.config).toEqual({ type: "stdio", command: "moved-cmd" })
    await manager.stop()
  })
})

describe("McpManager project discovery and file reconcile", () => {
  it("ensureProject mounts a group lazily (no connections); dropProject retires and unmounts", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness })
    manager.ensureProject(DIR_A, { pa: { type: "stdio", command: "a" } })
    expect(harness.attempts).toEqual([])
    expect(stateOf(manager, DIR_A, "pa")).toBe("disconnected")

    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, DIR_A, "pa")).toBe("connected")

    await manager.dropProject(DIR_A)
    expect(stateOf(manager, DIR_A, "pa")).toBe("<absent>")
    expect(harness.attempts).toHaveLength(1) // no reconnect behind the drop
    await manager.stop()
  })

  it("ensureProject is idempotent (an existing group keeps its entries)", () => {
    const manager = makeManager({ projects: { [DIR_A]: { keep: { type: "stdio", command: "k" } } } })
    manager.ensureProject(DIR_A, { other: { type: "stdio", command: "o" } })
    expect(manager.status().groups.find((g) => g.id === DIR_A)!.servers.map((s) => s.name)).toEqual(["keep"])
    void manager.stop()
  })

  it("reconcile without live connections only updates the mapping (never connects)", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, projects: { [DIR_A]: { p: { type: "stdio", command: "old" } } } })
    manager.reconcileProject(DIR_A, { fresh: { type: "stdio", command: "f" }, p: { type: "stdio", command: "new" } })
    await manager.flush()
    expect(harness.attempts).toEqual([])
    const group = manager.status().groups.find((g) => g.id === DIR_A)!
    expect(group.servers.map((s) => `${s.name}:${s.config.command}`).sort()).toEqual(["fresh:f", "p:new"])
    expect(group.servers.every((s) => s.state === "disconnected")).toBe(true)
    await manager.stop()
  })

  it("reconcile retires a LIVE connection on a changed config and waits for the next use", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({ harness, projects: { [DIR_A]: { p: { type: "stdio", command: "old" } } } })
    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, DIR_A, "p")).toBe("connected")

    manager.reconcileProject(DIR_A, { p: { type: "stdio", command: "new" } })
    await manager.flush()
    expect(stateOf(manager, DIR_A, "p")).toBe("disconnected")
    expect(harness.attempts).toHaveLength(1) // no auto reconnect in the lazy model

    manager.toolsFor(DIR_A)
    await manager.flush()
    expect(stateOf(manager, DIR_A, "p")).toBe("connected")
    expect(manager.status().groups.find((g) => g.id === DIR_A)!.servers[0]!.config).toEqual({ type: "stdio", command: "new" })
    await manager.stop()
  })

  it("reconcile removes vanished entries and leaves deep-equal ones alone", async () => {
    const harness = fakeServerHarness()
    const manager = makeManager({
      harness,
      projects: { [DIR_A]: { stay: { type: "stdio", command: "s", args: ["-y"] }, gone: { type: "stdio", command: "g" } } },
    })
    manager.toolsFor(DIR_A)
    await manager.flush()
    const calls = harness.attempts.length

    manager.reconcileProject(DIR_A, { stay: { args: ["-y"], type: "stdio", command: "s" } })
    await manager.flush()
    const group = manager.status().groups.find((g) => g.id === DIR_A)!
    expect(group.servers.map((s) => s.name)).toEqual(["stay"])
    expect(stateOf(manager, DIR_A, "stay")).toBe("connected")
    expect(harness.attempts).toHaveLength(calls)
    await manager.stop()
  })

  it("reconcile never persists (the files are the source; the manager follows)", async () => {
    const persisted: Array<{ group: string; servers: Record<string, McpServerConfig> }> = []
    const manager = makeManager({ persist: (group, servers) => persisted.push({ group, servers }), projects: { [DIR_A]: { p: { type: "stdio", command: "old" } } } })
    manager.reconcileProject(DIR_A, { p: { type: "stdio", command: "new" } })
    expect(persisted).toEqual([])
    await manager.stop()
  })
})

describe("McpManager status snapshot shape", () => {
  it("global comes first, projects follow sorted by path; entries carry their group", async () => {
    const manager = makeManager({
      global: { g: { type: "stdio", command: "g" } },
      projects: { [DIR_B]: { b: { type: "stdio", command: "b" } }, [DIR_A]: { a: { type: "stdio", command: "a" } } },
    })
    const snapshot = manager.status()
    expect(snapshot.groups.map((g) => g.id)).toEqual([GLOBAL_GROUP, DIR_A, DIR_B])
    expect(snapshot.groups[0]!.servers[0]!.group).toBe(GLOBAL_GROUP)
    expect(snapshot.groups[1]!.servers[0]!.group).toBe(DIR_A)
    await manager.stop()
  })
})
