import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "../../src/storage/paths.js"
import { loadConfig, saveConfig, defaultConfig, resolveContextTokens } from "../../src/storage/config.js"
import type { KclawConfig } from "../../src/storage/config.js"
import { writeFileAtomic } from "../../src/storage/atomic.js"

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kclaw-test-")) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe("resolvePaths", () => {
  it("creates directory tree and exposes the layout", () => {
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
  it("falls invalid waterlines back to defaults with a warning (value out of range)", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeFileSync(paths.config, ["sessions:", "  compactAtRatio: 1.5"].join("\n"))
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("compact{Target,At,Ahead,Panic}Ratio")
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
    expect(cfg.sessions.compactPanicRatio).toBeUndefined()
  })
  it("falls inverted waterline order back to defaults (ahead ≥ panic empties the pre-compaction window)", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeFileSync(paths.config, ["sessions:", "  compactAheadRatio: 0.95"].join("\n"))
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(cfg.sessions.compactAheadRatio).toBeUndefined()
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
  })
  it("validates compactPackRatio independently of the trigger group", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeFileSync(paths.config, ["sessions:", "  compactPackRatio: -1", "  compactAtRatio: 0.85"].join("\n"))
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("compactPackRatio")
    expect(cfg.sessions.compactPackRatio).toBeUndefined()
    expect(cfg.sessions.compactAtRatio).toBe(0.85)
  })
  it("keeps a valid custom waterline configuration untouched", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeFileSync(paths.config, [
      "sessions:",
      "  compactTargetRatio: 0.2",
      "  compactAheadRatio: 0.5",
      "  compactAtRatio: 0.7",
      "  compactPanicRatio: 0.95",
      "  compactPackRatio: 0.4",
    ].join("\n"))
    const cfg = loadConfig(paths)
    expect(warn).not.toHaveBeenCalled()
    expect(cfg.sessions.compactAtRatio).toBe(0.7)
    expect(cfg.sessions.compactPackRatio).toBe(0.4)
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
  it("permissions.defaultMode defaults to default, merges from yaml, and rejects bad values with a warning", () => {
    expect(defaultConfig.permissions.defaultMode).toBe("default")
    const home = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
    writeFileSync(join(home, "config.yaml"), "permissions:\n  defaultMode: readonly\n")
    expect(loadConfig(resolvePaths(home)).permissions.defaultMode).toBe("readonly")
    // 非法值（要进事件流的字段必须严格校验）回落 default 并警告
    writeFileSync(join(home, "config.yaml"), "permissions:\n  defaultMode: bogus\n")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.permissions.defaultMode).toBe("default")
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
  it("permissions 整节非对象（YAML 空节）按默认节整体回落并警告，不裸抛", () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
    writeFileSync(join(home, "config.yaml"), "permissions:\n") // 解析为 null
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.permissions).toEqual(defaultConfig.permissions)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
  it("defaultMode 非法时只重置该字段，不丢用户已有的 allow/deny", () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-cfg-"))
    writeFileSync(join(home, "config.yaml"), [
      "permissions:",
      "  defaultMode: bogus",
      "  deny:",
      "    - exec:rm -rf*",
    ].join("\n"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.permissions.defaultMode).toBe("default")
      expect(cfg.permissions.deny).toEqual(["exec:rm -rf*"])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("memory config", () => {
  it("exposes the expected defaults", () => {
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

describe("resolveContextTokens", () => {
  const base = (over: Partial<KclawConfig["providers"]> = {}) => {
    const cfg = structuredClone(defaultConfig)
    Object.assign(cfg.providers, over)
    return cfg
  }

  it("falls back to 128k when nothing is declared", () => {
    expect(resolveContextTokens(base())).toBe(128_000)
  })

  it("uses the session cap when the model has no window", () => {
    const cfg = base()
    cfg.sessions.contextTokens = 50_000
    expect(resolveContextTokens(cfg)).toBe(50_000)
  })

  it("uses the model window when no session cap exists", () => {
    const cfg = base({
      default: "m",
      entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 200_000 } },
    })
    expect(resolveContextTokens(cfg, "m")).toBe(200_000)
  })

  it("takes the min when both exist", () => {
    const cfg = base({
      default: "m",
      entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 32_000 } },
    })
    cfg.sessions.contextTokens = 128_000
    expect(resolveContextTokens(cfg, "m")).toBe(32_000)
    cfg.sessions.contextTokens = 16_000
    expect(resolveContextTokens(cfg, "m")).toBe(16_000)
  })

  it("unknown entry key falls back to the default entry's window", () => {
    const cfg = base({
      default: "m",
      entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 90_000 } },
    })
    // raw wire model name "m1" matches no entry key → default entry "m"
    expect(resolveContextTokens(cfg, "m1")).toBe(90_000)
  })

  it("ignores nonsensical window values", () => {
    const cfg = base({
      default: "m",
      entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 0 } },
    })
    cfg.sessions.contextTokens = 50_000
    expect(resolveContextTokens(cfg, "m")).toBe(50_000)
    expect(resolveContextTokens(cfg)).toBe(50_000)
  })
})
