import { describe, it, expect } from "vitest"
import { AutoLearnCounter } from "../../src/permissions/auto-learn.js"

describe("AutoLearnCounter", () => {
  it("threshold <= 0 disables induction: approve never fires, no state grows", () => {
    const c = new AutoLearnCounter(0)
    expect(c.approve("exec:git push*")).toBe(false)
    expect(c.approve("exec:git push*")).toBe(false)
    expect(c.size()).toBe(0)
  })

  it("returns true exactly once when the streak crosses the threshold, then resets", () => {
    const c = new AutoLearnCounter(3)
    expect(c.approve("exec:git push*")).toBe(false) // 1/3
    expect(c.approve("exec:git push*")).toBe(false) // 2/3
    expect(c.approve("exec:git push*")).toBe(true) // 3/3 → persist, reset
    // reset: the same key starts over instead of firing repeatedly
    expect(c.approve("exec:git push*")).toBe(false)
    expect(c.approve("exec:git push*")).toBe(false)
    expect(c.size()).toBe(1)
  })

  it("tracks distinct keys independently", () => {
    const c = new AutoLearnCounter(2)
    expect(c.approve("exec:git push*")).toBe(false)
    expect(c.approve("fs_write:/tmp/x")).toBe(false)
    expect(c.approve("exec:git push*")).toBe(true) // only this key crossed
    expect(c.size()).toBe(1) // exec key reset; fs key still live
  })

  it("reject resets the streak so a 'no' is never overwritten by older approvals", () => {
    const c = new AutoLearnCounter(3)
    c.approve("exec:rm -rf*")
    c.approve("exec:rm -rf*")
    c.reject("exec:rm -rf*")
    expect(c.size()).toBe(0)
    expect(c.approve("exec:rm -rf*")).toBe(false) // streak restarts from 1
  })

  it("a threshold of 1 fires on the first approval", () => {
    const c = new AutoLearnCounter(1)
    expect(c.approve("exec:ls")).toBe(true)
  })
})
