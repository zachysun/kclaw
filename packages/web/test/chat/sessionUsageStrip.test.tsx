/**
 * SessionUsageStrip tests: session-scoped in/out + cache hit-rate rendering
 * (unknown metrics show "—", never 0%), refresh driven by refreshKey bumps,
 * silent keep-last-value on fetch failure, and the ChatView composer slot
 * that places the strip under the input box.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { SessionUsageStrip, fmtCompact, hitRateText } from "../../src/chat/SessionUsageStrip.js"
import { ChatView } from "../../src/chat/ChatView.js"
import { initChat, type Message } from "../../src/chat/model.js"
import type { ApiClient } from "../../src/api.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Bucket { key: string; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number }

function usageBody(buckets: Bucket[]): { by: string; buckets: Bucket[]; total: unknown } {
  return { by: "session", buckets, total: {} }
}

const b = (over: Partial<Bucket> & { key: string }): Bucket => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0, ...over,
})

function mountStrip(api: ApiClient, sessionId: string, refreshKey = 0): { container: HTMLDivElement; root: Root; text: () => string } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<SessionUsageStrip api={api} sessionId={sessionId} refreshKey={refreshKey} />)
  })
  return { container, root, text: () => container.querySelector<HTMLElement>('[data-testid="session-usage-strip"]')?.textContent ?? "" }
}

describe("SessionUsageStrip", () => {
  it("shows the current session's cumulative tokens and hit rate (compact format)", async () => {
    const get = vi.fn().mockResolvedValue(usageBody([
      b({ key: "other", inputTokens: 99, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 }),
      b({ key: "s1", inputTokens: 14259, outputTokens: 1800, cacheReadTokens: 12400, cacheWriteTokens: 300 }),
    ]))
    const { root, container, text } = mountStrip({ get } as unknown as ApiClient, "s1")
    await act(async () => {})
    expect(text()).toBe("in 14.3k · out 1.8k · cache 87%")
    act(() => root.unmount())
    container.remove()
  })

  it("unknown cache metrics (null) show — instead of a fake 0%", async () => {
    const get = vi.fn().mockResolvedValue(usageBody([b({ key: "s1", inputTokens: 500, outputTokens: 20 })]))
    const { root, container, text } = mountStrip({ get } as unknown as ApiClient, "s1")
    await act(async () => {})
    expect(text()).toBe("in 500 · out 20 · cache —")
    act(() => root.unmount())
    container.remove()
  })

  it("a session with no usage rows yet renders zeros and an unknown hit rate", async () => {
    const get = vi.fn().mockResolvedValue(usageBody([]))
    const { root, container, text } = mountStrip({ get } as unknown as ApiClient, "s1")
    await act(async () => {})
    expect(text()).toBe("in 0 · out 0 · cache —")
    act(() => root.unmount())
    container.remove()
  })

  it("a refreshKey bump refetches and adopts the new numbers", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(usageBody([b({ key: "s1", inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 })]))
      .mockResolvedValueOnce(usageBody([b({ key: "s1", inputTokens: 1100, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 40 })]))
    const api = { get } as unknown as ApiClient
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<SessionUsageStrip api={api} sessionId="s1" refreshKey={0} />)
    })
    await act(async () => {})
    const strip = () => container.querySelector<HTMLElement>('[data-testid="session-usage-strip"]')?.textContent ?? ""
    expect(strip()).toBe("in 100 · out 10 · cache 80%")
    act(() => {
      root.render(<SessionUsageStrip api={api} sessionId="s1" refreshKey={1} />)
    })
    await act(async () => {})
    expect(get).toHaveBeenCalledTimes(2)
    expect(strip()).toBe("in 1.1k · out 60 · cache 91%")
    act(() => root.unmount())
    container.remove()
  })

  it("a failed fetch keeps the previous values and stays silent", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(usageBody([b({ key: "s1", inputTokens: 200, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 })]))
      .mockRejectedValueOnce(new Error("daemon gone"))
    const api = { get } as unknown as ApiClient
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<SessionUsageStrip api={api} sessionId="s1" refreshKey={0} />)
    })
    await act(async () => {})
    act(() => {
      root.render(<SessionUsageStrip api={api} sessionId="s1" refreshKey={1} />)
    })
    await act(async () => {})
    const strip = container.querySelector<HTMLElement>('[data-testid="session-usage-strip"]')
    expect(strip?.textContent).toBe("in 200 · out 30 · cache 50%")
    act(() => root.unmount())
    container.remove()
  })
})

describe("SessionUsageStrip formatting edges", () => {
  it("fmtCompact: plain below 1k, one decimal k, integer k past 100, M past 1M", () => {
    expect(fmtCompact(0)).toBe("0")
    expect(fmtCompact(980)).toBe("980")
    expect(fmtCompact(14259)).toBe("14.3k")
    expect(fmtCompact(242_000)).toBe("242k")
    expect(fmtCompact(3_140_000)).toBe("3.1M")
  })

  it("hitRateText: divides by the input identity sum, 0-input guard, unknown → —", () => {
    expect(hitRateText(b({ key: "x", inputTokens: 200, cacheReadTokens: 150, cacheWriteTokens: 50 }))).toBe("75%")
    expect(hitRateText(b({ key: "x", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))).toBe("0%")
    expect(hitRateText(b({ key: "x", inputTokens: 500, cacheReadTokens: null }))).toBe("—")
    expect(hitRateText(undefined)).toBe("—")
  })
})

describe("ChatView usage slot", () => {
  it("renders the strip under the composer (last child of chat-host)", () => {
    const messages: Message[] = []
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <ChatView
          view={initChat(messages)}
          onSend={() => {}}
          onResolveConfirmation={() => {}}
          onAnswerQuestion={() => {}}
          pendingAttachments={[]}
          onRemoveAttachment={() => {}}
          usage={<div data-testid="strip-under-composer">in 0 · out 0 · cache —</div>}
        />,
      )
    })
    const host = container.querySelector('[data-testid="chat-view"]')
    expect(host).not.toBeNull()
    // The strip is the last child of the chat column — right under the composer form.
    expect(host!.lastElementChild?.getAttribute("data-testid")).toBe("strip-under-composer")
    expect(container.querySelector("form.chat-composer")).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-input"]')).not.toBeNull()
    act(() => root.unmount())
    container.remove()
  })
})
