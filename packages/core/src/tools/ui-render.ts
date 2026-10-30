// packages/core/src/tools/ui-render.ts
/**
 * ui_render: the model's UI expression surface. One call = one UI Card — a
 * validated, bounded component description that lands in the tool result's
 * `data` for the web to render. The card itself never re-enters model context
 * (assembly reads `output` only), so the result text is a short receipt: the
 * model learns what was rendered, not the payload it just wrote.
 *
 * The validator is the whole safety story: risk "safe" holds because a card
 * is inert display data — no file, process, or network reach — and the DSL
 * closes every injection door (text renders as React text nodes, links are
 * http/https only, form fields cannot exist outside a form). Malformed input
 * throws a field-path ToolError, so the model can fix and retry in one turn.
 * Errors cite paths like `card.fields[0].min` — the model-facing contract.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type {
  UIChartCard,
  UIDisplayCard,
  UIField,
  UIFormCard,
  UICard,
  UIOption,
  UITableCard,
  UITone,
  UITreeCard,
  UITreeNode,
} from "../protocol/ui-cards.js"
import { ToolError, def, type ToolEntry } from "./shared.js"

/** First sentence = the tool-directory line (directory tier); the rest rides
 * the tool_search card. The do/don't split mirrors the validator exactly. */
export const UI_RENDER_DESCRIPTION =
  "为用户产出交互式 UI 卡（表格/条形图/按钮/表单/时间轴/树/折叠面板等 25 种组件）。" +
  "仅在明显优于 Markdown 时调用：方案对比→table、数值对比→chart、用户点选→button、收集参数→form、步骤层级→timeline/tree；" +
  "普通解释、代码块、单条结论一律用正文，不要调用本工具。" +
  "一次调用产出一个组件；文本按纯文本渲染（不支持 HTML/Markdown 语法）。"

/** Serialization ceiling for one card (guards events.jsonl and the chat pane). */
const MAX_CARD_BYTES = 32 * 1024
const MAX_TEXT = 500
const MAX_TITLE = 100
const MAX_TABLE_ROWS = 50
const MAX_TABLE_COLS = 8
const MAX_ITEMS = 50
const MAX_TREE_NODES = 200
const MAX_SLIDES = 10
const MAX_OPTIONS = 8
const MAX_TABS = 10
const MAX_FIELDS = 20

const TONES: readonly UITone[] = ["default", "primary", "ok", "warn", "error"]
const FIELD_KINDS: ReadonlySet<string> = new Set([
  "input", "textarea", "radio", "checkbox", "segmented", "slider", "date", "time",
])
const CONTAINER_KINDS: ReadonlySet<string> = new Set(["card", "tabs", "collapse", "drawer", "carousel"])

/** Chinese label per kind for the model-facing receipt. */
const KIND_LABELS: Record<string, string> = {
  button: "按钮", link: "链接", table: "表格", list: "列表", card: "卡片", tag: "标签",
  badge: "徽标", tabs: "标签页", collapse: "折叠面板", timeline: "时间轴", tree: "树",
  carousel: "走马灯", quote: "引用", icon: "图标", chart: "图表", drawer: "抽屉", form: "表单",
}

// --- small path-carrying validators (error messages are model-facing) -------

function reqStr(o: Record<string, unknown>, key: string, path: string, cap = MAX_TEXT): string {
  const v = o[key]
  if (typeof v !== "string" || v.trim() === "") throw new ToolError(`${path}.${key}: 必须是非空字符串`)
  if (v.length > cap) throw new ToolError(`${path}.${key}: 超过 ${cap} 字上限（当前 ${v.length} 字）`)
  return v
}

function optStr(o: Record<string, unknown>, key: string, path: string, cap = MAX_TEXT): string | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== "string") throw new ToolError(`${path}.${key}: 必须是字符串`)
  if (v.length > cap) throw new ToolError(`${path}.${key}: 超过 ${cap} 字上限`)
  return v
}

function optBool(o: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== "boolean") throw new ToolError(`${path}.${key}: 必须是布尔值`)
  return v
}

function optTone(o: Record<string, unknown>, path: string): UITone | undefined {
  const v = o.tone
  if (v === undefined) return undefined
  if (typeof v !== "string" || !TONES.includes(v as UITone)) {
    throw new ToolError(`${path}.tone: 必须是 ${TONES.join("/")} 之一`)
  }
  return v as UITone
}

