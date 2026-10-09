import { describe, it, expect } from "vitest"
import {
  anthropicEndpoint,
  expectProviderApiFormat,
  isProviderApiFormat,
  PROVIDER_WIRE_FORMATS,
  PROVIDER_WIRE_FORMAT_IDS,
  resolveFormat,
} from "../../src/provider/formats.js"

describe("wire-format registry", () => {
  it("lists every registry entry as an id and nothing else", () => {
    expect(PROVIDER_WIRE_FORMAT_IDS).toEqual(["openai", "anthropic"])
    for (const id of PROVIDER_WIRE_FORMAT_IDS) {
      expect(PROVIDER_WIRE_FORMATS[id].id).toBe(id)
    }
    expect(new Set(PROVIDER_WIRE_FORMAT_IDS).size).toBe(PROVIDER_WIRE_FORMAT_IDS.length)
  })

  it("guards untrusted input: both ids pass, near-misses do not", () => {
    expect(isProviderApiFormat("openai")).toBe(true)
    expect(isProviderApiFormat("anthropic")).toBe(true)
    for (const bad of ["OpenAI", "openai ", "", "gemini", undefined, null, 1]) {
      expect(isProviderApiFormat(bad)).toBe(false)
    }
  })

  it("expectProviderApiFormat echoes the id and names every option on failure", () => {
    expect(expectProviderApiFormat("anthropic")).toBe("anthropic")
    expect(() => expectProviderApiFormat("gemini")).toThrow(/"openai", "anthropic"/)
    expect(() => expectProviderApiFormat("gemini")).toThrow('"gemini"')
  })

  it("resolveFormat defaults omitted formats to openai", () => {
    expect(resolveFormat(undefined)).toBe("openai")
    expect(resolveFormat("anthropic")).toBe("anthropic")
  })

  it("anthropic auth: version always, x-api-key + Bearer when keyed, nothing when keyless", () => {
    const fmt = PROVIDER_WIRE_FORMATS.anthropic
    expect(fmt.authHeaders("sk-test")).toEqual({
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-test",
      authorization: "Bearer sk-test",
    })
    expect(fmt.authHeaders("")).toEqual({ "anthropic-version": "2023-06-01" })
  })

  it("openai auth: Bearer when keyed, no auth header when keyless", () => {
    expect(PROVIDER_WIRE_FORMATS.openai.authHeaders("sk-test")).toEqual({ authorization: "Bearer sk-test" })
    expect(PROVIDER_WIRE_FORMATS.openai.authHeaders("")).toEqual({})
  })

  it("anthropic endpoint tolerates bases with and without the /v1 segment", () => {
    expect(anthropicEndpoint("https://api.anthropic.com", "/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
    expect(anthropicEndpoint("https://proxy.example/v1/", "/messages")).toBe(
      "https://proxy.example/v1/messages",
    )
  })

  it("openai endpoint concatenates the path onto the trimmed base", () => {
    expect(PROVIDER_WIRE_FORMATS.openai.endpoint("https://api.deepseek.com/v1/", "/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    )
  })

  it("probe requests match each protocol's minimal completion shape", () => {
    expect(PROVIDER_WIRE_FORMATS.anthropic.probeRequest("claude-x")).toEqual({
      path: "/messages",
      payload: {
        model: "claude-x",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        max_tokens: 1,
      },
    })
    expect(PROVIDER_WIRE_FORMATS.openai.probeRequest("gpt-x")).toEqual({
      path: "/chat/completions",
      payload: { model: "gpt-x", messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
    })
  })

  it("only openai-family endpoints serve embeddings (the vector-path gate)", () => {
    expect(PROVIDER_WIRE_FORMATS.openai.hasEmbeddings).toBe(true)
    expect(PROVIDER_WIRE_FORMATS.anthropic.hasEmbeddings).toBe(false)
  })
})
