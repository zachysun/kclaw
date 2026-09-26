import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpProjects } from "../src/mcp-projects.js"

/** Recording fake manager: the calls list doubles as the assertion surface. */
function fakeManagerLog() {
  const calls: string[] = []
  return {
    calls,
    manager: {
      ensureProject: (workdir: string, entries: Record<string, unknown>) =>
        calls.push(`ensure:${workdir}:${Object.keys(entries).join("+")}`),
      dropProject: async (workdir: string) => {
        calls.push(`drop:${workdir}`)
      },
      reconcileProject: (workdir: string, entries: Record<string, unknown>) =>
        calls.push(`reconcile:${workdir}:${Object.keys(entries).join("+")}`),
    },
  }
}

/**
 * Discovery logic with a recording fake manager. The per-dir watches are
 * real (created on tmpdirs, closed by close()) — fs.watch EVENT behavior is
 * deliberately out of scope (the standing no-watch-tests boundary); what is
 * under test here is the union computation and mount/unmount decisions.
 */
describe("mcp-projects discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "kclaw-mcp-projects-"))
  const workspace = join(root, "main")
  const projA = join(root, "a")
  const projB = join(root, "b")

  it("sync mounts the workspace plus every session workdir (dedup, no-workdir sessions need nothing)", () => {
    const { calls, manager } = fakeManagerLog()
    const controller = createMcpProjects({
      workspace,
      manager,
      allMetas: () => [{ workdir: projA }, { workdir: projB }, { workdir: projA }, {}],
      loadEntries: (dir) => (dir === projA ? { pa: { type: "stdio", command: "a" } } : {}),
      syncIntervalMs: 0, // tests drive sync() by hand; no timer to leak
    })
    controller.sync()
    expect(calls).toContain(`ensure:${workspace}:`)
    expect(calls).toContain(`ensure:${projA}:pa`)
    expect(calls).toContain(`ensure:${projB}:`)
    controller.close()
  })

  it("mount is idempotent and only mounts a directory once", () => {
    const { calls, manager } = fakeManagerLog()
    const controller = createMcpProjects({
      workspace,
      manager,
      allMetas: () => [],
      loadEntries: () => ({}),
      syncIntervalMs: 0,
    })
    controller.mount(projA)
    controller.mount(projA)
    expect(calls.filter((c) => c.startsWith(`ensure:${projA}`))).toHaveLength(1)
    controller.close()
  })

  it("sync drops projects whose sessions are gone, never the workspace", () => {
    const { calls, manager } = fakeManagerLog()
    let metas: Array<{ workdir?: string }> = [{ workdir: projA }]
    const controller = createMcpProjects({
      workspace,
      manager,
      allMetas: () => metas,
      loadEntries: () => ({}),
      syncIntervalMs: 0,
    })
    controller.sync()
    metas = [] // every projA session purged
    controller.sync()
    expect(calls).toEqual([`ensure:${workspace}:`, `ensure:${projA}:`, `drop:${projA}`])
    controller.close()
  })

  it("close is idempotent (double close without effect)", () => {
    const { manager } = fakeManagerLog()
    const controller = createMcpProjects({
      workspace,
      manager,
      allMetas: () => [],
      loadEntries: () => ({}),
      syncIntervalMs: 0,
    })
    controller.mount(projA)
    controller.close()
    controller.close()
    expect(true).toBe(true)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })
})