function optInt(o: Record<string, unknown>, key: string, path: string, min: number, max: number): number | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolError(`${path}.${key}: 必须是整数`)
  if (v < min || v > max) throw new ToolError(`${path}.${key}: 必须在 ${min}-${max} 之间`)
  return v
}

function reqArr(o: Record<string, unknown>, key: string, path: string, min: number, max: number): unknown[] {
  const v = o[key]
  if (!Array.isArray(v) || v.length < min) throw new ToolError(`${path}.${key}: 必须是至少 ${min} 个元素的数组`)
  if (v.length > max) throw new ToolError(`${path}.${key}: 超过 ${max} 项上限（当前 ${v.length} 项）`)
  return v
}

function reqObj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ToolError(`${path}: 必须是对象`)
  return v as Record<string, unknown>
}

function reqOptions(o: Record<string, unknown>, path: string): UIOption[] {
  return reqArr(o, "options", path, 1, MAX_OPTIONS).map((raw, i) => {
    const opt = reqObj(raw, `${path}.options[${i}]`)
    return {
      value: reqStr(opt, "value", `${path}.options[${i}]`, 200),
      label: reqStr(opt, "label", `${path}.options[${i}]`, MAX_TITLE),
    }
  })
}

// --- form-field kinds (legal only inside form.fields) ------------------------

function validateField(raw: unknown, path: string): UIField {
  const o = reqObj(raw, path)
  const kind = reqStr(o, "kind", path, 40)
  const name = reqStr(o, "name", path, 100)
  const label = reqStr(o, "label", path, MAX_TITLE)
  switch (kind) {
    case "input": {
      const inputType = optStr(o, "inputType", path, 20)
      if (inputType !== undefined && !["text", "number", "password"].includes(inputType)) {
        throw new ToolError(`${path}.inputType: 只允许 text/number/password`)
      }
      const placeholder = optStr(o, "placeholder", path, MAX_TITLE)
      return {
        kind, name, label,
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(inputType !== undefined ? { inputType: inputType as "text" | "number" | "password" } : {}),
      }
    }
    case "textarea": {
      const rows = optInt(o, "rows", path, 2, 20)
      return { kind, name, label, ...(rows !== undefined ? { rows } : {}) }
    }
    case "radio":
    case "checkbox":
    case "segmented":
      return { kind, name, label, options: reqOptions(o, path) }
    case "slider": {
      const min = optInt(o, "min", path, -1e9, 1e9)
      const max = optInt(o, "max", path, -1e9, 1e9)
      if (min === undefined || max === undefined) throw new ToolError(`${path}.min/max: 必填整数`)
      if (min >= max) throw new ToolError(`${path}.min: 必须小于 max`)
      const step = optInt(o, "step", path, 1, max - min)
      const unit = optStr(o, "unit", path, 20)
      return { kind, name, label, min, max, ...(step !== undefined ? { step } : {}), ...(unit !== undefined ? { unit } : {}) }
    }
    case "date":
    case "time":
      return { kind, name, label }
    default:
      throw new ToolError(`${path}.kind: "${kind}" 不是合法的表单字段类型（input/textarea/radio/checkbox/segmented/slider/date/time）`)
  }
}

// --- display + container kinds -----------------------------------------------

function validateDisplayChildren(o: Record<string, unknown>, key: string, path: string): UIDisplayCard[] {
  return reqArr(o, key, path, 1, MAX_ITEMS).map((raw, i) => {
    const child = validateCard(raw, `${path}[${i}]`, { insideContainer: true })
    return child as UIDisplayCard
  })
}

function validateTable(o: Record<string, unknown>, path: string): UITableCard {
  const columns = reqArr(o, "columns", path, 1, MAX_TABLE_COLS).map((raw, i) => {
    const col = reqObj(raw, `${path}.columns[${i}]`)
    return {
      key: reqStr(col, "key", `${path}.columns[${i}]`, 100),
      label: reqStr(col, "label", `${path}.columns[${i}]`, MAX_TITLE),
    }
  })
  const rows = reqArr(o, "rows", path, 1, MAX_TABLE_ROWS).map((raw, i) => {
    const row = reqObj(raw, `${path}.rows[${i}]`)
    const cells: Record<string, string> = {}
    for (const col of columns) {
      const cell = row[col.key]
      if (cell === undefined) continue
      if (typeof cell !== "string") throw new ToolError(`${path}.rows[${i}].${col.key}: 必须是字符串`)
      if (cell.length > MAX_TEXT) throw new ToolError(`${path}.rows[${i}].${col.key}: 超过 ${MAX_TEXT} 字上限`)
      cells[col.key] = cell
    }
    return cells
  })
  return { kind: "table", columns, rows, ...(o.title !== undefined ? { title: optStr(o, "title", path, MAX_TITLE) } : {}) }
}

