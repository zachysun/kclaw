/**
 * Wizard pure functions: the template table the first-run
 * provider wizard offers, the config-entry builder that stamps template
 * defaults (ollama needs no real key — a placeholder is written so the
 * daemon's provider client can always send a Bearer header), and the
 * probe-error classifier that maps an HTTP status / fetch failure to a
 * 人话 reason AND to the wizard step a retry should return to. Only the
 * pure parts are unit-tested here; runWizard is interactive (TTY) and is
 * exercised by the smoke run.
 */
import { describe, it, expect } from "vitest"
import { PROVIDER_TEMPLATES, buildProviderEntry, classifyProbeError } from "../src/wizard.js"

describe("PROVIDER_TEMPLATES", () => {
  it("offers deepseek/openai/ollama/custom in that order", () => {
    expect(PROVIDER_TEMPLATES.map((t) => t.id)).toEqual(["deepseek", "openai", "ollama", "custom"])
  })
  it("built-ins carry baseUrl; ollama skips the key; custom defers baseUrl to the user", () => {
    const byId = Object.fromEntries(PROVIDER_TEMPLATES.map((t) => [t.id, t]))
    expect(byId.deepseek!.baseUrl).toBe("https://api.deepseek.com")
    expect(byId.ollama!.skipKey).toBe(true)
    expect(byId.custom!.baseUrl).toBeUndefined()
  })
})

describe("buildProviderEntry", () => {
  it("fills template fields", () => {
    const t = PROVIDER_TEMPLATES.find((x) => x.id === "deepseek")!
    expect(buildProviderEntry(t, "sk-1", "deepseek-chat"))
      .toEqual({ baseUrl: "https://api.deepseek.com", apiKey: "sk-1", model: "deepseek-chat" })
  })
  it("ollama uses placeholder key", () => {
    const t = PROVIDER_TEMPLATES.find((x) => x.id === "ollama")!
    expect(buildProviderEntry(t, "", "llama3").apiKey).toBe("ollama")
  })
})

describe("classifyProbeError", () => {
  it("401/403 → key", () => { expect(classifyProbeError(401, "")).toBe("key"); expect(classifyProbeError(403, "")).toBe("key") })
  it("null → network", () => { expect(classifyProbeError(null, "fetch failed")).toBe("network") })
  it("404 with model mention → model", () => { expect(classifyProbeError(404, "Model Not Exist")).toBe("model") })
  it("400 → model", () => { expect(classifyProbeError(400, "invalid model")).toBe("model") })
  it("else unknown", () => { expect(classifyProbeError(500, "boom")).toBe("unknown") })
})
