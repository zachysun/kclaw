/**
 * Colour discipline (spec C1): the per-stream verdict, the explicit --color
 * override, and the env handed to third-party colour libraries — which must
 * reach this process only, never the daemon.
 */
import { describe, it, expect, afterEach } from "vitest"
import { configureColor, dim, originalEnv, red, shouldColor } from "../src/color.js"

const TTY = { isTTY: true }
const PIPE = { isTTY: false }

describe("shouldColor", () => {
  it("auto colours a TTY", () => {
    expect(shouldColor("auto", TTY, { TERM: "xterm-256color" })).toBe(true)
  })
  it("auto stays plain off a TTY", () => {
    expect(shouldColor("auto", PIPE, { TERM: "xterm-256color" })).toBe(false)
    expect(shouldColor("auto", {}, {})).toBe(false)
  })
  it("a non-empty NO_COLOR turns auto off; an empty one does not count", () => {
    expect(shouldColor("auto", TTY, { NO_COLOR: "1" })).toBe(false)
    expect(shouldColor("auto", TTY, { NO_COLOR: "" })).toBe(true)
  })
  it("TERM=dumb turns auto off", () => {
    expect(shouldColor("auto", TTY, { TERM: "dumb" })).toBe(false)
  })
  it("an explicit mode beats every auto condition", () => {
    expect(shouldColor("always", PIPE, { NO_COLOR: "1", TERM: "dumb" })).toBe(true)
    expect(shouldColor("never", TTY, { TERM: "xterm" })).toBe(false)
  })
})

describe("configureColor", () => {
  afterEach(() => configureColor("never", {}, PIPE))

  it("drives dim and red by the stdout verdict", () => {
    configureColor("always", {}, PIPE)
    expect(dim("x")).toBe("\x1b[2mx\x1b[22m")
    expect(red("x")).toBe("\x1b[31mx\x1b[39m")
    configureColor("never", {}, TTY)
    expect(dim("x")).toBe("x")
    expect(red("x")).toBe("x")
  })

  it("no colour: tells picocolors through NO_COLOR and chalk through FORCE_COLOR", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm" }
    configureColor("never", env, TTY)
    expect(env.NO_COLOR).toBe("1")
    expect(env.FORCE_COLOR).toBe("0")
  })

  it("always: forces the libraries on, clearing a NO_COLOR the user exported", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1" }
    configureColor("always", env, PIPE)
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.FORCE_COLOR).toBe("1")
  })

  it("auto with colour on leaves the libraries to their own level detection", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm-256color" }
    configureColor("auto", env, TTY)
    expect(env).toEqual({ TERM: "xterm-256color" })
  })

  it("originalEnv undoes the settings, so the daemon inherits what the user had", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "keep", KEEP: "1" }
    configureColor("always", env, PIPE)
    expect(originalEnv(env)).toEqual({ NO_COLOR: "keep", KEEP: "1" })

    const clean: NodeJS.ProcessEnv = { KEEP: "1" }
    configureColor("never", clean, PIPE)
    expect(originalEnv(clean)).toEqual({ KEEP: "1" })
  })
})
