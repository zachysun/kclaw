import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { HookRegistry } from "../../src/hooks/registry.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `kclaw-hookreg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function goodFile(name: string, position = "run-before"): void {
  writeFileSync(join(dir, name), `export const hook = { position: "${position}" }\nexport default () => undefined\n`)
}

describe("HookRegistry", () => {
  it("refresh 载入健康文件：snapshot 出条目、list 出管理视图", async () => {
    goodFile("a.js", "tool-after")
    const registry = new HookRegistry({ userDir: dir })
    await registry.refresh()
    expect(registry.snapshot()).toHaveLength(1)
    expect(registry.snapshot()[0]!.meta).toMatchObject({ name: "a.js", position: "tool-after", origin: "user" })
    expect(registry.list()).toEqual([
      expect.objectContaining({ name: "a.js", position: "tool-after", enabled: true, origin: "user" }),
    ])
  })

  it("装载失败：list 带错误条目、事件按文件版本去重", async () => {
    writeFileSync(join(dir, "broken.js"), "export const hook = }}}")
    const onEvent = vi.fn()
    const registry = new HookRegistry({ userDir: dir, onEvent })
    await registry.refresh()
    await registry.refresh() // 同一版本：不再重复发事件
    expect(onEvent).toHaveBeenCalledTimes(1)
    const event = onEvent.mock.calls[0]![0] as { type: string; payload: Record<string, string> }
    expect(event.type).toBe("hook.failed")
    expect(event.payload).toMatchObject({ hook: "broken.js", position: "load", phase: "load" })
    expect(registry.snapshot()).toEqual([])
    expect(registry.list()).toEqual([
      expect.objectContaining({ name: "broken.js", position: "?", enabled: false, error: expect.any(String) }),
    ])
  })

  it("文件修改后（新 mtime + 新错误）再次发事件", async () => {
    const path = join(dir, "evolving.js")
    writeFileSync(path, 'export const hook = { position: "nope-1" }\nexport default () => undefined\n')
    const onEvent = vi.fn()
    const registry = new HookRegistry({ userDir: dir, onEvent })
    await registry.refresh()
    expect(onEvent).toHaveBeenCalledTimes(1)
    // mtime 前移（同秒内写入 mtimeMs 可能相同，显式拨快保证版本键变化）
    writeFileSync(path, 'export const hook = { position: "nope-2" }\nexport default () => undefined\n')
    const future = Date.now() / 1000 + 10
    utimesSync(path, future, future)
    await registry.refresh()
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it("坏文件修好后恢复为健康条目", async () => {
    const path = join(dir, "heal.js")
    writeFileSync(path, "export const hook = }}}")
    const registry = new HookRegistry({ userDir: dir })
    await registry.refresh()
    expect(registry.snapshot()).toEqual([])
    writeFileSync(path, 'export const hook = { position: "run-before" }\nexport default () => undefined\n')
    await registry.refresh()
    expect(registry.snapshot()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ name: "heal.js", enabled: true })
  })

  it("未设 userDir：refresh/snapshot/list 都是空", async () => {
    const registry = new HookRegistry()
    await registry.refresh()
    expect(registry.snapshot()).toEqual([])
    expect(registry.list()).toEqual([])
  })
})
