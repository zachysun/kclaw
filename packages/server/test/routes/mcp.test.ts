import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, McpError } from "@kclaw/core"
import type { McpServerConfig, McpServerStatus } from "@kclaw/core"
import type { McpSnapshot } from "@kclaw/core/protocol"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }
const DIR = "/tmp/proj-x"

/** One entry as the fake snapshot carries it (global group, connected). */
function entry(name: string, config: McpServerConfig): McpServerStatus {
  return {
    name,
    config,
    group: "global",
    state: config.enabled === false ? "disabled" : "connected",
    tools: [{ name: `mcp__${name}__tool`, server: name, originalName: "tool", description: "d" }],
  }
}

/** In-memory McpRoutesView fake: records calls, mirrors McpManager's error classes. */
function fakeManager(initial: Record<string, McpServerConfig> = {}) {
  const servers = new Map<string, McpServerConfig>(Object.entries(initial))
  const calls: string[] = []
  const view = {
    calls,
    status(): McpSnapshot {
      return {
        groups: [
          {
            id: "global",
            servers: [...servers.entries()].map(([name, config]) => entry(name, config)),
          },
        ],
      }
    },
    async flush(): Promise<void> {},
    addServer(group: string, name: string, config: McpServerConfig): void {
      calls.push(`add:${group}:${name}`)
      if (name === "dupe") throw new McpError("conflict", `MCP server already exists: ${name}`)
      if (group === "/gone") throw new McpError("not-found", `unknown MCP server group: ${group}`)
      servers.set(name, config)
    },
    updateServer(group: string, name: string, config: McpServerConfig, toGroup?: string): void {
      calls.push(`update:${group}:${name}${toGroup !== undefined ? `->${toGroup}` : ""}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      servers.set(name, config)
    },
    removeServer(group: string, name: string): void {
      calls.push(`remove:${group}:${name}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      servers.delete(name)
    },
    setEnabled(group: string, name: string, enabled: boolean): void {
      calls.push(`enable:${group}:${name}:${enabled}`)
      if (!servers.has(name)) throw new McpError("not-found", `unknown MCP server: ${name}`)
      const old = servers.get(name)!
      servers.set(name, { ...old, enabled } as McpServerConfig)
    },
    connect(group: string, name: string): void {
      calls.push(`connect:${group}:${name}`)
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
    return createApp({ home, token: "t1", stores: { config }, mcp: view, mainWorkspace: "/tmp/main" })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-mcp-routes-"))
    app = await buildApp(fakeManager({ existing: { type: "stdio", command: "run" } }))
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("GET /mcp returns the grouped snapshot with config and the main workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as McpSnapshot & { mainWorkspace: string }
    expect(body.mainWorkspace).toBe("/tmp/main")
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0].id).toBe("global")
    expect(body.groups[0].servers[0].name).toBe("existing")
    expect(body.groups[0].servers[0].config).toEqual({ type: "stdio", command: "run" })
    expect(body.groups[0].servers[0].group).toBe("global")
    expect(body.groups[0].servers[0].tools[0].name).toBe("mcp__existing__tool")
  })

  it("POST /mcp/servers forwards the explicit group", async () => {
    const view = fakeManager()
    await app.close()
    app = await buildApp(view)

    const global = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "g1", config: { type: "stdio", command: "x" }, group: "global" },
    })
    expect(global.statusCode).toBe(200)
    expect(view.calls).toContain("add:global:g1")

    const project = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "p1", config: { type: "stdio", command: "x" }, group: DIR },
    })
    expect(project.statusCode).toBe(200)
    expect(view.calls).toContain(`add:${DIR}:p1`)
  })

  it("POST /mcp/servers rejects a missing or malformed group with 400 and an unknown group with 404", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "a", config: { type: "stdio", command: "x" } },
    })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as { error: string }).error).toContain("group")

    const malformed = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "a", config: { type: "stdio", command: "x" }, group: "workspace" },
    })
    expect(malformed.statusCode).toBe(400)

    const unknown = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "a", config: { type: "stdio", command: "x" }, group: "/gone" },
    })
    expect(unknown.statusCode).toBe(404)
  })

  it("POST /mcp/servers creates a server and returns the grouped snapshot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "remote", config: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer k" } }, group: "global" },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as McpSnapshot
    expect(body.groups[0].servers.map((s) => s.name)).toEqual(["existing", "remote"])
  })

  it("POST /mcp/servers rejects bad payloads with 400 and duplicates with 409", async () => {
    const noName = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { config: { type: "stdio", command: "x" }, group: "global" } })
    expect(noName.statusCode).toBe(400)

    const badConfig = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "stdio" }, group: "global" } })
    expect(badConfig.statusCode).toBe(400)
    expect((badConfig.json() as { error: string }).error).toContain("command")

    const badUrl = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "http", url: "not a url" }, group: "global" } })
    expect(badUrl.statusCode).toBe(400)

    const dupe = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "dupe", config: { type: "stdio", command: "x" }, group: "global" } })
    expect(dupe.statusCode).toBe(409)
  })

  it("PATCH /mcp/servers/:name updates in its group and 404s unknown names", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: "/mcp/servers/existing",
      headers: AUTH,
      payload: { group: "global", config: { type: "http", url: "https://y.test" } },
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as McpSnapshot
    expect(body.groups[0].servers[0].config).toEqual({ type: "http", url: "https://y.test" })

    const missing = await app.inject({
      method: "PATCH",
      url: "/mcp/servers/ghost",
      headers: AUTH,
      payload: { group: "global", config: { type: "stdio", command: "x" } },
    })
    expect(missing.statusCode).toBe(404)
  })

  it("PATCH carries toGroup through as the move", async () => {
    const view = fakeManager({ existing: { type: "stdio", command: "run" } })
    await app.close()
    app = await buildApp(view)

    const move = await app.inject({
      method: "PATCH",
      url: "/mcp/servers/existing",
      headers: AUTH,
      payload: { group: "global", toGroup: DIR, config: { type: "stdio", command: "moved" } },
    })
    expect(move.statusCode).toBe(200)
    expect(view.calls).toContain(`update:global:existing->${DIR}`)

    const badGroup = await app.inject({
      method: "PATCH",
      url: "/mcp/servers/existing",
      headers: AUTH,
      payload: { group: "global", toGroup: "nowhere", config: { type: "stdio", command: "x" } },
    })
    expect(badGroup.statusCode).toBe(400)
  })

  it("DELETE /mcp/servers/:name requires the group and removes the server", async () => {
    const noGroup = await app.inject({ method: "DELETE", url: "/mcp/servers/existing", headers: AUTH })
    expect(noGroup.statusCode).toBe(400)

    const res = await app.inject({ method: "DELETE", url: `/mcp/servers/existing?group=${encodeURIComponent("global")}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect((res.json() as McpSnapshot).groups[0].servers).toEqual([])
  })

  it("POST enable flips the persistent flag and validates the body", async () => {
    const on = await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { group: "global", enabled: false } })
    expect(on.statusCode).toBe(200)
    expect((on.json() as McpSnapshot).groups[0].servers[0].state).toBe("disabled")

    const bad = await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { group: "global", enabled: "yes" } })
    expect(bad.statusCode).toBe(400)
  })

  it("POST connect refuses disabled servers with 400", async () => {
    await app.inject({ method: "POST", url: "/mcp/servers/existing/enable", headers: AUTH, payload: { group: "global", enabled: false } })
    const res = await app.inject({ method: "POST", url: "/mcp/servers/existing/connect", headers: AUTH, payload: { group: "global" } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain("disabled")
  })

  it("unauthenticated requests are rejected", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp" })
    expect(res.statusCode).toBe(401)
  })

  it("without a manager the snapshot is an empty group list and the action family answers 503", async () => {
    await app.close()
    app = await buildApp(undefined)
    const list = await app.inject({ method: "GET", url: "/mcp", headers: AUTH })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({ groups: [], mainWorkspace: "/tmp/main" })

    const post = await app.inject({ method: "POST", url: "/mcp/servers", headers: AUTH, payload: { name: "a", config: { type: "stdio", command: "x" }, group: "global" } })
    expect(post.statusCode).toBe(503)

    const patch = await app.inject({ method: "PATCH", url: "/mcp/servers/a", headers: AUTH, payload: { group: "global", config: { type: "stdio", command: "x" } } })
    expect(patch.statusCode).toBe(503)

    const del = await app.inject({ method: "DELETE", url: "/mcp/servers/a?group=global", headers: AUTH })
    expect(del.statusCode).toBe(503)

    const enable = await app.inject({ method: "POST", url: "/mcp/servers/a/enable", headers: AUTH, payload: { group: "global", enabled: true } })
    expect(enable.statusCode).toBe(503)

    const connect = await app.inject({ method: "POST", url: "/mcp/servers/a/connect", headers: AUTH, payload: { group: "global" } })
    expect(connect.statusCode).toBe(503)
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
      payload: { name: "  spaced  ", config: { type: "stdio", command: "x" }, group: "global" },
    })
    expect(trimmed.statusCode).toBe(200)
    expect((trimmed.json() as McpSnapshot).groups[0].servers.map((s) => s.name)).toContain("spaced")

    const weird = await app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: AUTH,
      payload: { name: "my server.v2", config: { type: "stdio", command: "x" }, group: "global" },
    })
    expect(weird.statusCode).toBe(400)
    expect((weird.json() as { error: string }).error).toContain("letters, digits")
  })
})
