/**
 * Tests for the daemon client hooks: useDaemonClients' render-stability
 * guarantee (the contract that used to live in a comment) and
 * useSilentFetch's cancelled/silent semantics.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act, useEffect, useRef, useState } from "react"
import { createWsClient } from "../src/ws.js"
import { useDaemonClients, useSessionResource, useSilentFetch, type DaemonClients, type SessionResource } from "../src/daemon-clients.js"

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

describe("useSessionResource", () => {
  interface ProbeProps {
    sessionId: string
    fetcher: (sid: string) => Promise<string | null>
    resetOnSwitch?: boolean
    poll?: { intervalMs: number; when: (data: string | null) => boolean }
    onRender?: (resource: SessionResource<string>) => void
  }

  /** Props are fresh closures every render on purpose — the hook reads them through refs (no caller memo discipline). */
  function Probe(props: ProbeProps) {
    const resource = useSessionResource<string>(props)
    props.onRender?.(resource)
    return null
  }

  function mount(props: ProbeProps): { rerender: (next: ProbeProps) => Promise<void> } {
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(<Probe {...props} />)
    })
    const rerender = (next: ProbeProps) =>
      act(async () => {
        root.render(<Probe {...next} />)
      })
    return { rerender }
  }

  it("fetches on mount, resets on switch, and drops the previous session's late response", async () => {
    let resolveFirst!: (value: string | null) => void
    const first = new Promise<string | null>((resolve) => {
      resolveFirst = resolve
    })
    const fetcher = vi.fn((sid: string) => (sid === "s1" ? first : Promise.resolve(`data-${sid}`)))
    let res: SessionResource<string> | undefined
    const { rerender } = mount({ sessionId: "s1", fetcher, resetOnSwitch: true, onRender: (r) => (res = r) })
    expect(fetcher).toHaveBeenCalledWith("s1")
    expect(res!.data).toBe(null)
    // Switch while the s1 fetch is still in flight: the reset applies, the
    // switchover refresh is absorbed by the busy guard (same serialization
    // the old hand-written wiring had), and the panel waits for a retry.
    await rerender({ sessionId: "s2", fetcher, resetOnSwitch: true, onRender: (r) => (res = r) })
    await flush()
    expect(res!.data).toBe(null)
    // The stale s1 answer arrives only now — dropped by the session guard,
    // and its landing releases the busy guard for the next refresh.
    resolveFirst("stale-from-s1")
    await flush()
    expect(res!.data).toBe(null)
    res!.refresh()
    await flush()
    expect(res!.data).toBe("data-s2")
  })

  it("keeps the stale data on switch when resetOnSwitch is off (team-panel semantics)", async () => {
    let resolveS2!: (value: string | null) => void
    const s2 = new Promise<string | null>((resolve) => {
      resolveS2 = resolve
    })
    const fetcher = vi.fn((sid: string) => (sid === "s1" ? Promise.resolve("team-s1") : s2))
    let res: SessionResource<string> | undefined
    const { rerender } = mount({ sessionId: "s1", fetcher, onRender: (r) => (res = r) })
    await flush()
    expect(res!.data).toBe("team-s1")
    await rerender({ sessionId: "s2", fetcher, onRender: (r) => (res = r) })
    await flush()
    expect(res!.data).toBe("team-s1") // kept until the fresh answer lands
    resolveS2("team-s2")
    await flush()
    expect(res!.data).toBe("team-s2")
  })

  it("debounces concurrent refreshes through the busy guard", async () => {
    let resolvePending!: (value: string | null) => void
    const pending = new Promise<string | null>((resolve) => {
      resolvePending = resolve
    })
    const fetcher = vi.fn(() => pending)
    let res: SessionResource<string> | undefined
    mount({ sessionId: "s1", fetcher, onRender: (r) => (res = r) })
    expect(fetcher).toHaveBeenCalledTimes(1) // the mount fetch is in flight…
    res!.refresh()
    res!.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1) // …so these were all skipped
    resolvePending("x")
    await flush()
    res!.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("keeps stale data when the fetch rejects (silent by design)", async () => {
    let fail = false
    const fetcher = vi.fn(() => (fail ? Promise.reject(new Error("daemon down")) : Promise.resolve("good")))
    let res: SessionResource<string> | undefined
    mount({ sessionId: "s1", fetcher, onRender: (r) => (res = r) })
    await flush()
    expect(res!.data).toBe("good")
    fail = true
    await act(async () => {
      res!.refresh()
    })
    await flush()
    expect(res!.data).toBe("good")
  })

  it("polls on the interval while when(data) holds", async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn((sid: string) => Promise.resolve(`poll-${sid}`))
      mount({ sessionId: "s1", fetcher, poll: { intervalMs: 5000, when: () => true } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const afterMount = fetcher.mock.calls.length
      expect(afterMount).toBeGreaterThanOrEqual(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000 * 3)
      })
      expect(fetcher.mock.calls.length).toBe(afterMount + 3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps refresh/dataRef identity across renders and mirrors data in dataRef", async () => {
    const fetcher = vi.fn(() => Promise.resolve("mirror"))
    let res: SessionResource<string> | undefined
    const { rerender } = mount({ sessionId: "s1", fetcher, onRender: (r) => (res = r) })
    await flush()
    expect(res!.data).toBe("mirror")
    expect(res!.dataRef.current).toBe("mirror")
    const firstRefresh = res!.refresh
    const firstRef = res!.dataRef
    await rerender({ sessionId: "s1", fetcher: () => Promise.resolve("mirror"), onRender: (r) => (res = r) })
    expect(res!.refresh).toBe(firstRefresh) // stable even though the fetcher closure changed
    expect(res!.dataRef).toBe(firstRef)
  })
})