function validateTree(o: Record<string, unknown>, path: string): UITreeCard {
  let nodes = 0
  const walk = (raw: unknown, p: string): UITreeNode => {
    nodes++
    if (nodes > MAX_TREE_NODES) throw new ToolError(`${p}: 节点总数超过 ${MAX_TREE_NODES} 上限`)
    const n = reqObj(raw, p)
    const node: UITreeNode = { label: reqStr(n, "label", p, MAX_TITLE) }
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) throw new ToolError(`${p}.children: 必须是数组`)
      node.children = n.children.map((c: unknown, i: number) => walk(c, `${p}.children[${i}]`))
    }
    return node
  }
  return { kind: "tree", root: walk(o.root, `${path}.root`), ...(o.title !== undefined ? { title: optStr(o, "title", path, MAX_TITLE) } : {}) }
}

function validateChart(o: Record<string, unknown>, path: string): UIChartCard {
  // Absent chartType stays absent in `data` (the payload mirrors what the
  // model wrote; the web treats undefined as "bar") — validation only.
  const chartType = optStr(o, "chartType", path, 20) ?? "bar"
  if (chartType !== "bar") throw new ToolError(`${path}.chartType: v1 只支持 "bar"`)
  const items = reqArr(o, "items", path, 1, MAX_ITEMS).map((raw, i) => {
    const item = reqObj(raw, `${path}.items[${i}]`)
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
      throw new ToolError(`${path}.items[${i}].value: 必须是数字`)
    }
    return { label: reqStr(item, "label", `${path}.items[${i}]`, MAX_TITLE), value: item.value }
  })
  const unit = optStr(o, "unit", path, 20)
  return {
    kind: "chart", items,
    ...(o.chartType !== undefined ? { chartType: "bar" as const } : {}),
    ...(o.title !== undefined ? { title: optStr(o, "title", path, MAX_TITLE) } : {}),
    ...(unit !== undefined ? { unit } : {}),
  }
}

function validateForm(o: Record<string, unknown>, path: string): UIFormCard {
  const fields = reqArr(o, "fields", path, 1, MAX_FIELDS).map((raw, i) => validateField(raw, `${path}.fields[${i}]`))
  const submitLabel = optStr(o, "submitLabel", path, MAX_TITLE)
  return {
    kind: "form", fields,
    ...(o.title !== undefined ? { title: optStr(o, "title", path, MAX_TITLE) } : {}),
    ...(submitLabel !== undefined ? { submitLabel } : {}),
  }
}

/** Validate one card node. `insideContainer` enforces the one-level nesting
 * rule (a container inside a container is the shape the spec bans); bare
 * form-field kinds at card level are rejected — they only live in form.fields. */
