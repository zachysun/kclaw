import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { resolvePaths } from "../../src/storage/paths.js"
import {
  appendDecidedRule,
  decidedRuleStrings,
  deleteDecidedRule,
  globalDecidedRulesPath,
  isGitTracked,
  loadDecidedRules,
  loadDecidedRulesForRun,
  narrowDecidedRule,
  projectDecidedRulesPath,
  PROJECT_RULES_REL,
} from "../../src/storage/decided-rules.js"

let home: string
let workspace: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-dr-home-"))
  workspace = mkdtempSync(join(tmpdir(), "kclaw-dr-ws-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe("narrowDecidedRule", () => {
  it("narrows a command to first word + subcommand prefix", () => {
    const call = { name: "exec", args: { command: "git push origin main" } }
    expect(narrowDecidedRule(call)).toBe("exec:git push*")
  })

  it("keeps a single-word command exact", () => {
    expect(narrowDecidedRule({ name: "exec", args: { command: "ls" } })).toBe("exec:ls")
  })

  it("narrows a chained command to its first segment", () => {
    expect(narrowDecidedRule({ name: "exec", args: { command: "git status; rm -rf /" } })).toBe("exec:git status*")
  })

  it("collapses the command token to its basename", () => {
    expect(narrowDecidedRule({ name: "exec", args: { command: "/bin/rm -rf build" } })).toBe("exec:rm -rf*")
  })

  it("persists the exact resolved path for path tools", () => {
    const rule = narrowDecidedRule({ name: "fs_write", args: { path: "a/b.txt" } }, workspace)
    // workspace itself is realpath'd (macOS /var → /private/var), matching the engine's boundary form
    expect(rule).toBe(`fs_write:${join(realpathSync(workspace), "a/b.txt")}`)
  })

  it("falls back to a tool-level rule for schema-less tools", () => {
    expect(narrowDecidedRule({ name: "mcp__srv__do", args: { x: 1 } })).toBe("mcp__srv__do")
  })
})

describe("decided rules file round-trip", () => {
  it("load on a missing file yields []", () => {
    expect(loadDecidedRules(globalDecidedRulesPath(home))).toEqual([])
  })

  it("append + load + delete round-trips and keeps 0600", () => {
    const p = globalDecidedRulesPath(home)
    appendDecidedRule(p, {
      rule: "exec:git push*",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "exec", argsJson: '{"command":"git push origin main"}', sessionId: "ses_1" },
    })
    const rules = loadDecidedRules(p)
    expect(rules).toHaveLength(1)
    expect(rules[0]!.rule).toBe("exec:git push*")
    expect(rules[0]!.origin.tool).toBe("exec")
    // 0600: owner rw only (mask off platform bits)
    expect(statSync(p).mode & 0o777).toBe(0o600)

    expect(deleteDecidedRule(p, 0)?.rule).toBe("exec:git push*")
    expect(loadDecidedRules(p)).toEqual([])
    expect(deleteDecidedRule(p, 5)).toBeUndefined()
  })

  it("tolerates a corrupt file by returning []", () => {
    const p = globalDecidedRulesPath(home)
    writeFileSync(p, "{{{ not yaml")
    expect(loadDecidedRules(p)).toEqual([])
  })

  it("drops entries that are not objects but keeps valid ones", () => {
    const p = globalDecidedRulesPath(home)
    writeFileSync(p, "rules:\n  - 42\n  - rule: exec:ls\n")
    const rules = loadDecidedRules(p)
    expect(rules).toHaveLength(1)
    expect(rules[0]!.rule).toBe("exec:ls")
  })
})

describe("project scope defenses", () => {
  it("creates .kclaw, writes the file and gitignores it on first append", () => {
    const p = projectDecidedRulesPath(workspace)
    appendDecidedRule(
      p,
      { rule: "fs_write:x", decidedAt: "2026-09-06T00:00:00.000Z", origin: { tool: "fs_write", argsJson: "{}" } },
      { workspace },
    )
    expect(existsSync(p)).toBe(true)
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(gitignore).toContain(PROJECT_RULES_REL)
    // idempotent: a second append does not duplicate the gitignore entry
    appendDecidedRule(
      p,
      { rule: "exec:ls", decidedAt: "2026-09-06T00:00:01.000Z", origin: { tool: "exec", argsJson: "{}" } },
      { workspace },
    )
    expect(readFileSync(join(workspace, ".gitignore"), "utf8").split(PROJECT_RULES_REL).length - 1).toBe(1)
    expect(loadDecidedRules(p)).toHaveLength(2)
  })

  it("isGitTracked detects tracked vs untracked vs non-repo", () => {
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    writeFileSync(join(workspace, PROJECT_RULES_REL), "rules: []\n")
    execSync("git init -q", { cwd: workspace })
    // untracked → false
    expect(isGitTracked(workspace, PROJECT_RULES_REL)).toBe(false)
    // staged → true
    execSync(`git add ${JSON.stringify(PROJECT_RULES_REL)}`, { cwd: workspace })
    expect(isGitTracked(workspace, PROJECT_RULES_REL)).toBe(true)
    // a directory that is not a repo at all → false
    const nonRepo = mkdtempSync(join(tmpdir(), "kclaw-dr-norepo-"))
    try {
      expect(isGitTracked(nonRepo, "anything")).toBe(false)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

describe("loadDecidedRulesForRun", () => {
  it("merges global and project rule strings", () => {
    const paths = resolvePaths(home)
    appendDecidedRule(globalDecidedRulesPath(home), {
      rule: "exec:ls",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "exec", argsJson: "{}" },
    })
    appendDecidedRule(
      projectDecidedRulesPath(workspace),
      { rule: "fs_write:x", decidedAt: "2026-09-06T00:00:00.000Z", origin: { tool: "fs_write", argsJson: "{}" } },
      { workspace },
    )
    const snap = loadDecidedRulesForRun(paths, workspace)
    expect(snap.rules).toEqual(["exec:ls", "fs_write:x"])
    expect(snap.projectIgnored).toBe(false)
  })

  it("ignores a git-tracked project file with projectIgnored=true", () => {
    const paths = resolvePaths(home)
    appendDecidedRule(globalDecidedRulesPath(home), {
      rule: "exec:ls",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "exec", argsJson: "{}" },
    })
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    writeFileSync(join(workspace, PROJECT_RULES_REL), "rules:\n  - rule: exec:evil*\n")
    execSync("git init -q", { cwd: workspace })
    execSync(`git add ${JSON.stringify(PROJECT_RULES_REL)}`, { cwd: workspace })
    const snap = loadDecidedRulesForRun(paths, workspace)
    expect(snap.projectIgnored).toBe(true)
    expect(snap.rules).toEqual(["exec:ls"])
  })
})
