import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, McpError } from "@kclaw/core"
import type { McpServerConfig, McpServerStatus } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

/** In-memory McpRoutesView fake: records calls, mirrors McpManager's error classes. */
function fakeManager(initial: Record<string, McpServerConfig> = {}) {
  const servers = new Map<string, McpServerConfig>(Object.entries(initial))
  const calls: string[] = []
  const view = {
    calls,
    status(): McpServerStatus[] {
      return [...servers.entries()].map(([name, config]) => ({
        name,
        config,
        scope: "global",
        state: config.enabled === false ? "disabled" : "connected",
        tools: [{ name: `mcp__${name}__tool`, server: name, originalName: "tool", description: "d" }],
      }))
    },
    async flush(): Promise<void> {},
    addServer(name: string, config: McpServerConfig, layer: string = "global"): void {
      calls.push(`add:${name}:${layer}`)
      if (name === "dupe") throw new McpError("conflict", `MCP server already exists: ${name}`)
      servers.set(name, config)
    },
    updateServer(name: string, config: McpServerConfig): void {
      calls.push(`update:${name}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      servers.set(name, config)
    },
    removeServer(name: string): void {
      calls.push(`remove:${name}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      servers.delete(name)
    },
    setEnabled(name: string, enabled: boolean): void {
      calls.push(`enable:${name}:${enabled}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      const old = servers.get(name)!
      servers.set(name, { ...old, enabled } as McpServerConfig)
    },
    reconnect(name: string): void {
      calls.push(`reconnect:${name}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      if (servers.get(name)!.enabled === false) throw new McpError("invalid", `MCP server ${name} is disabled`)
    },
  }
  return view
}

describe("mcp routes", () => {
  let home: string
  let app: FastifyInstance

  function buildApp(view?: ReturnType<typeof fakeManager>): Promise<FastifyInstance> {
    const config = structuredClone(defaultConfig)
    return createApp({ home, token: "t1", stores: { config }, mcp: view })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-mcp-routes-"))
    app = await buildApp(fakeManager({ existing: { type: "stdio", command: "run" } }))
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("GET /mcp returns the status snapshot with config", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { servers: McpServerStatus[] }
    expect(body.servers).toHaveLength(1)
    expect(body.servers[0].name).toBe("existing")
    expect(body.servers[0].config).toEqual({ type: "stdio", command: "run" })
    expect(body.servers[0].scope).toBe("global")
    expect(body.servers[0].tools[0].name).toBe("mcp__existing__tool")
  })

  it("POST /mcp/servers defaults to the global layer and forwards an explicit project layer", async () => {
    const view = fakeManager()
    await app.close()
    app = await buildApp(view)

    const def = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "g1", config: { type: "stdio", command: "x" } },
    })
    expect(def.statusCode).toBe(200)
    expect(view.calls).toContain("add:g1:global")

    const project = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "p1", config: { type: "stdio", command: "x" }, layer: "project" },
    })
    expect(project.statusCode).toBe(200)
    expect(view.calls).toContain("add:p1:project")
  })

  it("POST /mcp/servers rejects an unknown layer with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "a", config: { type: "stdio", command: "x" }, layer: "workspace" },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain("layer")
  })

  it("POST /mcp/servers creates a server and returns the snapshot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "remote", config: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer k" } } },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { servers: McpServerStatus[] }).servers.map((s) => s.name)).toEqual(["existing", "remote"])
  })

  it("POST /mcp/servers rejects bad payloads with 400 and duplicates with 409", async () => {
    const noName = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { config: { type: "stdio", command: "x" } } })
    expect(noName.statusCode).toBe(400)

    const badConfig = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "stdio" } } })
    expect(badConfig.statusCode).toBe(400)
    expect((badConfig.json() as { error: string }).error).toContain("command")

    const badUrl = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "http", url: "not a url" } } })
    expect(badUrl.statusCode).toBe(400)

    const dupe = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "dupe", config: { type: "stdio", command: "x" } } })
    expect(dupe.statusCode).toBe(409)
  })

  it("PATCH /mcp/servers/:name updates and 404s unknown names", async () => {
    const ok = await app.inject({ method: "PATCH", url: "/mcp/servers/existing", headers: AUTH, payload: { config: { type: "http", url: "https://y.test" } } })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as { servers: McpServerStatus[] }
    expect(body.servers[0].config).toEqual({ type: "http", url: "https://y.test" })

    const missing = await app.inject({ method: "PATCH", url: "/mcp/servers/ghost", headers: AUTH, payload: { config: { type: "stdio", command: "x" } } })
    expect(missing.statusCode).toBe(404)
  })

  it("DELETE /mcp/servers/:name removes the server", async () => {
    const res = await app.inject({ method: "DELETE", url: "/mcp/servers/existing", headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { servers: McpServerStatus[] }).servers).toEqual([])
  })

  it("POST enable flips the persistent flag and validates the body", async () => {
    const on = await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { enabled: false } })
    expect(on.statusCode).toBe(200)
    expect((on.json() as { servers: McpServerStatus[] }).servers[0].state).toBe("disabled")

    const bad = await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { enabled: "yes" } })
    expect(bad.statusCode).toBe(400)
  })

  it("POST reconnect refuses disabled servers with 400", async () => {
    await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { enabled: false } })
    const res = await app.inject({ method: "POST", url: "/mcp/servers/existing/reconnect", headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain("disabled")
  })

  it("unauthenticated requests are rejected", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp" })
    expect(res.statusCode).toBe(401)
  })

  it("without a manager the snapshot is empty and the action family answers 503", async () => {
    await app.close()
    app = await buildApp(undefined)
    const list = await app.inject({ method: "GET", url: "/mcp", headers: AUTH })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({ servers: [] })

    const post = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "stdio", command: "x" } } })
    expect(post.statusCode).toBe(503)

    const patch = await app.inject({ method: "PATCH", url: "/mcp/servers/a", headers: AUTH, payload: { config: { type: "stdio", command: "x" } } })
    expect(patch.statusCode).toBe(503)

    const del = await app.inject({ method: "DELETE", url: "/mcp/servers/a", headers: AUTH })
    expect(del.statusCode).toBe(503)

    const enable = await app.inject({ method: "POST", url: "/mcp/servers/a/enable", headers: AUTH, payload: { enabled: true } })
    expect(enable.statusCode).toBe(503)

    const reconnect = await app.inject({ method: "POST", url: "/mcp/servers/a/reconnect", headers: AUTH })
    expect(reconnect.statusCode).toBe(503)
  })
})

describe("mcp routes review fixes", () => {
  let home: string
  let app: FastifyInstance

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-mcp-rv-"))
    app = await createApp({ home, token: "t1", stores: { config: structuredClone(defaultConfig) }, mcp: fakeManager() })
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("trims the name before storing and rejects names outside the safe charset", async () => {
    const trimmed = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "  spaced  ", config: { type: "stdio", command: "x" } },
    })
    expect(trimmed.statusCode).toBe(200)
    expect((trimmed.json() as { servers: McpServerStatus[] }).servers.map((s) => s.name)).toContain("spaced")

    const weird = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "my server.v2", config: { type: "stdio", command: "x" } },
    })
    expect(weird.statusCode).toBe(400)
    expect((weird.json() as { error: string }).error).toContain("letters, digits")
  })
})
