import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import {
  loadMcpJson,
  loadProjectMcpServers,
  mcpConfigPath,
  projectMcpConfigPath,
  PROJECT_MCP_REL,
  saveMcpJson,
  saveProjectMcpJson,
} from "../../src/storage/mcp-config.js"
import type { McpServerConfig } from "../../src/mcp/manager.js"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-mcp-cfg-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const stdio: McpServerConfig = { type: "stdio", command: "npx", args: ["-y", "srv"] }
const http: McpServerConfig = { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } }

describe("mcp.json round-trip", () => {
  it("saves and loads servers", () => {
    const p = mcpConfigPath(home)
    saveMcpJson(p, { filesystem: stdio, remote: http })
    expect(loadMcpJson(p)).toEqual({ filesystem: stdio, remote: http })
  })

  it("writes with mode 0600", () => {
    const p = mcpConfigPath(home)
    saveMcpJson(p, { filesystem: stdio })
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it("returns {} for a missing file", () => {
    expect(loadMcpJson(mcpConfigPath(home))).toEqual({})
  })

  it("returns {} with no throw for corrupt content", () => {
    const p = mcpConfigPath(home)
    writeFileSync(p, "{not json")
    expect(loadMcpJson(p)).toEqual({})
  })

  it("tolerates a null top level", () => {
    const p = mcpConfigPath(home)
    writeFileSync(p, "null")
    expect(loadMcpJson(p)).toEqual({})
  })
})

describe("project layer (mcp-project-scope-spec)", () => {
  let workspace: string
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "kclaw-mcp-ws-"))
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("projectMcpConfigPath lands inside <workspace>/.kclaw", () => {
    expect(projectMcpConfigPath(workspace)).toBe(join(workspace, ".kclaw", "mcp.json"))
    expect(PROJECT_MCP_REL).toBe(join(".kclaw", "mcp.json"))
  })

  it("saves and loads the project file with birth defenses (dir + gitignore, idempotent)", () => {
    saveProjectMcpJson(workspace, { local: stdio })
    const p = projectMcpConfigPath(workspace)
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(gitignore).toContain(PROJECT_MCP_REL)
    // a second save must not duplicate the gitignore entry
    saveProjectMcpJson(workspace, { local: stdio, other: http })
    expect(readFileSync(join(workspace, ".gitignore"), "utf8").split(PROJECT_MCP_REL).length - 1).toBe(1)
    expect(loadProjectMcpServers(workspace)).toEqual({ local: stdio, other: http })
  })

  it("keeps an existing .gitignore intact and appends cleanly without a trailing newline", () => {
    writeFileSync(join(workspace, ".gitignore"), "node_modules/") // no trailing newline
    saveProjectMcpJson(workspace, { local: stdio })
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(gitignore).toBe(`node_modules/\n${PROJECT_MCP_REL}\n`)
  })

  it("reads a missing project file as {} silently", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(loadProjectMcpServers(workspace)).toEqual({})
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("reads a corrupt project file as {} with a warning", () => {
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    const p = projectMcpConfigPath(workspace)
    writeFileSync(p, "{not json")
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(loadProjectMcpServers(workspace)).toEqual({})
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("unreadable")
    errSpy.mockRestore()
  })

  it("reads a wrong-shape project file as {} silently", () => {
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    const p = projectMcpConfigPath(workspace)
    writeFileSync(p, JSON.stringify({ servers: ["not", "an", "object"] }))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(loadProjectMcpServers(workspace)).toEqual({})
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("ignores a git-tracked project file with a warning (clones must not ship servers)", () => {
    // written directly (bypassing the birth defenses) so git add can stage it:
    // this case targets the LOAD defense, not the write defense
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    saveMcpJson(projectMcpConfigPath(workspace), { local: stdio })
    execSync("git init -q", { cwd: workspace })
    execSync(`git add ${JSON.stringify(PROJECT_MCP_REL)}`, { cwd: workspace })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(loadProjectMcpServers(workspace)).toEqual({})
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("git-tracked")
    errSpy.mockRestore()
  })

  it("treats a non-repo workspace as untracked (fail-open for loading)", () => {
    saveProjectMcpJson(workspace, { local: stdio })
    expect(loadProjectMcpServers(workspace)).toEqual({ local: stdio })
  })
})
