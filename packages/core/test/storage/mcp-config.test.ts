import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "../../src/storage/paths.js"
import {
  consolidateMcpConfig,
  loadMcpJson,
  loadMcpServers,
  mcpConfigPath,
  removeLegacyMcpSection,
  saveMcpJson,
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
const legacyYaml = [
  "# kclaw 主配置",
  "providers:",
  "  default: deepseek   # 主力模型",
  "permissions:",
  "  allow: []",
  "",
  "# 外部 MCP 服务器",
  "mcp:",
  "  servers:",
  "    filesystem:",
  "      type: stdio",
  "      command: npx",
  "      enabled: true",
  "",
  "subagents:",
  "  maxConcurrent: 4",
  "",
].join("\n")

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

describe("loadMcpServers merged read", () => {
  it("returns {} when neither source exists", () => {
    const paths = resolvePaths(home)
    expect(loadMcpServers(paths)).toEqual({})
  })

  it("reads the legacy config.yaml section alone", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, legacyYaml)
    expect(loadMcpServers(paths)).toEqual({
      filesystem: { type: "stdio", command: "npx", enabled: true },
    })
  })

  it("reads mcp.json alone", () => {
    const paths = resolvePaths(home)
    saveMcpJson(mcpConfigPath(home), { remote: http })
    expect(loadMcpServers(paths)).toEqual({ remote: http })
  })

  it("merges both, mcp.json winning on name collision", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, legacyYaml)
    saveMcpJson(mcpConfigPath(home), {
      filesystem: { type: "stdio", command: "overridden" },
      remote: http,
    })
    expect(loadMcpServers(paths)).toEqual({
      filesystem: { type: "stdio", command: "overridden" },
      remote: http,
    })
  })
})

describe("removeLegacyMcpSection", () => {
  it("removes only the mcp section, preserving everything else verbatim", () => {
    const p = join(home, "config.yaml")
    writeFileSync(p, legacyYaml)
    chmodSync(p, 0o600)
    expect(removeLegacyMcpSection(p)).toBe("removed")

    const after = readFileSync(p, "utf8")
    expect(after).toContain("# kclaw 主配置")
    expect(after).toContain("# 主力模型")
    expect(after).toContain("providers:")
    expect(after).toContain("permissions:")
    expect(after).toContain("subagents:")
    expect(after).toContain("maxConcurrent: 4")
    // the section's own comment stays (ownership of comments is unknowable), the section goes
    expect(after).toContain("# 外部 MCP 服务器")
    expect(after).not.toMatch(/^mcp\s*:/m)
    expect(after).not.toContain("filesystem:")
    expect(after).not.toContain("command: npx")
    // every preserved line is byte-identical to its original
    for (const line of after.split("\n")) {
      if (line === "") continue
      expect(legacyYaml.split("\n")).toContain(line)
    }
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it("keeps blank-line separation around the removed section", () => {
    const p = join(home, "config.yaml")
    writeFileSync(p, "providers:\n  default: x\n\nmcp:\n  servers:\n    a:\n      type: stdio\n      command: c\n\nsubagents:\n  maxConcurrent: 4\n")
    removeLegacyMcpSection(p)
    const after = readFileSync(p, "utf8")
    expect(after).toBe("providers:\n  default: x\n\n\nsubagents:\n  maxConcurrent: 4\n")
  })

  it("removes a section at end of file", () => {
    const p = join(home, "config.yaml")
    writeFileSync(p, "providers:\n  default: x\nmcp:\n  servers:\n    a:\n      type: stdio\n      command: c\n")
    expect(removeLegacyMcpSection(p)).toBe("removed")
    expect(readFileSync(p, "utf8")).toBe("providers:\n  default: x\n")
  })

  it("removes a flow-style single-line section", () => {
    const p = join(home, "config.yaml")
    writeFileSync(p, "providers:\n  default: x\nmcp: {servers: {}}\nsubagents:\n  maxConcurrent: 4\n")
    expect(removeLegacyMcpSection(p)).toBe("removed")
    expect(readFileSync(p, "utf8")).toBe("providers:\n  default: x\nsubagents:\n  maxConcurrent: 4\n")
  })

  it("returns absent and leaves the file untouched when there is no mcp section", () => {
    const p = join(home, "config.yaml")
    const noMcp = legacyYaml.split("\n").filter((l) => l !== "# 外部 MCP 服务器" && !/^(mcp:|  servers:|    filesystem:|      type:|      command:|      enabled:)$/.test(l)).join("\n")
    writeFileSync(p, noMcp)
    const before = readFileSync(p, "utf8")
    expect(removeLegacyMcpSection(p)).toBe("absent")
    expect(readFileSync(p, "utf8")).toBe(before)
  })

  it("returns absent for a missing config file", () => {
    expect(removeLegacyMcpSection(join(home, "config.yaml"))).toBe("absent")
    expect(existsSync(join(home, "config.yaml"))).toBe(false)
  })

  it("does not touch a nested mcp-like key under another section", () => {
    const p = join(home, "config.yaml")
    writeFileSync(p, "providers:\n  mcp: not-a-section\n  default: x\n")
    expect(removeLegacyMcpSection(p)).toBe("absent")
    expect(readFileSync(p, "utf8")).toBe("providers:\n  mcp: not-a-section\n  default: x\n")
  })
})

describe("consolidateMcpConfig", () => {
  it("writes everything into mcp.json and strips the legacy section", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, legacyYaml)
    consolidateMcpConfig(paths, { filesystem: stdio, remote: http })

    expect(loadMcpJson(mcpConfigPath(home))).toEqual({ filesystem: stdio, remote: http })
    const after = readFileSync(paths.config, "utf8")
    expect(after).not.toMatch(/^mcp\s*:/m)
    expect(after).toContain("providers:")
    expect(after).toContain("subagents:")
    // the merged read now serves the saved set
    expect(loadMcpServers(paths)).toEqual({ filesystem: stdio, remote: http })
  })

  it("is idempotent: a second consolidation leaves config.yaml unchanged", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, legacyYaml)
    consolidateMcpConfig(paths, { filesystem: stdio })
    const once = readFileSync(paths.config, "utf8")
    consolidateMcpConfig(paths, { filesystem: stdio })
    expect(readFileSync(paths.config, "utf8")).toBe(once)
  })
})
