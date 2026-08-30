/**
 * Shared slash-command table tests — the single source both frontends read:
 * builtin names/usages/descriptions with per-surface visibility, the
 * `/cmd args` parser (same semantics the CLI `dispatch` has always had), and
 * the prefix-completion helper that feeds the CLI Tab completer and the web
 * suggestion menu.
 */
import { describe, it, expect } from "vitest"
import { SLASH_COMMANDS, parseSlashInput, slashCompletions } from "../src/commands.js"

describe("SLASH_COMMANDS", () => {
  it("has unique names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("renders every usage from its own name", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.usage.startsWith(`/${c.name}`)).toBe(true)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  it("keeps attach and exit terminal-only", () => {
    const surfaces = (name: string) => SLASH_COMMANDS.find((c) => c.name === name)?.surfaces
    expect(surfaces("attach")).toEqual(["cli"])
    expect(surfaces("exit")).toEqual(["cli"])
  })

  it("exposes the session/model/compact commands on both surfaces", () => {
    for (const name of ["new", "clear", "sessions", "model", "readonly", "compact", "help", "memory"]) {
      const c = SLASH_COMMANDS.find((x) => x.name === name)
      expect(c?.surfaces).toContain("cli")
      expect(c?.surfaces).toContain("web")
    }
  })

  it("steer/wait/interrupt/queue are cli-only", () => {
    for (const name of ["steer", "wait", "interrupt", "queue"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name)!
      expect(cmd.surfaces).toEqual(["cli"])
    }
    expect(slashCompletions("/st", "web")).toHaveLength(0)
    expect(slashCompletions("/st", "cli").map((c) => c.name)).toEqual(["steer"])
  })
})

describe("parseSlashInput", () => {
  it("returns null for plain messages", () => {
    expect(parseSlashInput("hello world")).toBeNull()
    expect(parseSlashInput("")).toBeNull()
  })

  it("splits a bare /command", () => {
    expect(parseSlashInput("/compact")).toEqual({ command: "compact", args: "" })
  })

  it("splits command and args, trimming around the args", () => {
    expect(parseSlashInput("/compact  保留工具调用  ")).toEqual({ command: "compact", args: "保留工具调用" })
  })

  it("keeps an empty command for a lone slash", () => {
    expect(parseSlashInput("/")).toEqual({ command: "", args: "" })
  })
})

describe("slashCompletions", () => {
  it("suggests nothing for non-slash or argumented input", () => {
    expect(slashCompletions("hello", "web")).toEqual([])
    expect(slashCompletions("/compact now", "web")).toEqual([])
  })

  it("suggests every surface command for a bare slash, in display order", () => {
    const names = slashCompletions("/", "web").map((c) => c.name)
    expect(names).toEqual(["new", "clear", "sessions", "model", "readonly", "compact", "help", "memory"])
  })

  it("prefix-matches a partially typed command", () => {
    expect(slashCompletions("/co", "web").map((c) => c.name)).toEqual(["compact"])
    expect(slashCompletions("/s", "cli").map((c) => c.name)).toEqual(["sessions", "steer"])
  })

  it("hides surface-exclusive commands on the other surface", () => {
    expect(slashCompletions("/a", "web")).toEqual([])
    expect(slashCompletions("/a", "cli").map((c) => c.name)).toEqual(["attach"])
    expect(slashCompletions("/e", "web")).toEqual([])
    expect(slashCompletions("/e", "cli").map((c) => c.name)).toEqual(["exit"])
  })

  it("suggests nothing for unknown prefixes", () => {
    expect(slashCompletions("/zzz", "cli")).toEqual([])
  })
})