function validateCard(raw: unknown, path: string, opts: { insideContainer?: boolean } = {}): UICard {
  const o = reqObj(raw, path)
  const kind = reqStr(o, "kind", path, 40)
  if (FIELD_KINDS.has(kind)) {
    throw new ToolError(`${path}.kind: "${kind}" 是表单字段，只允许出现在 form.fields 内`)
  }
  if (opts.insideContainer === true && CONTAINER_KINDS.has(kind)) {
    throw new ToolError(`${path}.kind: "${kind}" 是容器，容器内不可再嵌容器（一层封顶）`)
  }
  const title = o.title !== undefined ? optStr(o, "title", path, MAX_TITLE) : undefined
  // Title-first spread: validated-card boundary, the assertion is the seam the
  // runtime checks above guarantee.
  const withTitle = (card: Record<string, unknown>): UICard =>
    ({ ...(title !== undefined ? { title } : {}), ...card }) as unknown as UICard

  switch (kind) {
    case "button": {
      const tone = optTone(o, path)
      return withTitle({ kind, label: reqStr(o, "label", path, MAX_TITLE), ...(tone !== undefined ? { tone } : {}) })
    }
    case "link": {
      const url = reqStr(o, "url", path, 2000)
      if (!/^https?:\/\//.test(url)) throw new ToolError(`${path}.url: 只允许 http/https 协议`)
      return withTitle({ kind, text: reqStr(o, "text", path, MAX_TITLE), url })
    }
    case "table":
      return validateTable(o, path)
    case "list": {
      const ordered = optBool(o, "ordered", path)
      const items = reqArr(o, "items", path, 1, MAX_ITEMS).map((s, i) => {
        if (typeof s !== "string" || s.trim() === "") throw new ToolError(`${path}.items[${i}]: 必须是非空字符串`)
        if (s.length > MAX_TEXT) throw new ToolError(`${path}.items[${i}]: 超过 ${MAX_TEXT} 字上限`)
        return s
      })
      return withTitle({ kind, items, ...(ordered !== undefined ? { ordered } : {}) })
    }
    case "tag":
    case "badge": {
      const tone = optTone(o, path)
      return withTitle({ kind, text: reqStr(o, "text", path, MAX_TITLE), ...(tone !== undefined ? { tone } : {}) })
    }
    case "tabs":
      return withTitle({
        kind,
        tabs: reqArr(o, "tabs", path, 1, MAX_TABS).map((raw, i) => {
          const tab = reqObj(raw, `${path}.tabs[${i}]`)
          return { label: reqStr(tab, "label", `${path}.tabs[${i}]`, MAX_TITLE), content: validateDisplayChildren(tab, "content", `${path}.tabs[${i}].content`) }
        }),
      })
    case "collapse":
    case "drawer": {
      const open = optBool(o, "open", path)
      return {
        kind,
        title: reqStr(o, "title", path, MAX_TITLE),
        children: validateDisplayChildren(o, "children", `${path}.children`),
        ...(kind === "collapse" && open !== undefined ? { open } : {}),
      } as UICard
    }
    case "card":
      return withTitle({ kind, body: validateDisplayChildren(o, "body", `${path}.body`) })
    case "carousel":
      return withTitle({
        kind,
        slides: reqArr(o, "slides", path, 1, MAX_SLIDES).map((raw, i) =>
          validateDisplayChildren({ children: raw }, "children", `${path}.slides[${i}]`),
        ),
      })
    case "timeline":
      return withTitle({
        kind,
        items: reqArr(o, "items", path, 1, MAX_ITEMS).map((raw, i) => {
          const item = reqObj(raw, `${path}.items[${i}]`)
          const time = optStr(item, "time", `${path}.items[${i}]`, 40)
          const text = optStr(item, "text", `${path}.items[${i}]`, MAX_TEXT)
          const tone = optTone(item, `${path}.items[${i}]`)
          return {
            title: reqStr(item, "title", `${path}.items[${i}]`, MAX_TITLE),
            ...(time !== undefined ? { time } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(tone !== undefined ? { tone } : {}),
          }
        }),
      })
    case "tree":
      return validateTree(o, path)
    case "quote": {
      const source = optStr(o, "source", path, MAX_TITLE)
      return withTitle({ kind, text: reqStr(o, "text", path, MAX_TEXT), ...(source !== undefined ? { source } : {}) })
    }
    case "icon": {
      const value = reqStr(o, "value", path, 16)
      if (!/\p{Extended_Pictographic}/u.test(value)) throw new ToolError(`${path}.value: 只允许 emoji`)
      return withTitle({ kind, value })
    }
    case "chart":
      return validateChart(o, path)
    case "form":
      return validateForm(o, path)
    default:
      throw new ToolError(`${path}.kind: "${kind}" 不是合法的组件类型（button/link/table/list/card/tag/badge/tabs/collapse/timeline/tree/carousel/quote/icon/chart/drawer/form）`)
  }
}

/** Receipt text: what was rendered, with the one quantity that matters per kind. */
function receiptFor(card: UICard): string {
  const label = KIND_LABELS[card.kind] ?? card.kind
  const titled = "title" in card && typeof card.title === "string" && card.title !== "" ? `《${card.title}》` : ""
  const count =
    card.kind === "table" ? `（${card.rows.length} 行）`
    : card.kind === "form" ? `（${card.fields.length} 个字段）`
    : card.kind === "chart" ? `（${card.items.length} 项）`
    : card.kind === "list" || card.kind === "timeline" ? `（${card.items.length} 项）`
    : ""
  return `已渲染${label}${titled}${count}。用户界面上已展示，正文无需复述全部内容。`
}

export function createUiRenderTool(): ToolExecutor & { name: "ui_render" } {
  return {
    name: "ui_render",
    risk: "safe",
    concurrency: "parallel",
    async execute(args) {
      let card: UICard
      try {
        const raw = (args as Record<string, unknown> | null)?.["card"]
        if (raw === undefined) throw new ToolError("args.card: 必填，组件描述对象")
        card = validateCard(raw, "card")
        // Real UTF-8 bytes: string .length counts UTF-16 code units, which
        // undercounts CJK content ~3x and would let an oversized card through.
        const bytes = Buffer.byteLength(JSON.stringify(card), "utf8")
        if (bytes > MAX_CARD_BYTES) throw new ToolError(`card: 序列化后 ${bytes} 字节，超过 ${MAX_CARD_BYTES} 字节上限`)
      } catch (e) {
        return {
          status: "error",
          output: `ui_render: ${e instanceof ToolError ? e.message : String(e)}。修正后重试；若反复失败，改用 Markdown 正文表达。`,
        }
      }
      return { status: "ok", output: receiptFor(card), data: card }
    },
  }
}

// --- provider-facing schema (oneOf over the 25 kinds) ------------------------

const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] })
const strF = (max: number, description = "纯文本") => ({ type: "string", maxLength: max, description })
const boolF = (description: string) => ({ type: "boolean", description })
const intF = (description: string) => ({ type: "integer", description })
const optionItem = {
  type: "object",
  properties: { value: strF(200, "回传标识"), label: strF(MAX_TITLE, "显示文本") },
  required: ["value", "label"],
  additionalProperties: false,
}
const optionsF = (description: string) => ({ type: "array", items: optionItem, minItems: 1, maxItems: MAX_OPTIONS, description })
const tableCol = {
  type: "object",
  properties: { key: strF(100, "列标识（rows 键名）"), label: strF(MAX_TITLE, "表头文本") },
  required: ["key", "label"],
  additionalProperties: false,
}
/** Two levels of tree shape inline; deeper levels ride the runtime validator
 * (JSON Schema $ref recursion has uneven provider support). */
