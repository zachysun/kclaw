/**
 * Project group identity (identity.ts + the McpGroupStore key space): one
 * directory is one group regardless of spelling. resolveProjectIdentity is
 * the single canonicalization rule; the store applies it to every group key
 * in and out (mount/lookup), so discovery spellings, session-meta spellings
 * and snapshot ids all converge.
 */
import { describe, expect, it } from "vitest"
import { resolveProjectIdentity } from "../../src/mcp/identity.js"
import { McpGroupStore } from "../../src/mcp/groups.js"
import { GLOBAL_GROUP } from "../../src/mcp/types.js"
import type { McpServerConfig } from "../../src/mcp/types.js"

const stdio = (command: string): McpServerConfig => ({ type: "stdio", command })

describe("resolveProjectIdentity", () => {
  it("canonicalizes trailing slashes, dot segments and relative spellings", () => {
    const abs = resolveProjectIdentity("/tmp/proj-a")
    expect(resolveProjectIdentity("/tmp/proj-a/")).toBe(abs)
    expect(resolveProjectIdentity("/tmp/proj-a/./")).toBe(abs)
    expect(resolveProjectIdentity("/tmp/x/../proj-a")).toBe(abs)
    // Relative input resolves against cwd — still absolute, still stable.
    expect(resolveProjectIdentity("rel-proj")).toBe(resolveProjectIdentity(process.cwd() + "/rel-proj"))
    expect(resolveProjectIdentity("rel-proj").startsWith("/")).toBe(true)
  })

  it("is idempotent on an already-canonical path", () => {
    const once = resolveProjectIdentity("/tmp/proj-a")
    expect(resolveProjectIdentity(once)).toBe(once)
  })
})

describe("McpGroupStore identity keys", () => {
  it("mounts different spellings of one directory as a single group", () => {
    const store = new McpGroupStore({
      global: {},
      projects: { "/tmp/proj-a": { a: stdio("a") } },
    })
    store.addProject("/tmp/proj-a/", { b: stdio("b") })
    store.addProject("/tmp/x/../proj-a", { c: stdio("c") })
    expect(store.groups()).toEqual([GLOBAL_GROUP, "/tmp/proj-a"])
    // Idempotent mount keeps the FIRST spelling's entries (canonical id).
    expect(Object.keys(store.entries("/tmp/proj-a/"))).toEqual(["a"])
  })

  it("answers has/entries/drop through any spelling", () => {
    const store = new McpGroupStore({ global: {}, projects: { "/tmp/proj-a": { a: stdio("a") } } })
    expect(store.has("/tmp/proj-a/")).toBe(true)
    expect(store.entries("/tmp/proj-a/./")).toEqual({ a: stdio("a") })
    store.dropProject("/tmp/proj-a/")
    expect(store.has("/tmp/proj-a")).toBe(false)
  })

  it("resolves the use-view for a workdir spelled differently than the group id", () => {
    const store = new McpGroupStore({
      global: { shared: stdio("g") },
      projects: { "/tmp/proj-a": { local: stdio("l") } },
    })
    const view = store.viewFor("/tmp/proj-a/")
    // Project entry present and labeled with the canonical group id.
    expect(view.map((e) => [e.name, e.group])).toEqual([
      ["shared", GLOBAL_GROUP],
      ["local", "/tmp/proj-a"],
    ])
  })

  it("leaves global alone (the reserved id never path-resolves)", () => {
    const store = new McpGroupStore({ global: { g: stdio("x") }, projects: {} })
    expect(store.has(GLOBAL_GROUP)).toBe(true)
    expect(store.entries(GLOBAL_GROUP)).toEqual({ g: stdio("x") })
    store.dropProject(GLOBAL_GROUP)
    expect(store.has(GLOBAL_GROUP)).toBe(true)
  })
})
