import { describe, it, expect } from "vitest"
import { createUiRenderTool, UI_RENDER_DESCRIPTION } from "../../src/tools/ui-render.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { UICard } from "../../src/protocol/ui-cards.js"

const tool: { execute: ToolExecutor["execute"] } = createUiRenderTool()
const call = (args: unknown) => tool.execute(args, { onOutput: () => {} })

/** The one quantity the receipt surfaces per kind (table rows / form fields / …). */
const card = (partial: Record<string, unknown>): Record<string, unknown> => partial

describe("ui_render tool", () => {
  it("renders every display kind standalone", async () => {
    const samples: Record<string, unknown>[] = [
      card({ kind: "button", label: "先做 core" }),
      card({ kind: "link", text: "规范", url: "https://example.com/a" }),
      card({ kind: "table", title: "方案对比", columns: [{ key: "plan", label: "方案" }, { key: "cost", label: "成本" }], rows: [{ plan: "A", cost: "低" }, { plan: "B", cost: "中" }] }),
      card({ kind: "list", items: ["a", "b"] }),
      card({ kind: "tag", text: "标签", tone: "warn" }),
      card({ kind: "badge", text: "ok", tone: "ok" }),
      card({ kind: "timeline", items: [{ time: "09:00", title: "开工", tone: "ok" }, { title: "评审" }] }),
      card({ kind: "tree", root: { label: "src", children: [{ label: "core", children: [{ label: "tools" }] }] } }),
      card({ kind: "quote", text: "引文", source: "出处" }),
      card({ kind: "icon", value: "🚀" }),
      card({ kind: "chart", unit: "条", items: [{ label: "core", value: 838 }] }),
      card({ kind: "form", title: "发布参数", fields: [
        { kind: "input", name: "version", label: "版本号", placeholder: "0.7.0" },
        { kind: "textarea", name: "notes", label: "备注", rows: 4 },
        { kind: "radio", name: "channel", label: "渠道", options: [{ value: "npm", label: "npm" }] },
        { kind: "checkbox", name: "opts", label: "多选", options: [{ value: "a", label: "A" }] },
        { kind: "segmented", name: "mode", label: "模式", options: [{ value: "fast", label: "快" }] },
        { kind: "slider", name: "timeout", label: "超时(秒)", min: 1, max: 600, step: 1 },
        { kind: "date", name: "day", label: "日期" },
        { kind: "time", name: "at", label: "时间" },
      ] }),
    ]
    for (const sample of samples) {
      const r = await call({ card: sample })
      expect(r.status, `${sample.kind} should render`).toBe("ok")
      expect(r.data, `${sample.kind} should carry the card`).toEqual(sample)
      expect(r.output).toContain("已渲染")
    }
  })

  it("renders containers one level deep with display children", async () => {
    const containers: Record<string, unknown>[] = [
      card({ kind: "card", title: "外层", body: [{ kind: "quote", text: "内文" }, { kind: "tag", text: "标签" }] }),
      card({ kind: "tabs", tabs: [{ label: "一", content: [{ kind: "quote", text: "x" }] }, { label: "二", content: [{ kind: "form", fields: [{ kind: "input", name: "a", label: "A" }] }] }] }),
      card({ kind: "collapse", title: "折叠", children: [{ kind: "list", items: ["a"] }] }),
      card({ kind: "drawer", title: "详情", children: [{ kind: "badge", text: "b" }] }),
      card({ kind: "carousel", slides: [[{ kind: "quote", text: "一" }], [{ kind: "quote", text: "二" }]] }),
    ]
    for (const sample of containers) {
      const r = await call({ card: sample })
      expect(r.status, `${sample.kind} should render`).toBe("ok")
    }
  })

  it("receipt names the kind, title and count", async () => {
    const r = await call({ card: card({ kind: "table", title: "方案对比", columns: [{ key: "a", label: "A" }], rows: [{ a: "1" }, { a: "2" }, { a: "3" }] }) })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("表格")
    expect(r.output).toContain("《方案对比》")
    expect(r.output).toContain("3 行")
  })

  it("rejects malformed cards with a field-path message", async () => {
    const bad: [string, unknown, string][] = [
      ["unknown kind", { kind: "widget" }, "不是合法的组件类型"],
      ["bare form field", { kind: "input", name: "x", label: "X" }, "只允许出现在 form.fields"],
      ["container in container", { kind: "card", body: [{ kind: "tabs", tabs: [{ label: "t", content: [{ kind: "quote", text: "x" }] }] }] }, "容器内不可再嵌容器"],
      ["table missing rows", { kind: "table", columns: [{ key: "a", label: "A" }] }, "rows"],
      ["bad tone", { kind: "badge", text: "s", tone: "purple" }, "tone"],
      ["non-http url", { kind: "link", text: "x", url: "javascript:alert(1)" }, "http/https"],
      ["non-emoji icon", { kind: "icon", value: "abc" }, "emoji"],
      ["slider min>=max", { kind: "form", fields: [{ kind: "slider", name: "s", label: "S", min: 10, max: 1 }] }, "必须小于 max"],
      ["form field bad kind", { kind: "form", fields: [{ kind: "quote", name: "q", label: "Q" }] }, "不是合法的表单字段类型"],
      ["chart non-bar", { kind: "chart", chartType: "pie", items: [{ label: "a", value: 1 }] }, "只支持"],
      ["chart bad value", { kind: "chart", items: [{ label: "a", value: "很多" }] }, "必须是数字"],
      ["empty button label", { kind: "button", label: "  " }, "非空"],
    ]
    for (const [name, cardArg, expectMsg] of bad) {
      const r = await call({ card: cardArg })
      expect(r.status, `${name} should be rejected`).toBe("error")
      expect(r.output, name).toContain(expectMsg)
      expect(r.output).toContain("改用 Markdown")
    }
  })

  it("enforces quantity caps", async () => {
    const overRows = await call({ card: card({ kind: "table", columns: [{ key: "a", label: "A" }], rows: Array.from({ length: 51 }, () => ({ a: "x" })) }) })
    expect(overRows.status).toBe("error")
    expect(overRows.output).toContain("50 项上限")

    const overCols = await call({ card: card({ kind: "table", columns: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })), rows: [{ k0: "x" }] }) })
    expect(overCols.status).toBe("error")

    const overTree = await call({ card: card({ kind: "tree", root: Object.fromEntries([["label", "root"], ["children", (() => {
      const leaf = { label: "l" }
      // 201 chain nodes: deep enough to blow the node budget, cheap to build.
      let node: Record<string, unknown> = leaf
      for (let i = 0; i < 200; i++) node = { label: `n${i}`, children: [node] }
      return [node]
    })()]]) }) })
    expect(overTree.status).toBe("error")
    expect(overTree.output).toContain("200")

    // Every cell inside its own cap, yet the serialized total blows 32KB —
    // 50 rows × 8 cols × 500 chars ≈ 200k chars.
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`)
    const overBytes = await call({ card: card({
      kind: "table",
      columns: keys.map((k, i) => ({ key: k, label: `L${i}` })),
      rows: Array.from({ length: 50 }, () => Object.fromEntries(keys.map((k) => [k, "x".repeat(500)]))),
    }) })
    expect(overBytes.status).toBe("error")
    expect(overBytes.output).toContain("字节")
  })

  it("error results never carry data; ok results carry the validated card", async () => {
    const bad = await call({ card: { kind: "widget" } })
    expect(bad.data).toBeUndefined()
    const good = await call({ card: card({ kind: "quote", text: "t" }) })
    expect((good.data as UICard).kind).toBe("quote")
  })

  it("description leads with the capability line for the tool directory", () => {
    const firstSentence = UI_RENDER_DESCRIPTION.split("。")[0]
    expect(firstSentence.length).toBeLessThanOrEqual(120)
    expect(firstSentence).toContain("交互式 UI 卡")
  })

  it("absent card arg reports args.card", async () => {
    const r = await call({})
    expect(r.status).toBe("error")
    expect(r.output).toContain("args.card")
  })
})