const treeNode = (depth: number): Record<string, unknown> => ({
  type: "object",
  properties: {
    label: strF(MAX_TITLE),
    ...(depth < 2 ? { children: { type: "array", items: treeNode(depth + 1), description: "子节点，可继续嵌套（总节点≤200）" } } : {}),
  },
  required: ["label"],
  additionalProperties: false,
})
const fieldEntry = {
  type: "object",
  description: "表单字段：kind 取 input/textarea/radio/checkbox/segmented/slider/date/time；仅允许出现在 fields 内。radio/checkbox/segmented 需 options；slider 需 min/max（整数，min<max）",
  properties: {
    kind: enumOf([...FIELD_KINDS]),
    name: strF(100, "字段标识（回传时用）"),
    label: strF(MAX_TITLE, "字段显示名"),
    placeholder: strF(MAX_TITLE),
    inputType: enumOf(["text", "number", "password"]),
    rows: intF("textarea 行数 2-20"),
    options: optionsF("radio/checkbox/segmented 的选项"),
    min: intF("slider 下限"),
    max: intF("slider 上限"),
    step: intF("slider 步长"),
    unit: strF(20, "slider 单位"),
  },
  required: ["kind", "name", "label"],
  additionalProperties: false,
}

function branch(kind: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    description,
    properties: { kind: enumOf([kind]), ...properties },
    required: ["kind", ...required],
    additionalProperties: false,
  }
}

const UIDisplayKindList = [
  "button", "link", "table", "list", "tag", "badge", "timeline", "tree", "quote", "icon", "chart", "form",
] as const

const displayChildren = (description: string) => ({
  type: "array", minItems: 1, maxItems: MAX_ITEMS, description,
  items: { type: "object", description: "展示组件或表单（容器不可嵌套）；kind 判别，同顶层各分支", properties: { kind: enumOf([...UIDisplayKindList]) }, required: ["kind"] },
})

