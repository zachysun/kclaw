import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GLOBAL_GROUP, McpManager, loadMcpJson, loadProjectMcpServers, mcpConfigPath, saveMcpJson } from "@kclaw/core"
import { createMcpProjects, collectProjectDirs } from "../src/mcp-projects.js"

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

/**
 * The alias bug: when a project workdir's `.kclaw/mcp.json` IS the global
 * file (daemon workspace = the home directory), the project watch saw every
 * global persist write and reconciled the project group from it — disabling
 * a global entry flipped the same-named project entry too. The project
 * layer for such a directory must not exist at all.
 *
 * fs.watch EVENT behavior stays out of scope (the standing boundary): the
 * bleed path is driven through sync(), the same read → reconcileProject
 * call the watcher's debounced callback makes.
 */
describe("mcp-projects × global file alias", () => {
  it("never mounts a project whose config file is the global mcp.json, so a global disable cannot leak into it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-mcp-alias-"))
    // The daemon-home shape: <workspace>/.kclaw is home, so the workspace's
    // project file and the global file are the same path.
    const home = join(ws, ".kclaw")
    mkdirSync(home, { recursive: true })
    const globalFile = mcpConfigPath(home)
    writeFileSync(globalFile, JSON.stringify({ servers: { ctx7: { type: "http", url: "https://x.test/mcp" } } }))
    const projA = join(ws, "proj-a")
    mkdirSync(join(projA, ".kclaw"), { recursive: true })
    writeFileSync(join(projA, ".kclaw", "mcp.json"), JSON.stringify({ servers: { local: { type: "stdio", command: "a" } } }))

    try {
      // The daemon assembles the manager from collectProjectDirs — the same
      // decision the discovery drives — so the aliased directory never
      // becomes a project group in the first place.
      const dirs = collectProjectDirs({ workspace: ws, allMetas: () => [{ workdir: ws }, { workdir: projA }], home })
      expect(dirs).toEqual([projA])
      const initialProjects: Record<string, ReturnType<typeof loadProjectMcpServers>> = {}
      for (const dir of dirs) initialProjects[dir] = loadProjectMcpServers(dir)
      const manager = new McpManager({
        globalServers: loadMcpJson(globalFile),
        projects: initialProjects,
        persist: (group, servers) => {
          if (group === GLOBAL_GROUP) saveMcpJson(globalFile, servers)
          else saveProjectMcpJson(group, servers)
        },
      })
      const controller = createMcpProjects({
        workspace: ws,
        manager,
        allMetas: () => [{ workdir: ws }, { workdir: projA }],
        loadEntries: (dir) => loadProjectMcpServers(dir),
        home,
        syncIntervalMs: 0,
      })
      controller.sync()

      manager.setEnabled(GLOBAL_GROUP, "ctx7", false)
      // The watcher's debounced reconcile is a sync() under the hood; drive
      // it by hand so no fs.watch event is needed.
      controller.sync()

      const ids = manager.status().groups.map((g) => g.id)
      expect(ids).not.toContain(ws)
      const globalCtx7 = manager.status().groups.find((g) => g.id === GLOBAL_GROUP)!.servers.find((s) => s.name === "ctx7")!
      expect(globalCtx7.state).toBe("disabled")
      const local = manager.status().groups.find((g) => g.id === projA)!.servers.find((s) => s.name === "local")!
      expect(local.config.enabled).not.toBe(false)
      controller.close()
      await manager.stop()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
