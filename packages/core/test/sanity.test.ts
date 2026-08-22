import { describe, it, expect } from "vitest"
import { CORE_NAME } from "../src/index.js"

describe("sanity", () => {
  it("exports package name", () => {
    expect(CORE_NAME).toBe("@kclaw/core")
  })
})