const BRANCHES = [
  branch("button", "按钮：点击后以用户消息形式回传 label", { label: strF(MAX_TITLE, "按钮文本（即回传内容）"), tone: enumOf(TONES) }, ["label"]),
  branch("link", "链接：新标签页打开外链", { text: strF(MAX_TITLE, "显示文本"), url: strF(2000, "http/https 地址") }, ["text", "url"]),
  branch("table", "表格：多方案对比、结构化罗列", { title: strF(MAX_TITLE), columns: { type: "array", items: tableCol, minItems: 1, maxItems: MAX_TABLE_COLS }, rows: { type: "array", minItems: 1, maxItems: MAX_TABLE_ROWS, items: { type: "object", additionalProperties: { type: "string", maxLength: MAX_TEXT } } } }, ["columns", "rows"]),
  branch("list", "列表：要点罗列", { title: strF(MAX_TITLE), ordered: boolF("有序列表"), items: { type: "array", items: strF(MAX_TEXT), minItems: 1, maxItems: MAX_ITEMS } }, ["items"]),
  branch("card", "卡片：容器，body 装展示组件", { title: strF(MAX_TITLE), body: displayChildren("子组件（不可含容器）") }, ["body"]),
  branch("tag", "标签：轻量分类标记", { text: strF(MAX_TITLE), tone: enumOf(TONES) }, ["text"]),
  branch("badge", "徽标：状态标记", { text: strF(MAX_TITLE), tone: enumOf(TONES) }, ["text"]),
  branch("tabs", "标签页：容器，分页展示", { title: strF(MAX_TITLE), tabs: { type: "array", minItems: 1, maxItems: MAX_TABS, items: { type: "object", properties: { label: strF(MAX_TITLE), content: displayChildren("该页子组件") }, required: ["label", "content"], additionalProperties: false } } }, ["tabs"]),
  branch("collapse", "折叠面板：容器，默认收起", { title: strF(MAX_TITLE, "折叠条标题（必填）"), open: boolF("默认展开"), children: displayChildren("收起内容") }, ["title", "children"]),
  branch("timeline", "时间轴：步骤/事件序列", { title: strF(MAX_TITLE), items: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: { type: "object", properties: { time: strF(40, "时间标记"), title: strF(MAX_TITLE), text: strF(MAX_TEXT), tone: enumOf(TONES) }, required: ["title"], additionalProperties: false } } }, ["items"]),
  branch("tree", "树：层级结构", { title: strF(MAX_TITLE), root: treeNode(0) }, ["root"]),
  branch("carousel", "走马灯：容器，分屏轮播", { title: strF(MAX_TITLE), slides: { type: "array", minItems: 1, maxItems: MAX_SLIDES, items: displayChildren("该屏子组件") } }, ["slides"]),
  branch("quote", "引用：醒目引文", { text: strF(MAX_TEXT), source: strF(MAX_TITLE, "出处") }, ["text"]),
  branch("icon", "图标：emoji 点缀", { value: strF(16, "emoji 字符") }, ["value"]),
  branch("chart", "图表：v1 仅条形图（数值对比）", { title: strF(MAX_TITLE), chartType: enumOf(["bar"]), unit: strF(20, "数值单位"), items: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: { type: "object", properties: { label: strF(MAX_TITLE), value: { type: "number" } }, required: ["label", "value"], additionalProperties: false } } }, ["items"]),
  branch("drawer", "抽屉：容器，默认收起只显触发条", { title: strF(MAX_TITLE, "触发条标题（必填）"), children: displayChildren("展开内容") }, ["title", "children"]),
  branch("form", "表单：收集参数，用户提交后整体回传", { title: strF(MAX_TITLE), fields: { type: "array", items: fieldEntry, minItems: 1, maxItems: MAX_FIELDS }, submitLabel: strF(MAX_TITLE, "提交按钮文本") }, ["fields"]),
]

/** The registry-facing bundle: executor + schema owned beside each other. */
export function createUiRenderToolEntries(): ToolEntry[] {
  return [
    {
      name: "ui_render",
      tool: createUiRenderTool(),
      def: def(
        "ui_render",
        UI_RENDER_DESCRIPTION,
        { card: { oneOf: BRANCHES, description: "组件描述（kind 判别 25 种，见各分支）" } },
        ["card"],
      ),
    },
  ]
}
