import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { scanUserHooks } from "../../src/hooks/loader.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `kclaw-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 一个合法的用户钩子文件（ESM，与 src 无依赖）。 */
function validJs(): string {
  return 'export const hook = { position: "run-before", description: "test hook" }\nexport default (ctx) => { void ctx.message }\n'
}

describe("scanUserHooks", () => {
  it("目录不存在 → 空结果（不是错误）", async () => {
    const result = await scanUserHooks(join(dir, "missing"))
    expect(result).toEqual({ entries: [], failures: [] })
  })

  it("合法文件载入：name 取文件名、order 默认 1000、failure 默认 skip、origin user", async () => {
    writeFileSync(join(dir, "my-hook.js"), validJs())
    const { entries, failures } = await scanUserHooks(dir)
    expect(failures).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.meta).toMatchObject({
      name: "my-hook.js",
      position: "run-before",
      description: "test hook",
      enabled: true,
      order: 1000,
      failure: "skip",
      origin: "user",
    })
    expect(typeof entries[0]!.handler).toBe("function")
  })

  it("声明的 order/enabled 生效", async () => {
    writeFileSync(join(dir, "custom.js"), [
      'export const hook = { position: "llm-before", order: 42, enabled: false }',
      "export default () => undefined",
    ].join("\n"))
    const { entries } = await scanUserHooks(dir)
    expect(entries[0]!.meta).toMatchObject({ position: "llm-before", order: 42, enabled: false })
  })

  it("未知 position 拒绝（不炸整个目录）", async () => {
    writeFileSync(join(dir, "bad-position.js"), [
      'export const hook = { position: "somewhere-else" }',
      "export default () => undefined",
    ].join("\n"))
    writeFileSync(join(dir, "good.js"), validJs())
    const { entries, failures } = await scanUserHooks(dir)
    expect(entries.map((e) => e.meta.name)).toEqual(["good.js"])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ name: "bad-position.js" })
    expect(failures[0]!.error).toContain("unknown position")
  })

  it("用户文件声明 failure fatal 拒绝", async () => {
    writeFileSync(join(dir, "fatal.js"), [
      'export const hook = { position: "run-before", failure: "fatal" }',
      "export default () => undefined",
    ].join("\n"))
    const { entries, failures } = await scanUserHooks(dir)
    expect(entries).toEqual([])
    expect(failures[0]!.error).toContain("fatal")
  })

  it("声明 failure deny 采纳（fail-closed 自选档）", async () => {
    writeFileSync(join(dir, "guard.js"), [
      'export const hook = { position: "tool-before", failure: "deny" }',
      "export default () => undefined",
    ].join("\n"))
    const { entries, failures } = await scanUserHooks(dir)
    expect(failures).toEqual([])
    expect(entries[0]!.meta).toMatchObject({ name: "guard.js", position: "tool-before", failure: "deny", origin: "user" })
  })

  it("非法 failure 值拒绝（类型校验在 js 文件上靠装载器兜底）", async () => {
    writeFileSync(join(dir, "weird.js"), [
      'export const hook = { position: "run-before", failure: "explode" }',
      "export default () => undefined",
    ].join("\n"))
    const { entries, failures } = await scanUserHooks(dir)
    expect(entries).toEqual([])
    expect(failures[0]!.error).toContain("unknown failure")
  })

  it("语法错误 → 装载失败条目", async () => {
    writeFileSync(join(dir, "broken.js"), "export const hook = { position: }}}")
    const { failures } = await scanUserHooks(dir)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.name).toBe("broken.js")
    expect(failures[0]!.error.length).toBeGreaterThan(0)
  })

  it("缺 hook 导出或 default 函数 → 装载失败", async () => {
    writeFileSync(join(dir, "no-meta.js"), "export default () => undefined\n")
    writeFileSync(join(dir, "no-default.js"), 'export const hook = { position: "run-before" }\n')
    const { failures } = await scanUserHooks(dir)
    expect(failures.map((f) => f.name).sort()).toEqual(["no-default.js", "no-meta.js"])
    expect(failures[0]!.error).toContain("export const hook")
  })

  it(".ts 文件在 Node 原生加载下可用（类型剥离；vitest 的 vite 管道不参与，故走子进程 + dist）", async () => {
    writeFileSync(join(dir, "typed.ts"), [
      'export const hook = { position: "tool-before" }',
      "type Ctx = { toolCall: { name: string } }",
      "export default (ctx: Ctx) => { void ctx.toolCall.name }",
    ].join("\n"))
    const loaderDist = pathToFileURL(resolve(__dirname, "../../dist/hooks/loader.js")).href
    const script = [
      `const { scanUserHooks } = await import(${JSON.stringify(loaderDist)})`,
      `const r = await scanUserHooks(${JSON.stringify(dir)})`,
      "console.log(JSON.stringify({ n: r.entries.length, pos: r.entries[0]?.meta.position ?? null, errs: r.failures.map(f => f.error) }))",
    ].join("\n")
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    expect(JSON.parse(out.trim())).toEqual({ n: 1, pos: "tool-before", errs: [] })
  })

  it("非钩子扩展名忽略", async () => {
    writeFileSync(join(dir, "readme.txt"), 'export const hook = { position: "run-before" }\n')
    const { entries, failures } = await scanUserHooks(dir)
    expect(entries).toEqual([])
    expect(failures).toEqual([])
  })
})
