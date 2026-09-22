import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "../../src/storage/paths.js"
import { loadConfig, saveConfig, defaultConfig, resolveContextTokens, resolveRunModel, resolveProviderFormat, renameProviderEntry, PROVIDER_ENTRY_REFERENCES } from "../../src/storage/config.js"
import type { KclawConfig } from "../../src/storage/config.js"
import { writeFileAtomic } from "../../src/storage/atomic.js"

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kclaw-test-")) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** Write a config.json with the given section values (partial deep object). */
function writeConfig(values: Record<string, unknown>, dir = home): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(values))
}

describe("resolvePaths", () => {
  it("creates directory tree and exposes the layout", () => {
    const p = resolvePaths(home)
    expect(p.configJson).toBe(join(home, "config.json"))
    expect(p.sessionsDir).toBe(join(home, "sessions"))
    expect(p.jobsDb).toBe(join(home, "jobs.db"))
    for (const d of [p.sessionsDir, p.logsDir]) {
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
    writeConfig({ permissions: { allow: ["exec:git status"] }, exec: { timeoutMs: 5000 } })
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
    writeConfig({ providers: { timeoutMs: 5000 } })
    expect(loadConfig(paths).providers.timeoutMs).toBe(5000) // 覆盖保留其余默认
    expect(loadConfig(paths).providers.default).toBe("")
  })
  it("keeps compaction fields optional (contextTokens alone is valid)", () => {
    const paths = resolvePaths(home)
    writeConfig({ sessions: { contextTokens: 200000 } })
    const cfg = loadConfig(paths)
    expect(cfg.sessions.contextTokens).toBe(200_000)
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
  })
  it("falls invalid waterlines back to defaults with a warning (value out of range)", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeConfig({ sessions: { compactAtRatio: 1.5 } })
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("compact{Target,At,Ahead,Panic}Ratio")
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
    expect(cfg.sessions.compactPanicRatio).toBeUndefined()
  })
  it("falls inverted waterline order back to defaults (ahead ≥ panic empties the pre-compaction window)", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeConfig({ sessions: { compactAheadRatio: 0.95 } })
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(cfg.sessions.compactAheadRatio).toBeUndefined()
    expect(cfg.sessions.compactAtRatio).toBeUndefined()
  })
  it("validates compactPackRatio independently of the trigger group", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeConfig({ sessions: { compactPackRatio: -1, compactAtRatio: 0.85 } })
    const cfg = loadConfig(paths)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("compactPackRatio")
    expect(cfg.sessions.compactPackRatio).toBeUndefined()
    expect(cfg.sessions.compactAtRatio).toBe(0.85)
  })
  it("keeps a valid custom waterline configuration untouched", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeConfig({
      sessions: {
        compactTargetRatio: 0.2,
        compactAheadRatio: 0.5,
        compactAtRatio: 0.7,
        compactPanicRatio: 0.95,
        compactPackRatio: 0.4,
      },
    })
    const cfg = loadConfig(paths)
    expect(warn).not.toHaveBeenCalled()
    expect(cfg.sessions.compactAtRatio).toBe(0.7)
    expect(cfg.sessions.compactPackRatio).toBe(0.4)
  })
  it("does not share nested references with defaultConfig", () => {
    const pristine = structuredClone(defaultConfig)
    const paths = resolvePaths(home)
    writeConfig({ exec: { timeoutMs: 5000 } })
    const cfg = loadConfig(paths)
    cfg.permissions.allow.push("x")
    expect(cfg.permissions).not.toBe(defaultConfig.permissions) // 覆盖段外不共享嵌套引用
    expect(defaultConfig).toEqual(pristine) // 原地修改不污染 defaultConfig
    rmSync(paths.configJson)
    const fresh = loadConfig(paths)
    expect(fresh.permissions.allow).toEqual([])
    expect(fresh.permissions.allow).not.toContain("x")
    expect(fresh).toEqual(pristine)
  })
  it("sessions.defaultDisposition defaults to steer and merges from the file", () => {
    expect(defaultConfig.sessions.defaultDisposition).toBe("steer")
    writeConfig({ sessions: { defaultDisposition: "wait" } })
    expect(loadConfig(resolvePaths(home)).sessions.defaultDisposition).toBe("wait")
  })
  it("permissions.defaultMode defaults to default, merges from the file, and rejects bad values with a warning", () => {
    expect(defaultConfig.permissions.defaultMode).toBe("default")
    writeConfig({ permissions: { defaultMode: "readonly" } })
    expect(loadConfig(resolvePaths(home)).permissions.defaultMode).toBe("readonly")
    // 非法值（要进事件流的字段必须严格校验）回落 default 并警告
    writeConfig({ permissions: { defaultMode: "bogus" } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.permissions.defaultMode).toBe("default")
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
  it("permissions 整节非对象（null 节）按默认节整体回落并警告，不裸抛", () => {
    writeConfig({ permissions: null })
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
    writeConfig({ permissions: { defaultMode: "bogus", deny: ["exec:rm -rf*"] } })
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

  it("deep-merges user values over defaults", () => {
    writeConfig({
      memory: {
        write: { intervalMinutes: 15 },
        embedding: { model: "text-embedding-3-small" },
      },
    })
    const cfg = loadConfig(resolvePaths(home))
    expect(cfg.memory.write.intervalMinutes).toBe(15)
    expect(cfg.memory.write.immediate).toBe(true) // untouched default
    expect(cfg.memory.embedding.model).toBe("text-embedding-3-small")
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
  it("saveConfig writes config.json with mode 0600", () => {
    const paths = resolvePaths(home)
    saveConfig(paths, loadConfig(paths))
    expect(statSync(paths.configJson).mode & 0o777).toBe(0o600)
  })
})

describe("config.json storage", () => {
  it("exposes configJson in the path layout", () => {
    expect(resolvePaths(home).configJson).toBe(join(home, "config.json"))
  })

  it("roundtrips as JSON", () => {
    const paths = resolvePaths(home)
    saveConfig(paths, { ...structuredClone(defaultConfig), exec: { timeoutMs: 4321, maxOutputBytes: 1 } })
    const cfg = loadConfig(paths)
    expect(cfg.exec.timeoutMs).toBe(4321)
    expect(JSON.parse(readFileSync(paths.configJson, "utf8")).exec.timeoutMs).toBe(4321)
  })

  it("throws on unparseable config.json; an empty one yields defaults", () => {
    const paths = resolvePaths(home)
    writeFileSync(paths.configJson, "{ not json")
    expect(() => loadConfig(paths)).toThrow(/invalid json/)
    writeFileSync(paths.configJson, "   \n")
    expect(loadConfig(paths)).toEqual(defaultConfig)
  })

  it("treats a format-less entry as openai (resolveProviderFormat)", () => {
    const paths = resolvePaths(home)
    writeConfig({
      providers: {
        default: "ds",
        entries: {
          ds: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x", model: "deepseek-chat" },
        },
      },
    })
    const cfg = loadConfig(paths)
    expect(cfg.providers.entries.ds!.format).toBeUndefined()
    expect(resolveProviderFormat(cfg.providers.entries.ds!)).toBe("openai")
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

describe("resolveRunModel", () => {
  const base = (over: Partial<KclawConfig["providers"]> = {}) => {
    const cfg = structuredClone(defaultConfig)
    Object.assign(cfg.providers, over)
    return cfg
  }

  it("resolves an entry-named model to the entry's wire model, window budget and maxOutput", () => {
    const cfg = base({
      default: "m",
      entries: {
        m: { baseUrl: "http://x", apiKey: "k", model: "m1" },
        d: {
          baseUrl: "http://x", apiKey: "k", model: "d1",
          contextWindow: 200_000, maxOutput: 8_192,
        },
      },
    })
    const r = resolveRunModel(cfg, "d")
    expect(r.model).toBe("d1")
    expect(r.entryKey).toBe("d")
    expect(r.budget).toBe(200_000)
    expect(r.maxOutput).toBe(8_192)
  })

  it("passes a raw wire model through with default-entry budget resolution", () => {
    const cfg = base({
      default: "m",
      entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 90_000 } },
    })
    const r = resolveRunModel(cfg, "m1")
    expect(r.model).toBe("m1")
    expect(r.entryKey).toBe("m")
    expect(r.budget).toBe(90_000)
    expect(r.maxOutput).toBeUndefined()
  })

  it("falls back to the 128k default with no entries and no caps", () => {
    const r = resolveRunModel(base(), "some-model")
    expect(r.model).toBe("some-model")
    expect(r.entryKey).toBe("")
    expect(r.budget).toBe(128_000)
    expect(r.maxOutput).toBeUndefined()
  })
})

describe("server.port", () => {
  it("merges a valid port from the config file and survives a saveConfig roundtrip", () => {
    const paths = resolvePaths(home)
    writeConfig({ server: { port: 48213 } })
    const cfg = loadConfig(resolvePaths(home))
    expect(cfg.server?.port).toBe(48213)
    saveConfig(paths, cfg)
    expect(loadConfig(resolvePaths(home)).server?.port).toBe(48213)
  })
  it("falls an out-of-range/non-integer port back to unset (ephemeral) with a warning", () => {
    const paths = resolvePaths(home)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const bad of [0, -1, 70000, "abc", 1.5]) {
        writeConfig({ server: { port: bad } })
        const cfg = loadConfig(resolvePaths(home))
        expect(cfg.server?.port).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]![0]).toContain("server.port")
        warn.mockClear()
      }
    } finally {
      warn.mockRestore()
    }
  })
  it("falls a non-mapping server section back wholesale with a warning", () => {
    const paths = resolvePaths(home)
    writeConfig({ server: 3 })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.server).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("renameProviderEntry", () => {
  function cfgWith(over?: (cfg: KclawConfig) => void): KclawConfig {
    const cfg = structuredClone(defaultConfig)
    cfg.providers = {
      default: "main",
      entries: {
        main: { format: "openai", baseUrl: "https://main", apiKey: "k1", model: "m1" },
        other: { format: "openai", baseUrl: "https://other", apiKey: "k2", model: "m2" },
      },
      timeoutMs: 1000,
    }
    over?.(cfg)
    return cfg
  }

  it("moves the entry and rewrites every config-level reference", () => {
    const cfg = cfgWith((c) => {
      c.memory.extractModel = "main"
      c.memory.embedding = { provider: "main", model: "e" }
    })
    renameProviderEntry(cfg, "main", "renamed")
    expect(Object.keys(cfg.providers.entries)).toEqual(["other", "renamed"])
    expect(cfg.providers.default).toBe("renamed")
    expect(cfg.memory.extractModel).toBe("renamed")
    expect(cfg.memory.embedding!.provider).toBe("renamed")
  })

  it("leaves values that are not the renamed entry alone (bare model names)", () => {
    const cfg = cfgWith((c) => {
      c.memory.extractModel = "some-bare-model"
      c.memory.embedding = { provider: "main", model: "e" }
    })
    renameProviderEntry(cfg, "main", "renamed")
    expect(cfg.memory.extractModel).toBe("some-bare-model")
    expect(cfg.memory.embedding!.provider).toBe("renamed")
  })

  it("rejects unknown sources and conflicting targets without mutating", () => {
    const cfg = cfgWith()
    expect(() => renameProviderEntry(cfg, "ghost", "x")).toThrow("unknown provider entry: ghost")
    expect(() => renameProviderEntry(cfg, "main", "other")).toThrow('provider entry "other" already exists')
    expect(Object.keys(cfg.providers.entries)).toEqual(["main", "other"])
    expect(cfg.providers.default).toBe("main")
  })

  it("reference registry covers the three config slots (canary for new ones)", () => {
    expect(PROVIDER_ENTRY_REFERENCES.length).toBe(3)
  })
})

describe("skills.evolution config", () => {
  it("exposes the expected defaults (feature on)", () => {
    expect(defaultConfig.skills).toEqual({ evolution: { enabled: true, idleMinutes: 10 } })
  })

  it("deep-merges user values over defaults", () => {
    writeConfig({ skills: { evolution: { enabled: true, idleMinutes: 5 } } })
    const cfg = loadConfig(resolvePaths(home))
    expect(cfg.skills?.evolution).toEqual({ enabled: true, idleMinutes: 5 })
  })

  it("falls back per field with a warning on invalid values; idleMinutes 0 is legal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      writeConfig({ skills: { evolution: { enabled: "yes-please", idleMinutes: -3 } } })
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.skills?.evolution?.enabled).toBe(false)
      expect(cfg.skills?.evolution?.idleMinutes).toBe(10)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("skills.evolution")).length).toBe(2)

      warn.mockClear()
      writeConfig({ skills: { evolution: { enabled: true, idleMinutes: 0 } } })
      const zero = loadConfig(resolvePaths(home))
      expect(zero.skills?.evolution).toEqual({ enabled: true, idleMinutes: 0 })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("falls back wholesale when the section is not a mapping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      writeConfig({ skills: "nope" })
      const cfg = loadConfig(resolvePaths(home))
      expect(cfg.skills).toEqual({ evolution: { enabled: true, idleMinutes: 10 } })
    } finally {
      warn.mockRestore()
    }
  })
})
