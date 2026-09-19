/** feishu.json 加载：缺省关、字段校验、enabled 必须带凭证（#45 配置决策）；管理页写入与待加白记录（#46）。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadFeishuConfig,
  saveFeishuConfig,
  loadFeishuState,
  saveFeishuState,
  normalizePendingSenders,
  PENDING_SENDERS_CAP,
} from "../../src/feishu/config.js"

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kclaw-feishu-cfg-")) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe("loadFeishuConfig", () => {
  it("defaults to disabled when the file is absent", () => {
    expect(loadFeishuConfig(home)).toEqual({
      enabled: false, appId: "", appSecret: "", allowlist: [],
    })
  })

  it("parses the snake_case fields", () => {
    writeFileSync(join(home, "feishu.json"), JSON.stringify({
      enabled: true, app_id: "cli_a1", app_secret: "s3cret",
      allowlist: ["ou_1", "ou_2"], primaryOpenId: "ou_1",
    }))
    expect(loadFeishuConfig(home)).toEqual({
      enabled: true, appId: "cli_a1", appSecret: "s3cret",
      allowlist: ["ou_1", "ou_2"], primaryOpenId: "ou_1",
    })
  })

  it("throws when enabled but credentials are missing", () => {
    writeFileSync(join(home, "feishu.json"), JSON.stringify({ enabled: true, app_id: "cli_a1" }))
    expect(() => loadFeishuConfig(home)).toThrow(/app_secret/)
  })

  it("throws on malformed JSON", () => {
    writeFileSync(join(home, "feishu.json"), "{not json")
    expect(() => loadFeishuConfig(home)).toThrow(/feishu\.json/)
  })

  it("tightens a loose file mode to 0600 (best effort)", () => {
    writeFileSync(join(home, "feishu.json"), JSON.stringify({ enabled: false }), { mode: 0o644 })
    loadFeishuConfig(home)
    expect(statSync(join(home, "feishu.json")).mode & 0o777).toBe(0o600)
  })
})

describe("saveFeishuConfig", () => {
  it("writes the snake_case shape that loadFeishuConfig reads back", () => {
    const config = { enabled: true, appId: "cli_a1", appSecret: "s3cret", allowlist: ["ou_1"], primaryOpenId: "ou_1" }
    saveFeishuConfig(home, config)
    expect(statSync(join(home, "feishu.json")).mode & 0o777).toBe(0o600)
    const disk = JSON.parse(readFileSync(join(home, "feishu.json"), "utf8")) as Record<string, unknown>
    expect(disk).toEqual({
      enabled: true, app_id: "cli_a1", app_secret: "s3cret", allowlist: ["ou_1"], primaryOpenId: "ou_1",
    })
    expect(loadFeishuConfig(home)).toEqual(config)
  })

  it("omits primaryOpenId when unset", () => {
    saveFeishuConfig(home, { enabled: false, appId: "", appSecret: "", allowlist: [] })
    const disk = JSON.parse(readFileSync(join(home, "feishu.json"), "utf8")) as Record<string, unknown>
    expect("primaryOpenId" in disk).toBe(false)
  })
})

describe("pendingSenders state", () => {
  it("round-trips through feishu-state.json alongside bindings", () => {
    saveFeishuState(home, {
      bindings: { ou_1: "s1" },
      pendingSenders: [{ openId: "ou_9", count: 3, lastSeen: 42 }],
    })
    expect(loadFeishuState(home)).toEqual({
      bindings: { ou_1: "s1" },
      pendingSenders: [{ openId: "ou_9", count: 3, lastSeen: 42 }],
    })
  })

  it("loads an empty list for legacy files without the field", () => {
    writeFileSync(join(home, "feishu-state.json"), JSON.stringify({ bindings: { ou_1: "s1" } }))
    expect(loadFeishuState(home)).toEqual({ bindings: { ou_1: "s1" }, pendingSenders: [] })
  })

  it("drops malformed entries on load", () => {
    writeFileSync(join(home, "feishu-state.json"), JSON.stringify({
      bindings: {},
      pendingSenders: [{ openId: "ou_ok", count: 1, lastSeen: 7 }, { openId: "" }, { count: 2 }, "junk"],
    }))
    expect(loadFeishuState(home).pendingSenders).toEqual([{ openId: "ou_ok", count: 1, lastSeen: 7 }])
  })
})

describe("normalizePendingSenders", () => {
  it("sorts newest first and caps the list", () => {
    const list = Array.from({ length: PENDING_SENDERS_CAP + 5 }, (_, i) => ({
      openId: `ou_${i}`,
      count: 1,
      lastSeen: i,
    }))
    const normalized = normalizePendingSenders(list)
    expect(normalized).toHaveLength(PENDING_SENDERS_CAP)
    expect(normalized[0]!.openId).toBe(`ou_${PENDING_SENDERS_CAP + 4}`)
    expect(normalized[normalized.length - 1]!.openId).toBe("ou_5")
  })
})
