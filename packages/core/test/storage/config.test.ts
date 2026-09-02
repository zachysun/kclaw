import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "../../src/storage/paths.js"
import { loadConfig, saveConfig, defaultConfig } from "../../src/storage/config.js"
import { writeFileAtomic } from "../../src/storage/atomic.js"

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kclaw-test-")) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe("resolvePaths", () => {
  it("creates directory tree and exposes spec layout", () => {
    const p = resolvePaths(home)
    expect(p.config).toBe(join(home, "config.yaml"))
    expect(p.memoryNotesDir).toBe(join(home, "memory", "notes"))
    expect(p.sessionsDir).toBe(join(home, "sessions"))
    expect(p.jobsDb).toBe(join(home, "jobs.db"))
    for (const d of [p.memoryNotesDir, p.sessionsDir, p.logsDir]) {
      expect(() => readFileSync(d)).toThrow() // 是目录不是文件
    }
  })
  it("treats an empty/blank KCLAW_HOME env as unset (falls back to ~/.kclaw)", () => {
    const prev = process.env.KCLAW_HOME
    try {
      for (const blank of ["", "   "]) {
        process.env.KCLAW_HOME = blank
        // 空串若被采纳，所有路径会以 "" 为根落到 cwd 相对路径上
        expect(resolvePaths().home).toBe(join(homedir(), ".kclaw"))
      }
    } finally {
      if (prev === undefined) delete process.env.KCLAW_HOME
      else process.env.KCLAW_HOME = prev
    }
  })
})

describe("loadConfig / saveConfig", () => {
  it("returns defaults when file missing", () => {
    expect(loadConfig(resolvePaths(home))).toEqual(defaultConfig)
  })
  it("deep-merges file over defaults", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, [
      "permissions:",
      "  allow:",
      "    - 'exec:git status'",
      "exec:",
      "  timeoutMs: 5000",
    ].join("\n"))
    const cfg = loadConfig(paths)
    expect(cfg.permissions.allow).toEqual(["exec:git status"])
    expect(cfg.permissions.deny).toEqual(defaultConfig.permissions.deny) // 未覆盖保留默认
    expect(cfg.exec.timeoutMs).toBe(5000)
    expect(cfg.exec.maxOutputBytes).toBe(defaultConfig.exec.maxOutputBytes)
  })
  it("roundtrips through saveConfig", () => {
    const paths = resolvePaths(home)
    const cfg = structuredClone(defaultConfig)
    cfg.exec.timeoutMs = 1234
    saveConfig(paths, cfg)
    expect(loadConfig(paths).exec.timeoutMs).toBe(1234)
  })
  it("defaults providers.timeoutMs to 120s and deep-merges overrides", () => {
    const paths = resolvePaths(home)
    expect(defaultConfig.providers.timeoutMs).toBe(120_000)
    expect(loadConfig(paths).providers.timeoutMs).toBe(120_000) // absent in file → default
    writeFileSync(paths.config, ["providers:", "  timeoutMs: 5000"].join("\n"))
    expect(loadConfig(paths).providers.timeoutMs).toBe(5000) // 覆盖保留其余默认
    expect(loadConfig(paths).providers.default).toBe("")
  })
  it("keeps v2 compaction fields optional; legacy fields still parse without error", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.config, [
      "sessions:",
      "  compactThreshold: 99",
      "  compactKeep: 9",
      "  contextTokens: 200000",
    ].join("\n"))
    const cfg = loadConfig(paths)
    expect(cfg.sessions.contextTokens).toBe(200_000)
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
    expect(cfg.sessions.compactThreshold).toBe(99) // tolerated, inert
  })
  it("does not share nested references with defaultConfig", () => {
    const pristine = structuredClone(defaultConfig)
    const paths = resolvePaths(home)
    writeFileSync(paths.config, ["exec:", "  timeoutMs: 5000"].join("\n"))
    const cfg = loadConfig(paths)
    cfg.permissions.allow.push("x")
    expect(cfg.permissions).not.toBe(defaultConfig.permissions) // 覆盖段外不共享嵌套引用
    expect(defaultConfig).toEqual(pristine) // 原地修改不污染 defaultConfig
    rmSync(paths.config)
    const fresh = loadConfig(paths)
    expect(fresh.permissions.allow).toEqual([])
    expect(fresh.permissions.allow).not.toContain("x")
    expect(fresh).toEqual(pristine)
  })
  it("sessions.defaultDisposition defaults to steer and merges from yaml", () => {
    expect(defaultConfig.sessions.defaultDisposition).toBe("steer")
    const home = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
    writeFileSync(join(home, "config.yaml"), "sessions:\n  defaultDisposition: wait\n")
    expect(loadConfig(resolvePaths(home)).sessions.defaultDisposition).toBe("wait")
  })
})

describe("memory v2 config", () => {
  it("defaults match the spec", () => {
    const m = defaultConfig.memory
    expect(m).toEqual({
      write: { immediate: true, manual: true, intervalMinutes: 30, idleMinutes: 10 },
      extractModel: "",
      threadInactiveDays: 14,
      consolidate: true,
      consolidateHour: 3,
      embedding: { provider: "", model: "" },
      injectTokenBudget: 1000,
    })
  })

  it("deep-merges user values over defaults and ignores legacy autoExtract", () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
    writeFileSync(join(home, "config.yaml"), [
      "memory:",
      "  autoExtract: true",
      "  write:",
      "    intervalMinutes: 15",
      "  embedding:",
      "    model: text-embedding-3-small",
      "",
    ].join("\n"))
    const cfg = loadConfig(resolvePaths(home))
    expect(cfg.memory.write.intervalMinutes).toBe(15)
    expect(cfg.memory.write.immediate).toBe(true) // untouched default
    expect(cfg.memory.embedding.model).toBe("text-embedding-3-small")
    expect((cfg.memory as Record<string, unknown>).autoExtract).toBe(true) // 读处兜底忽略，字段不进类型
  })

  it("logs a warning when legacy memory.autoExtract is present, silent when absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const withLegacy = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
      writeFileSync(join(withLegacy, "config.yaml"), "memory:\n  autoExtract: true\n")
      loadConfig(resolvePaths(withLegacy))
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls.some((c) => String(c[0]).includes("autoExtract"))).toBe(true)

      warn.mockClear()
      const clean = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
      writeFileSync(join(clean, "config.yaml"), "memory:\n  write:\n    intervalMinutes: 7\n")
      loadConfig(resolvePaths(clean))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("writeFileAtomic", () => {
  it("replaces the target atomically and leaves no tmp behind", () => {
    const file = join(home, "atomic.json")
    writeFileSync(file, "old", "utf8")
    writeFileAtomic(file, "new-content")
    expect(readFileSync(file, "utf8")).toBe("new-content")
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
  it("saveConfig writes config.yaml with mode 0600", () => {
    const paths = resolvePaths(home)
    saveConfig(paths, loadConfig(paths))
    expect(statSync(paths.config).mode & 0o777).toBe(0o600)
  })
})
