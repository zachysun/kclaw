/**
 * CLI Tab-completion tests: the readline completer turns the shared
 * completion table into full `/name` line candidates (CLI surface only —
 * builtins plus `/exit`), and passes the line through unchanged so readline
 * can compute the common prefix. Custom `~/commands/*.md` commands are NOT
 * suggested (the completer reads the shared builtin table only); they stay
 * discoverable via /help.
 */
import { describe, it, expect } from "vitest"
import { slashCompleter } from "../src/slash.js"

describe("slashCompleter", () => {
  it("completes a partially typed builtin command", () => {
    const [hits, line] = slashCompleter("/co")
    expect(hits).toEqual(["/compact"])
    expect(line).toBe("/co")
  })

  it("suggests every CLI builtin (including attach and exit) for a bare slash", () => {
    const [hits] = slashCompleter("/")
    expect(hits).toEqual([
      "/new",
      "/clear",
      "/sessions",
      "/model",
      "/readonly",
      "/attach",
      "/compact",
      "/steer",
      "/wait",
      "/interrupt",
      "/queue",
      "/help",
      "/memory",
      "/exit",
    ])
  })

  it("suggests nothing for plain text, argumented input, or unknown prefixes", () => {
    expect(slashCompleter("hello")[0]).toEqual([])
    expect(slashCompleter("/compact now")[0]).toEqual([])
    expect(slashCompleter("/zzz")[0]).toEqual([])
  })
})
