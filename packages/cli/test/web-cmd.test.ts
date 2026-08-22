/**
 * Pure-function unit tests for the `kclaw web` command (v3 Phase 4 Task 9):
 * `buildWebUrl` (loopback URL with the token as a query param — the web
 * shell's bootstrapToken handoff) and `openCommandFor` (platform → browser
 * opener). webAction itself is covered by the manual smoke (it spawns a
 * browser); these two are the pure, testable core.
 */
import { describe, it, expect } from "vitest"
import { buildWebUrl, openCommandFor } from "../src/web-cmd.js"

describe("buildWebUrl", () => {
  it("builds token URL", () => {
    expect(buildWebUrl(8421, "tok-abc")).toBe("http://127.0.0.1:8421/?token=tok-abc")
  })
})
describe("openCommandFor", () => {
  it("darwin → open", () => { expect(openCommandFor("darwin")).toBe("open") })
  it("linux → xdg-open", () => { expect(openCommandFor("linux")).toBe("xdg-open") })
  it("win32 → null", () => { expect(openCommandFor("win32")).toBe(null) })
})
