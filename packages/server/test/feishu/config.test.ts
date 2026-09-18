/** feishu.json 加载：缺省关、字段校验、enabled 必须带凭证（#45 配置决策）。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadFeishuConfig } from "../../src/feishu/config.js"

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
