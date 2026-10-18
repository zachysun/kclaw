import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CronScheduler } from "../../src/cron/scheduler.js"
import { createCronTools } from "../../src/tools/cron.js"
import { createBuiltinTools } from "../../src/tools/index.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { MemorySystem } from "../../src/memory/system.js"
import { vi } from "vitest"

let dir: string
let sched: CronScheduler
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kclaw-crontools-"))
  sched = new CronScheduler(join(dir, "cron.db"))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args ?? {}, { onOutput: () => {} })

describe("CronScheduler delay entries", () => {
  it("creates a delay entry that fires once then auto-disables", () => {
    const c = sched.create({ name: "remind", prompt: "p", delayMinutes: 30 })
    expect(c.kind).toBe("delay")
    expect(c.delayMinutes).toBe(30)
    expect(c.cron).toBe("")
    expect(c.enabled).toBe(true)
    // 30 分钟后到期，现在不认领
    expect(sched.claimDue(new Date())).toHaveLength(0)
    // 到点认领：返回条目、自动停用、不重排
    const due = new Date(Date.now() + 31 * 60_000)
    const claimed = sched.claimDue(due)
    expect(claimed).toHaveLength(1)
    const after = sched.get(c.id)!
    expect(after.enabled).toBe(false)
    // 再到点也不会重复触发（停用行不进 due）
    expect(sched.due(new Date(Date.now() + 3600_000))).toHaveLength(0)
  })

  it("delay 与 cron 互斥、缺一报错", () => {
    expect(() => sched.create({ name: "x", prompt: "p", cron: "* * * * *", delayMinutes: 5 })).toThrow("二选一")
    expect(() => sched.create({ name: "x", prompt: "p" })).toThrow("其一")
  })

  it("update 转换形态：delay → cron、cron → delay", () => {
    const a = sched.create({ name: "a", prompt: "p", cron: "*/5 * * * *" })
    const switched = sched.update(a.id, { delayMinutes: 10 })!
    expect(switched.kind).toBe("delay")
    expect(switched.cron).toBe("")
    const back = sched.update(a.id, { cron: "0 9 * * *" })!
    expect(back.kind).toBe("cron")
    expect(back.delayMinutes).toBeUndefined()
    expect(sched.get(a.id)!.kind).toBe("cron")
  })
})

describe("cron tools", () => {
  it("create with delayMinutes lists the relative form and fires once", async () => {
    const t = createCronTools({ scheduler: sched })
    const r = await call(t.cron_create, { name: "提醒", prompt: "检查构建", delayMinutes: 1 })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("一次性：1 分钟后")
    const listed = await call(t.cron_list, {})
    expect(listed.output).toContain("提醒")
  })

  it("create validates the cron|delayMinutes mutex and required fields", async () => {
    const t = createCronTools({ scheduler: sched })
    const both = await call(t.cron_create, { name: "x", prompt: "p", cron: "* * * * *", delayMinutes: 5 })
    expect(both.status).toBe("error")
    expect(both.output).toContain("二选一")
    const none = await call(t.cron_create, { name: "x", prompt: "p" })
    expect(none.status).toBe("error")
    const noName = await call(t.cron_create, { prompt: "p", cron: "* * * * *" })
    expect(noName.status).toBe("error")
  })

  it("create passes cron-parser's own error through for invalid expressions", async () => {
    const t = createCronTools({ scheduler: sched })
    const r = await call(t.cron_create, { name: "x", prompt: "p", cron: "not-a-cron" })
    expect(r.status).toBe("error")
    expect(r.output).toContain("cron_create:")
  })

  it("update / delete flow with not-found errors", async () => {
    const t = createCronTools({ scheduler: sched })
    const created = await call(t.cron_create, { name: "x", prompt: "p", cron: "*/5 * * * *" })
    const id = (created.data as { id: string }).id
    const patched = await call(t.cron_update, { id, enabled: false })
    expect(patched.status).toBe("ok")
    expect(sched.get(id)!.enabled).toBe(false)
    const noField = await call(t.cron_update, { id })
    expect(noField.status).toBe("error")
    const missing = await call(t.cron_update, { id: "cron_nope", name: "y" })
    expect(missing.status).toBe("error")
    expect(missing.output).toContain("cron not found")
    const del = await call(t.cron_delete, { id })
    expect(del.status).toBe("ok")
    const delAgain = await call(t.cron_delete, { id })
    expect(delAgain.status).toBe("error")
  })

  it("risk classification: writes sensitive+serial, list safe+parallel", () => {
    const t = createCronTools({ scheduler: sched })
    expect(t.cron_create.risk).toBe("sensitive")
    expect(t.cron_create.concurrency).toBe("serial")
    expect(t.cron_update.risk).toBe("sensitive")
    expect(t.cron_delete.risk).toBe("sensitive")
    expect(t.cron_list.risk).toBe("safe")
    expect(t.cron_list.concurrency).toBe("parallel")
  })
})

describe("cron model-face surface", () => {
  const mk = (cron?: Parameters<typeof createBuiltinTools>[0]["cron"]) =>
    createBuiltinTools({
      workspace: dir,
      sessionId: "ses_1",
      memoryCtx: {
        system: {
          triggerImmediate: vi.fn(async () => undefined),
          searchAll: vi.fn(async () => []),
        } as unknown as MemorySystem,
        sessionId: "ses_1",
        workdir: dir,
        immediateEnabled: false,
      },
      tavilyApiKey: "tvly-test",
      ...(cron === undefined ? {} : { cron }),
    })

  it("a scheduler wires all four; cron-fired runs get the read-only view", () => {
    const full = mk({ scheduler: sched })
    expect(full.tools.has("cron_create")).toBe(true)
    expect(full.tools.has("cron_update")).toBe(true)
    expect(full.tools.has("cron_delete")).toBe(true)
    expect(full.tools.has("cron_list")).toBe(true)
    const fired = mk({ scheduler: sched, writeTools: false })
    expect(fired.tools.has("cron_list")).toBe(true)
    expect(fired.tools.has("cron_create")).toBe(false)
    expect(fired.tools.has("cron_update")).toBe(false)
    expect(fired.tools.has("cron_delete")).toBe(false)
  })

  it("readonly mode drops the sensitive writes and keeps cron_list", () => {
    const { tools, toolDefs } = mk({ scheduler: sched })
    // simulate the assembly's readonly narrowing
    for (const [name, tool] of [...tools]) {
      if (tool.risk !== "sensitive") continue
      tools.delete(name)
      const idx = toolDefs.findIndex((d) => d.name === name)
      if (idx !== -1) toolDefs.splice(idx, 1)
    }
    expect(tools.has("cron_list")).toBe(true)
    expect(tools.has("cron_create")).toBe(false)
  })
})
