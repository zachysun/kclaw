/**
 * UsageView — the usage ledger page (用量统计页). Covers the prompt-cache
 * columns added with the cache-utilization work: 缓存读 / 缓存写 / 命中率
 * per day and per session, the "—" rendering for NULL (unknown — the
 * provider reported no metric), and the hit-rate computation
 * (cacheRead / total input) shown only when data exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { UsageView } from "../../src/usage/UsageView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Bucket = {
  key: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number
}

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    key: "2026-09-29",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0,
    ...overrides,
  }
}

const TOTAL: Bucket = bucket({ key: "total", inputTokens: 0, outputTokens: 0 })

function makeApi(buckets: Bucket[]): ApiClient {
  const api = {
    get: vi.fn((path: string) => {
      if (path.startsWith("/usage")) {
        const body = { by: path.includes("by=session") ? "session" : "day", buckets, total: TOTAL }
        return Promise.resolve(body)
      }
      if (path === "/sessions") return Promise.resolve([])
      return Promise.reject(new Error(`unexpected GET ${path}`))
    }),
  }
  return api as unknown as ApiClient
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Mount the view and flush the initial GET /usage effect. */
async function mount(api: ApiClient): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<UsageView api={api} />)
  })
  await act(async () => {})
  roots.push({ root, container })
  return container
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    root.unmount()
    container.remove()
  }
})

beforeEach(() => {
  document.body.innerHTML = ""
})

function cellTexts(table: Element): string[] {
  return [...table.querySelectorAll("tbody tr")].flatMap((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""))
}

function headerTexts(table: Element): string[] {
  return [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "")
}

describe("UsageView 缓存列", () => {
  it("renders 缓存读/缓存写/命中率 columns with values when the bucket carries cache data", async () => {
    const el = await mount(makeApi([
      bucket({ inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 200 }),
    ]))
    const table = el.querySelector('[data-testid="usage-day-table"]')!
    expect(headerTexts(table)).toContain("缓存读")
    expect(headerTexts(table)).toContain("缓存写")
    expect(headerTexts(table)).toContain("命中率")
    const cells = cellTexts(table)
    expect(cells).toContain("600")
    expect(cells).toContain("200")
    // hit rate = cacheRead / total input = 600/1000 = 60%
    expect(cells).toContain("60%")
  })

  it("shows — (unknown) for NULL cache fields, never 0, and no hit rate", async () => {
    const el = await mount(makeApi([bucket({ inputTokens: 1000 })]))
    const cells = cellTexts(el.querySelector('[data-testid="usage-day-table"]')!)
    expect(cells.filter((c) => c === "—")).toHaveLength(3) // 缓存读 / 缓存写 / 命中率 all unknown
    expect(cells).not.toContain("0%")
  })

  it("applies the same columns to the per-session table", async () => {
    const el = await mount(makeApi([
      bucket({ key: "ses_1", inputTokens: 800, cacheReadTokens: 400 }),
    ]))
    const table = el.querySelector('[data-testid="usage-session-table"]')!
    expect(headerTexts(table)).toContain("缓存读")
    const cells = cellTexts(table)
    expect(cells).toContain("400")
    expect(cells).toContain("50%") // 400/800
  })
})
