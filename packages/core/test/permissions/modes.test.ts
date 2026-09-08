import { describe, it, expect } from "vitest"
import { isPermissionMode, PERMISSION_MODES, PERMISSION_MODE_CONFIRMATIONS } from "../../src/permissions/modes.js"

describe("permission mode enum (batch C)", () => {
  it("ships the five mode tiers in strict-first order", () => {
    expect(PERMISSION_MODES).toEqual(["readonly", "default", "acceptEdits", "trusted", "auto"])
  })

  it("accepts every shipped mode and rejects anything else", () => {
    for (const m of PERMISSION_MODES) expect(isPermissionMode(m)).toBe(true)
    for (const bad of ["", "trust", "auto-learn", "ADMIN", "read-only", 3]) {
      expect(isPermissionMode(bad)).toBe(false)
    }
  })

  it("has a confirmation copy for every mode (the Record forces it at compile time)", () => {
    for (const m of PERMISSION_MODES) {
      expect(PERMISSION_MODE_CONFIRMATIONS[m]).toBeTruthy()
    }
  })

  it("trusted and auto copies describe their real semantics", () => {
    expect(PERMISSION_MODE_CONFIRMATIONS.trusted).toContain("免确认")
    expect(PERMISSION_MODE_CONFIRMATIONS.auto).toContain("自动沉淀")
  })
})
