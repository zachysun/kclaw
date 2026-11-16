/**
 * UiCardView render tests — every display kind produces its DOM shape, the
 * unknown-kind fallback renders nothing (the caller keeps the JSON row), and
 * the interactive cards (button / form) report through onAction with the
 * picked/snapshot contract. Pure view tests: no reducer, no ws.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { UiCardView } from "../../src/chat/UiCard.js"
import { isUiCardData, type UICard } from "@kclaw/core/protocol"

function mount(card: UICard, props: { onAction?: (a: unknown) => void; picked?: unknown; contextTitle?: string } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <UiCardView
        card={card}
        onAction={props.onAction as never}
        picked={props.picked as never}
        contextTitle={props.contextTitle}
      />,
    )
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

describe("isUiCardData gate", () => {
  it("accepts objects whose kind is a known card kind", () => {
    expect(isUiCardData({ kind: "table" })).toBe(true)
    expect(isUiCardData({ kind: "form", fields: [] })).toBe(true)
    expect(isUiCardData({ kind: "stat", label: "q", value: "1" })).toBe(true)
  })
  it("rejects non-objects, arrays and unknown kinds", () => {
    expect(isUiCardData(undefined)).toBe(false)
    expect(isUiCardData("table")).toBe(false)
    expect(isUiCardData({ childSessionId: "ses_1" })).toBe(false)
    expect(isUiCardData({ kind: "widget" })).toBe(false)
    expect(isUiCardData([{ kind: "table" }])).toBe(false)
  })
})

describe("display kinds", () => {
  it("table renders header + rows", () => {
    const { container, unmount } = mount({
      kind: "table",
      title: "方案对比",
      columns: [{ key: "plan", label: "方案" }, { key: "cost", label: "成本" }],
      rows: [{ plan: "A", cost: "低" }, { plan: "B", cost: "中" }],
    })
    expect(container.querySelectorAll("thead th")).toHaveLength(2)
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(container.querySelector(".ui-card-title")?.textContent).toBe("方案对比")
    unmount()
  })

  it("chart bars scale to the max value", () => {
    const { container, unmount } = mount({
      kind: "chart", unit: "条",
      items: [{ label: "core", value: 838 }, { label: "web", value: 419 }],
    })
    const fills = container.querySelectorAll<HTMLElement>(".ui-bar-fill")
    expect(fills).toHaveLength(2)
    expect(fills[0].style.width).toBe("100%")
    expect(container.querySelectorAll(".ui-bar-row")[1].textContent).toContain("419 条")
    unmount()
  })

  it("line charts render points as repeatable questions", () => {
    const onAction = vi.fn()
    const { container, unmount } = mount(
      {
        kind: "chart", chartType: "line", title: "耗时趋势", unit: "ms",
        items: [{ label: "周一", value: 120 }, { label: "周二", value: 80 }, { label: "周三", value: 200 }],
      },
      { onAction },
    )
    expect(container.querySelector('[data-testid="ui-line-chart"]')).not.toBeNull()
    expect(container.querySelector("polyline")).not.toBeNull()
    const points = container.querySelectorAll<HTMLButtonElement>('[data-testid="ui-line-point"]')
    expect(points).toHaveLength(3)
    unmount()
    // 默认 chartType 仍是 bar：同一数据不写 chartType 时不出现折线。
    const { container: barBox, unmount: unBar } = mount({
      kind: "chart", unit: "ms",
      items: [{ label: "周一", value: 120 }, { label: "周二", value: 80 }],
    })
    expect(barBox.querySelector('[data-testid="ui-line-chart"]')).toBeNull()
    expect(barBox.querySelectorAll(".ui-bar-row")).toHaveLength(2)
    unBar()

    // 点位是提问语义：可重复点击、永不置灰。
    const { container: clickBox, unmount: unClick } = mount(
      {
        kind: "chart", chartType: "line", title: "耗时趋势",
        items: [{ label: "周三", value: 200 }],
      },
      { onAction },
    )
    // 单点序列画短平线（polyline 单点不渲染线段）。
    expect(clickBox.querySelector("svg line.ui-line-path")).not.toBeNull()
    expect(clickBox.querySelector("polyline")).toBeNull()
    const point = clickBox.querySelector<HTMLButtonElement>('[data-testid="ui-line-point"]')!
    act(() => point.click())
    act(() => point.click())
    expect(point.disabled).toBe(false)
    expect(onAction).toHaveBeenCalledTimes(2)
    expect(onAction).toHaveBeenLastCalledWith({ optionId: "周三", text: "[UI 卡] 耗时趋势：询问 周三 这个点的详情" })
    unClick()
  })

  it("stat renders label/value/unit with sign-driven delta color", () => {
    const { container, unmount } = mount(
      { kind: "stat", label: "测试通过率", value: "98.2", unit: "%", delta: "+1.4pp" },
    )
    expect(container.querySelector('[data-testid="ui-stat"]')?.textContent).toContain("98.2 %")
    expect(container.querySelector(".ui-stat-delta")?.textContent).toBe("+1.4pp")
    expect(container.querySelector(".ui-stat-delta")?.className).toContain("ui-stat-up")
    unmount()
    const { container: downBox, unmount: unDown } = mount(
      { kind: "stat", label: "构建耗时", value: "42", unit: "s", delta: "-3s" },
    )
    expect(downBox.querySelector(".ui-stat-delta")?.className).toContain("ui-stat-down")
    unDown()
  })

  it("timeline, tree, quote, icon, list, tag, badge, link render their shapes", () => {
    const cases: [string, UICard, string][] = [
      ["ui-timeline", { kind: "timeline", items: [{ time: "09:00", title: "开工", tone: "ok" }] }, "开工"],
      ["ui-tree", { kind: "tree", root: { label: "src", children: [{ label: "core" }] } }, "core"],
      ["ui-quote", { kind: "quote", text: "引文", source: "出处" }, "— 出处"],
      ["ui-icon", { kind: "icon", value: "🚀" }, "🚀"],
      ["ui-list", { kind: "list", ordered: true, items: ["a", "b"] }, "a"],
      ["ui-tag", { kind: "tag", text: "标签", tone: "warn" }, "标签"],
      ["ui-badge", { kind: "badge", text: "ok", tone: "ok" }, "ok"],
    ]
    for (const [testid, card, text] of cases) {
      const { container, unmount } = mount(card)
      expect(container.querySelector(`[data-testid="${testid}"]`), testid).not.toBeNull()
      expect(container.querySelector(`[data-testid="${testid}"]`)?.textContent).toContain(text)
      unmount()
    }
    const { container: linkBox, unmount: unLink } = mount({ kind: "link", text: "规范", url: "https://example.com/a" })
    const a = linkBox.querySelector("a[data-testid='ui-link']")
    expect(a?.getAttribute("href")).toBe("https://example.com/a")
    expect(a?.getAttribute("target")).toBe("_blank")
    unLink()
  })

  it("containers nest display children one level deep", () => {
    const { container, unmount } = mount({
      kind: "card", title: "外层",
      body: [{ kind: "quote", text: "内文" }, { kind: "tag", text: "标签" }],
    })
    expect(container.querySelectorAll(".ui-quote, .ui-chip")).toHaveLength(2)
    unmount()
  })

  it("tabs switch panes locally", () => {
    const { container, unmount } = mount({
      kind: "tabs",
      tabs: [
        { label: "一", content: [{ kind: "quote", text: "第一页" }] },
        { label: "二", content: [{ kind: "quote", text: "第二页" }] },
      ],
    })
    expect(container.querySelector(".ui-tab-body")?.textContent).toContain("第一页")
    act(() => {
      ;(container.querySelectorAll(".ui-tab")[1] as HTMLButtonElement).click()
    })
    expect(container.querySelector(".ui-tab-body")?.textContent).toContain("第二页")
    unmount()
  })

  it("unknown runtime kind renders nothing (caller keeps the JSON fallback)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { container, unmount } = mount({ kind: "widget" } as unknown as UICard)
    expect(container.innerHTML).toBe("")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    unmount()
  })
})

describe("button card", () => {
  it("clicks report the label through onAction with the unified prefix", () => {
    const onAction = vi.fn()
    const { container, unmount } = mount({ kind: "button", label: "先做 core" }, { onAction })
    act(() => {
      ;(container.querySelector("button") as HTMLButtonElement).click()
    })
    expect(onAction).toHaveBeenCalledWith({ optionId: "先做 core", text: "[UI 卡] 选择 先做 core", decision: true })
    unmount()
  })

  it("the nearest container title rides the action text", () => {
    const onAction = vi.fn()
    const { container, unmount } = mount(
      {
        kind: "card", title: "发布方案",
        body: [{ kind: "button", label: "批准" }],
      },
      { onAction },
    )
    act(() => {
      ;(container.querySelector(".ui-card button") as HTMLButtonElement).click()
    })
    expect(onAction).toHaveBeenCalledWith({ optionId: "批准", text: "[UI 卡] 发布方案：选择 批准", decision: true })
    unmount()
  })

  it("a picked button renders disabled with the settled mark", () => {
    const onAction = vi.fn()
    const { container, unmount } = mount(
      { kind: "button", label: "先做 core" },
      { onAction, picked: { optionId: "先做 core" } },
    )
    const btn = container.querySelector("button") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.querySelector(".ui-picked-mark")?.textContent).toBe("已选择")
    act(() => btn.click())
    expect(onAction).not.toHaveBeenCalled()
    unmount()
  })
})
