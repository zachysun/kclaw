/**
 * Tests for the daemon client hooks: useDaemonClients' render-stability
 * guarantee (the contract that used to live in a comment) and
 * useSilentFetch's cancelled/silent semantics.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act, useEffect, useRef, useState } from "react"
import { createWsClient } from "../src/ws.js"
import { useDaemonClients, useSilentFetch, type DaemonClients } from "../src/daemon-clients.js"

vi.mock("../src/ws.js", () => ({
  createWsClient: vi.fn((url: string, token: string) => ({
    send: vi.fn(),
    close: vi.fn(),
    frames: {},
    onClose: vi.fn(),
    __url: url,
    __token: token,
  })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const r of roots.splice(0)) r.unmount()
  for (const c of containers.splice(0)) c.remove()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("useDaemonClients", () => {
  it("keeps api and createWs reference-stable across re-renders; rebuilds only when the token changes", async () => {
    const seen: Array<{ api: unknown; createWs: unknown }> = []
    const stableHandler = () => {} // 参与 api 身份，必须稳定（与旧 useMemo 语义一致）
    function Probe({ token }: { token: string }) {
      const clients = useDaemonClients(token, stableHandler)
      const first = useRef(true)
      // Record on mount and on every render caused by the prop change below.
      seen.push({ api: clients.api, createWs: clients.createWs })
      useEffect(() => {
        first.current = false
      })
      return null
    }

    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<Probe token="t0" />)
    })
    await act(async () => {
      root.render(<Probe token="t0" />)
    })
    await act(async () => {
      root.render(<Probe token="t0" />)
    })
    // Same token → the same api/createWs instances across renders.
    expect(seen[1]!.api).toBe(seen[0]!.api)
    expect(seen[2]!.api).toBe(seen[0]!.api)
    expect(seen[2]!.createWs).toBe(seen[0]!.createWs)

    await act(async () => {
      root.render(<Probe token="t1" />)
    })
    // A rotated token rebuilds both (the api's getToken closure must follow).
    expect(seen[3]!.api).not.toBe(seen[0]!.api)
    expect(seen[3]!.createWs).not.toBe(seen[0]!.createWs)
  })

  it("wires the current token and same-origin ws url into the factory", async () => {
    let captured: DaemonClients | null = null
    function Probe({ token }: { token: string }) {
      captured = useDaemonClients(token, () => {})
      return null
    }
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<Probe token="tok-9" />)
    })
    const client = captured!.createWs() as unknown as { __token: string; __url: string }
    expect(client.__token).toBe("tok-9")
    expect(client.__url).toMatch(/^wss?:\/\/[^/]+\/ws$/)
    expect(vi.mocked(createWsClient)).toHaveBeenCalledWith("ws://localhost:3000/ws", "tok-9")
  })
})

describe("useSilentFetch", () => {
  it("lands fetched data via onData and re-runs when deps change", async () => {
    const seen: string[] = []
    function Probe({ sessionId }: { sessionId: string }) {
      useSilentFetch(
        () => Promise.resolve(`data-${sessionId}`),
        (d) => seen.push(d),
        [sessionId],
      )
      return null
    }
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<Probe sessionId="s1" />)
    })
    await flush()
    expect(seen).toEqual(["data-s1"])
    await act(async () => {
      root.render(<Probe sessionId="s2" />)
    })
    await flush()
    expect(seen).toEqual(["data-s1", "data-s2"])
  })

  it("swallows failures silently", async () => {
    const seen: string[] = []
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    function Probe() {
      useSilentFetch(
        () => Promise.reject(new Error("daemon down")),
        (d) => seen.push(d),
        [],
      )
      return null
    }
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<Probe />)
    })
    await flush()
    expect(seen).toEqual([])
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it("does not land data after unmount (the cancelled guard)", async () => {
    const seen: string[] = []
    function Probe() {
      useSilentFetch(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5)),
        (d) => seen.push(d),
        [],
      )
      return null
    }
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Probe />)
    })
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
  })
})
