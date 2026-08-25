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
