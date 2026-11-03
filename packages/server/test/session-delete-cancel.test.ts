import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance } from "fastify"
import { createApp } from "../src/app.js"
import type { RunManager } from "../src/run.js"

let home: string
let app: FastifyInstance
const stopCalls: { id: string; dirPresentAtCall: boolean }[] = []
const settleCalls: { id: string; timeoutMs: number }[] = []
const fakeRun = {
  stopAndClear: (id: string) => {
    // dirPresentAtCall proves the stop happened before the purge cascade
    // (after rmSync the session directory is gone).
    stopCalls.push({ id, dirPresentAtCall: existsSync(join(home, "sessions", id)) })
    return { aborted: false, dropped: 0 }
  },
  awaitSettle: async (id: string, timeoutMs: number) => {
    settleCalls.push({ id, timeoutMs })
    return true
  },
} as unknown as RunManager

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kclaw-del-cancel-"))
  stopCalls.length = 0
  settleCalls.length = 0
  app = await createApp({ home, token: "t1", run: fakeRun })
})
afterEach(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true })
})

const auth = { authorization: "Bearer t1" }

describe("session delete/purge stops the session's own run first", () => {
  it("DELETE stops and awaits the run before the cascade", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload: {} })
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string
    const res = await app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth })
    expect(res.statusCode).toBe(200)
    expect(stopCalls.map((c) => c.id)).toEqual([id])
    expect(settleCalls).toEqual([{ id, timeoutMs: expect.any(Number) }])
  })

  it("purge stops and awaits the run before rmSync (the ghost-session guard)", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload: {} })
    const id = created.json().id as string
    const res = await app.inject({ method: "POST", url: `/sessions/${id}/purge`, headers: auth })
    expect(res.statusCode).toBe(200)
    expect(stopCalls.map((c) => c.id)).toEqual([id])
    expect(settleCalls).toEqual([{ id, timeoutMs: expect.any(Number) }])
    // Ordering proof: the session directory still existed when the stop was
    // recorded, so stopAndClear ran before the rmSync cascade.
    expect(stopCalls[0]!.dirPresentAtCall).toBe(true)
  })
})
