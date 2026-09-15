import { describe, it, expect } from "vitest"
import { PROVIDER_PRESETS, findProviderPreset, parseProviderEntry } from "../../src/provider/presets.js"

describe("provider presets", () => {
  it("covers the openai and anthropic wire formats with prewritten urls", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(["openai", "anthropic", "deepseek", "ollama"])
    expect(findProviderPreset("anthropic")).toMatchObject({ format: "anthropic", baseUrl: "https://api.anthropic.com" })
    expect(findProviderPreset("nope")).toBeUndefined()
  })
})

describe("parseProviderEntry", () => {
  const ok = { format: "openai", baseUrl: "https://api.x.com/v1", apiKey: "k", model: "m" }

  it("accepts a valid entry and drops unknown fields", () => {
    expect(parseProviderEntry({ ...ok, rogue: 1 })).toEqual(ok)
  })

  it("defaults a missing format to openai and keeps an intentionally empty apiKey", () => {
    expect(parseProviderEntry({ baseUrl: "http://localhost:11434/v1", model: "llama3" }))
      .toEqual({ format: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3" })
  })

  it("throws readable errors on bad input", () => {
    expect(() => parseProviderEntry(null)).toThrow("must be an object")
    expect(() => parseProviderEntry({ ...ok, format: "grpc" })).toThrow('must be "openai" or "anthropic"')
    expect(() => parseProviderEntry({ ...ok, baseUrl: "" })).toThrow("baseUrl is required")
    expect(() => parseProviderEntry({ ...ok, baseUrl: "ftp://x" })).toThrow("must start with http")
    expect(() => parseProviderEntry({ ...ok, model: "  " })).toThrow("model is required")
    expect(() => parseProviderEntry({ ...ok, contextWindow: -1 })).toThrow("positive number")
    expect(() => parseProviderEntry({ ...ok, maxOutput: Number.NaN })).toThrow("positive number")
  })
})
