/**
 * DailyView — 日报页测试。照 memoryView.test.tsx 的 fake-api 模式：
 * 项目清单 → 日期索引 → 单日卡片流 → 展开选项回调 / 重新生成 / 设置保存。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { DailyView } from "../../src/daily/DailyView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPORT = {
  date: "2026-11-19",
  windowStart: "2026-11-19T00:00:00Z",
  windowEnd: "2026-11-19T08:00:00Z",
  generatedAt: "2026-11-19T08:00:00Z",
  cards: [
    {
      kind: "achievement",
      title: "日报功能上线",
      body: "今天把日报生成与展示全部写完。",
      visual: [
        { kind: "stat", label: "测试通过", value: "569" },
        { kind: "stat", label: "构建耗时", value: "1.4", unit: "s" },
      ],
      options: [{ label: "聊聊下一步", opener: "关于日报功能上线，我想继续聊聊下一步怎么演进。" }],
    },
    {
      kind: "lesson",
      title: "确认超时不是写失败",
      body: "原样重试就落盘。",
      visual: [
        { kind: "quote", text: "确认超时，操作未执行", source: "fs_write 返回" },
        { kind: "list", items: ["超时后原样重试即可", "不需要换工具"] },
      ],
      options: [],
    },
    { kind: "blocker", title: "样式对不齐", body: "卡片流在窄屏挤压。", options: [] },
  ],
}

function fakeApi(over: Record<string, unknown> = {}): ApiClient & {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "2026-11-19" }]
      if (path === "/memory/daily/kclaw-a3f2c9") return { dates: ["2026-11-19", "2026-11-18"] }
      if (path === "/memory/daily/kclaw-a3f2c9/2026-11-19") return REPORT
      if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => ({ report: REPORT })),
    patch: vi.fn(async () => ({ daily: { hour: 22, intervalDays: 3 } })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => { throw new Error("unused") }),
    ...over,
  } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(
  api: ApiClient,
  notice: (text: string) => void = () => {},
  onContinue: (workdir: string, opener: string) => Promise<void> = async () => {},
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<DailyView api={api} notice={notice} onContinue={onContinue} />)
  })
  await flush() // 项目清单 + 配置两个 GET 落定
  await flush() // 自动选项目 → 日期索引 → 当日报告的链式 effect
  return { container, root }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = ([...container.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => b.textContent?.includes(text))
  if (btn === undefined) throw new Error(`no button containing ${text}`)
  return btn
}

function setInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("DailyView", () => {
  it("auto-selects the first project and its latest report; kinds map to Chinese labels", async () => {
    const api = fakeApi()
    const { container, root } = await mount(api)
    try {
      expect(container.querySelector('[data-testid="daily-projects"]')!.textContent).toContain("kclaw-a3f2c9")
      expect(container.querySelector('[data-testid="daily-date"]')!.textContent).toBe("2026-11-19")
      const cards = container.querySelector('[data-testid="daily-cards"]')!
      expect(cards.textContent).toContain("日报功能上线")
      expect(cards.textContent).toContain("成果")
      expect(cards.textContent).toContain("卡点")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("renders the visual components through the ui-render renderer (read-only)", async () => {
    const api = fakeApi()
    const { container, root } = await mount(api)
    try {
      // stat 数字对（ui_render 同一套渲染器与样式族）
      const stats = [...container.querySelectorAll('[data-testid="ui-stat"]')]
      expect(stats.length).toBeGreaterThanOrEqual(2)
      expect(stats[0]!.textContent).toContain("569")
      expect(stats[0]!.textContent).toContain("测试通过")
      // quote 原文引用（含出处）
      const quote = container.querySelector('[data-testid="ui-quote"]')!
      expect(quote.textContent).toContain("确认超时，操作未执行")
      expect(quote.textContent).toContain("fs_write 返回")
      // list 清单
      const list = container.querySelector('[data-testid="ui-list"]')!
      expect(list.textContent).toContain("超时后原样重试即可")
      // 只读：日报卡片内的 ui 组件没有回传通道，无交互按钮渲染
      expect(container.querySelector('[data-testid="ui-button"]')).toBeNull()
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("an option click calls onContinue with the project workdir and the opener", async () => {
    const api = fakeApi()
    const onContinue = vi.fn(async () => {})
    const { container, root } = await mount(api, () => {}, onContinue)
    try {
      await act(async () => {
        buttonByText(container, "聊聊下一步").click()
      })
      expect(onContinue).toHaveBeenCalledWith("/w/kclaw", "关于日报功能上线，我想继续聊聊下一步怎么演进。")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("regenerate posts the current date and replaces the report", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container, root } = await mount(api, (t) => { notices.push(t) })
    try {
      await act(async () => {
        buttonByText(container, "重新生成这天").click()
      })
      await flush()
      expect(api.post).toHaveBeenCalledWith("/memory/daily/kclaw-a3f2c9/regenerate", { date: "2026-11-19" })
      expect(notices).toContain("已重新生成")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("date navigation walks the index and disables at the edges", async () => {
    const api = fakeApi()
    const { container, root } = await mount(api)
    try {
      // 最新一天（2026-11-19）没有更晚的日子
      expect((container.querySelector('[data-testid="daily-next"]') as HTMLButtonElement).disabled).toBe(true)
      await act(async () => {
        ;(container.querySelector('[data-testid="daily-prev"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(container.querySelector('[data-testid="daily-date"]')!.textContent).toBe("2026-11-18")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("saves the generation settings via PATCH /config", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container, root } = await mount(api, (t) => { notices.push(t) })
    try {
      setInput(container.querySelector('[data-testid="daily-hour"]') as HTMLInputElement, "22")
      setInput(container.querySelector('[data-testid="daily-interval"]') as HTMLInputElement, "3")
      await act(async () => {
        buttonByText(container, "保存设置").click()
      })
      await flush()
      expect(api.patch).toHaveBeenCalledWith("/config", { daily: { hour: 22, intervalDays: 3 } })
      expect(notices.some((n) => n.includes("已保存"))).toBe(true)
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("shows the empty states: no projects, project with no reports, day with no cards", async () => {
    // 无项目
    const empty = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/daily/projects") return []
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const c1 = await mount(empty)
    try {
      expect(c1.container.textContent).toContain("还没有项目日报")
    } finally { c1.root.unmount(); c1.container.remove() }

    // 项目还没有任何日报：空态带"立即生成今天"入口（今天无文件象限的 UI 路径）
    const noReports = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "" }]
        if (path === "/memory/daily/kclaw-a3f2c9") return { dates: [] }
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      }),
      post: vi.fn(async (path: string, body: { date: string }) => {
        if (path === "/memory/daily/kclaw-a3f2c9/regenerate") {
          expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          return { report: REPORT }
        }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const c2 = await mount(noReports)
    try {
      expect(c2.container.querySelector('[data-testid="daily-empty-project"]')).not.toBeNull()
      await act(async () => {
        ;(c2.container.querySelector('[data-testid="daily-generate-today"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(noReports.post).toHaveBeenCalled()
    } finally { c2.root.unmount(); c2.container.remove() }

    // 当天报告没有卡片
    const noCards = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "2026-11-19" }]
        if (path === "/memory/daily/kclaw-a3f2c9") return { dates: ["2026-11-19"] }
        if (path === "/memory/daily/kclaw-a3f2c9/2026-11-19") return { ...REPORT, cards: [] }
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const c3 = await mount(noCards)
    try {
      expect(c3.container.querySelector('[data-testid="daily-no-cards"]')).not.toBeNull()
    } finally { c3.root.unmount(); c3.container.remove() }
  })

  it("distinguishes an index load failure from the empty state, with a retry", async () => {
    const failing = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "" }]
        if (path === "/memory/daily/kclaw-a3f2c9") throw new Error("memory unavailable")
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const notices: string[] = []
    const notice = (t: string): void => { notices.push(t) }
    try {
      await act(async () => {
        root.render(<DailyView api={failing} notice={notice} onContinue={async () => {}} />)
      })
      await flush()
      await flush()
      // 索引失败是错误态，不得伪装成"还没有日报"空态
      expect(container.querySelector('[data-testid="daily-dates-error"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="daily-empty-project"]')).toBeNull()
      expect(notices.some((n) => n.includes("加载日报索引失败"))).toBe(true)
      // 重试：失败一次后恢复 → 正常进入空态/日期流
      ;(failing.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "2026-11-19" }]
        if (path === "/memory/daily/kclaw-a3f2c9") return { dates: ["2026-11-19"] }
        if (path === "/memory/daily/kclaw-a3f2c9/2026-11-19") return REPORT
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="daily-dates-retry"]') as HTMLButtonElement).click()
      })
      await flush()
      await flush()
      expect(container.querySelector('[data-testid="daily-dates-error"]')).toBeNull()
      expect(container.querySelector('[data-testid="daily-date"]')!.textContent).toBe("2026-11-19")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("a report read failure renders an error with a retry that refetches", async () => {
    let fail = true
    const api = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/daily/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", latest: "2026-11-19" }]
        if (path === "/memory/daily/kclaw-a3f2c9") return { dates: ["2026-11-19"] }
        if (path === "/memory/daily/kclaw-a3f2c9/2026-11-19") {
          if (fail) { fail = false; throw new Error("boom") }
          return REPORT
        }
        if (path === "/config") return { daily: { hour: 8, intervalDays: 1 } }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const { container, root } = await mount(api)
    try {
      expect(container.querySelector('[data-testid="daily-report-error"]')).not.toBeNull()
      await act(async () => {
        ;(container.querySelector('[data-testid="daily-report-retry"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(container.querySelector('[data-testid="daily-report-error"]')).toBeNull()
      expect(container.querySelector('[data-testid="daily-cards"]')).not.toBeNull()
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
