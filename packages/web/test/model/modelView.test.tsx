/**
 * ModelView — provider 管理页测试。照 mcpView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回快照。覆盖：条目卡片渲染、预设/自定义
 * 建条目、拉取模型列表、编辑（留空 key 保存量）、验证、设默认、删除引用
 * 会话提示（两步确认）与无引用直删、空态。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { ModelView } from "../../src/model/ModelView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT = {
  default: "ds",
  entries: {
    ds: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "***-key", model: "deepseek-chat" },
    claude: { format: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "***", model: "claude-sonnet-4", contextWindow: 200000 },
  },
  presets: [
    { id: "openai", label: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1" },
    { id: "anthropic", label: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "deepseek", label: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
    { id: "ollama", label: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1", authOptional: true },
  ],
}

const MODELS = ["deepseek-chat", "deepseek-reasoner"]

type FakeApi = ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> }

function fakeApi(over: { sessions?: Array<{ model?: string }>; post?: ReturnType<typeof vi.fn> } = {}): FakeApi {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/providers") return SNAPSHOT
      if (path === "/sessions") return over.sessions ?? []
      throw new Error(`unexpected ${path}`)
    }),
    post: over.post ?? vi.fn(async (path: string) => {
      if (path === "/providers/models") return { ok: true, models: MODELS }
      return { ok: true }
    }),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => {
      throw new Error("unused")
    }),
  } as unknown as FakeApi
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(api: ApiClient, notice: (text: string) => void = (): void => {}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ModelView api={api} notice={notice} />)
  })
  await flush()
  return { container, root }
}

function q(container: HTMLElement, testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`)
  if (el === null) throw new Error(`missing ${testid}`)
  return el as HTMLElement
}

const INPUT_SETTER = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
const SELECT_SETTER = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!

function typeValue(el: HTMLInputElement, value: string): void {
  act(() => {
    INPUT_SETTER.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function selectValue(el: HTMLSelectElement, value: string): void {
  act(() => {
    SELECT_SETTER.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("ModelView", () => {
  it("renders entries with default badge, format label, endpoint and model id", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/providers")
    expect(q(container, "model-entry-ds").textContent).toContain("https://api.deepseek.com/v1")
    expect(q(container, "model-entry-ds").textContent).toContain("deepseek-chat")
    expect(q(container, "model-default-ds").textContent).toBe("默认")
    expect(container.querySelector('[data-testid="model-default-claude"]')).toBeNull()
    expect(q(container, "model-entry-claude").textContent).toContain("Anthropic 格式")
    expect(q(container, "model-entry-claude").textContent).toContain("窗口 200000")
  })

  it("creates an entry from a preset: prewritten url, key only, fetched model list", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await act(async () => {
      q(container, "model-add").click()
    })
    // 预设模式（默认档）：选 DeepSeek → 名称与地址自动带出
    selectValue(q(container, "model-form-preset") as HTMLSelectElement, "deepseek")
    expect((q(container, "model-form-name") as HTMLInputElement).value).toBe("deepseek")
    expect((q(container, "model-form-url") as HTMLInputElement).value).toBe("https://api.deepseek.com/v1")
    expect((q(container, "model-form-url") as HTMLInputElement).readOnly).toBe(true)
    typeValue(q(container, "model-form-key") as HTMLInputElement, "sk-new")
    // 拉取模型列表 → 变成下拉
    await act(async () => {
      q(container, "model-form-fetch").click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/providers/models", { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-new" })
    const select = q(container, "model-form-model-select") as HTMLSelectElement
    expect(select.options.length).toBe(2)
    selectValue(select, "deepseek-reasoner")
    await act(async () => {
      q(container, "model-form-submit").click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/providers", {
      name: "deepseek",
      entry: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-new", model: "deepseek-reasoner" },
    })
  })

  it("creates a custom entry with a hand-typed model id", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await act(async () => {
      q(container, "model-add").click()
    })
    await act(async () => {
      q(container, "model-form-mode-custom").click()
    })
    selectValue(q(container, "model-form-format") as HTMLSelectElement, "anthropic")
    typeValue(q(container, "model-form-name") as HTMLInputElement, "proxy")
    typeValue(q(container, "model-form-url") as HTMLInputElement, "https://proxy.test/v1")
    typeValue(q(container, "model-form-model") as HTMLInputElement, "claude-x")
    await act(async () => {
      q(container, "model-form-submit").click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/providers", {
      name: "proxy",
      entry: { format: "anthropic", baseUrl: "https://proxy.test/v1", apiKey: "", model: "claude-x" },
    })
  })

  it("edits an entry: name frozen, blank key stays blank in the payload, fetch rides the stored key", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await act(async () => {
      q(container, "model-edit-ds").click()
    })
    expect((q(container, "model-form-name") as HTMLInputElement).disabled).toBe(true)
    expect((q(container, "model-form-key") as HTMLInputElement).placeholder).toContain("留空保持不变")
    await act(async () => {
      q(container, "model-form-fetch").click()
    })
    await flush()
    // 编辑态：按名字探测（存量密钥），地址/格式用表单当前值覆盖
    expect(api.post).toHaveBeenCalledWith("/providers/models", { name: "ds", format: "openai", baseUrl: "https://api.deepseek.com/v1" })
    // 拉到列表后模型字段变下拉，选一个再保存
    selectValue(q(container, "model-form-model-select") as HTMLSelectElement, "deepseek-reasoner")
    await act(async () => {
      q(container, "model-form-submit").click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/providers/ds", {
      entry: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-reasoner" },
    })
  })

  it("verify posts the name probe and reports success via the notice", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container } = await mount(api, (t) => notices.push(t))
    await act(async () => {
      q(container, "model-verify-ds").click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/providers/models", { name: "ds" })
    expect(notices.some((n) => n.includes("验证成功") && n.includes("2 个模型可用"))).toBe(true)
  })

  it("deletes unreferenced entries directly and warns (two-step) when sessions reference them", async () => {
    const api = fakeApi({ sessions: [{ model: "claude" }, { model: "claude" }, {}] })
    const { container } = await mount(api)
    // ds 无引用：直删
    await act(async () => {
      q(container, "model-delete-ds").click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith("/providers/ds")
    // claude 有 2 个引用：先提示，确认后才删
    expect(api.del).not.toHaveBeenCalledWith("/providers/claude")
    await act(async () => {
      q(container, "model-delete-claude").click()
    })
    await flush()
    expect(q(container, "model-warning-claude").textContent).toContain("2 个会话正在使用")
    await act(async () => {
      q(container, "model-delete-confirm-claude").click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith("/providers/claude")
  })

  it("set-default posts the action", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await act(async () => {
      q(container, "model-setdefault-claude").click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/providers/claude/default")
  })

  it("shows the empty state without entries", async () => {
    const api = fakeApi()
    api.get = vi.fn(async (path: string) => (path === "/providers" ? { default: "", entries: {}, presets: SNAPSHOT.presets } : [])) as unknown as FakeApi["get"]
    const { container } = await mount(api)
    expect(q(container, "model-empty").textContent).toContain("还没有配置任何 provider 条目")
  })

  it("surfaces form submit failures inline", async () => {
    const api = fakeApi()
    api.post = vi.fn(async (path: string) => {
      if (path === "/providers") throw new Error("provider entry \"ds\" already exists")
      return { ok: true, models: MODELS }
    }) as unknown as FakeApi["post"]
    const { container } = await mount(api)
    await act(async () => {
      q(container, "model-add").click()
    })
    await act(async () => {
      q(container, "model-form-mode-custom").click()
    })
    typeValue(q(container, "model-form-name") as HTMLInputElement, "ds")
    typeValue(q(container, "model-form-url") as HTMLInputElement, "https://x/v1")
    typeValue(q(container, "model-form-model") as HTMLInputElement, "m")
    await act(async () => {
      q(container, "model-form-submit").click()
    })
    await flush()
    expect(q(container, "model-form-error").textContent).toContain("already exists")
  })
})
