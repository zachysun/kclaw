/**
 * detectProviderStatus: the triage the first-run wizard
 * and the chat entry will branch on — "config" when config.yaml carries a
 * resolvable providers.default entry, "env" when any KCLAW_LLM_* env var is
 * set, "missing" otherwise. Goes through the public path only: config.yaml
 * is written to a temp home, no internals are mocked. loadConfig treats a
 * missing file as defaults (providers.default: ""), which must fall through
 * to the env check rather than report "config".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectProviderStatus } from "../src/provider-check.js"

const ENV_KEYS = ["KCLAW_LLM_BASE_URL", "KCLAW_LLM_API_KEY", "KCLAW_LLM_MODEL"] as const

describe("detectProviderStatus", () => {
  let home: string
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), "kclaw-pc-")) })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  it("missing when no config and no env", () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    expect(detectProviderStatus(home)).toBe("missing")
  })
  it("env when any KCLAW_LLM_* set", () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    process.env.KCLAW_LLM_API_KEY = "sk-x"
    try { expect(detectProviderStatus(home)).toBe("env") } finally { delete process.env.KCLAW_LLM_API_KEY }
  })
  it("config when providers.default entry exists", () => {
    writeFileSync(join(home, "config.yaml"),
      "providers:\n  default: p1\n  entries:\n    p1:\n      baseUrl: http://x\n      apiKey: k\n      model: m\n")
    ENV_KEYS.forEach((k) => delete process.env[k])
    expect(detectProviderStatus(home)).toBe("config")
  })
})
