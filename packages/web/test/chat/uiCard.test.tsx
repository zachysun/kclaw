/**
 * UiCardView render tests — every display kind produces its DOM shape, the
 * unknown-kind fallback renders nothing (the caller keeps the JSON row), and
 * the interactive cards (button / form) report through onAction with the
 * picked/snapshot contract. Pure view tests: no reducer, no ws.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { UiCardView, isUiCard } from "../../src/chat/UiCard.js"
import type { UICard } from "@kclaw/core/protocol"

function mount(card: UICard, props: { onAction?: (a: unknown) => void; picked?: unknown } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <UiCardView
        card={card}
        onAction={props.onAction as never}
        picked={props.picked as never}
      />,
    )
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

describe("isUiCard gate", () => {
  it("accepts objects whose kind is a known card kind", () => {
    expect(isUiCard({ kind: "table" })).toBe(true)
    expect(isUiCard({ kind: "form", fields: [] })).toBe(true)
  })
  it("rejects non-objects, arrays and unknown kinds", () => {
    expect(isUiCard(undefined)).toBe(false)
    expect(isUiCard("table")).toBe(false)
    expect(isUiCard({ childSessionId: "ses_1" })).toBe(false)
    expect(isUiCard({ kind: "widget" })).toBe(false)
    expect(isUiCard([{ kind: "table" }])).toBe(false)
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
  it("clicks report the label through onAction", () => {
    const onAction = vi.fn()
    const { container, unmount } = mount({ kind: "button", label: "先做 core" }, { onAction })
    act(() => {
      ;(container.querySelector("button") as HTMLButtonElement).click()
    })
    expect(onAction).toHaveBeenCalledWith({ optionId: "先做 core", text: "选择：先做 core" })
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
