/**
 * MemoryView — 记忆管理页测试。照 jobsView.test.tsx 的 fake-api
 * 模式：ApiClient 的 get/post/patch/del/upload 全是 vi.fn，真实 ApiClient 的
 * get 是泛型 get<T>(path)（api.ts），fake 直接返回裸数据即可（组件用
 * api.get<...> 解包）。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { MemoryView } from "../../src/memory/MemoryView.js"
import type { MemoryWrittenInfo } from "../../src/chat/model.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeApi(over: Record<string, unknown> = {}): ApiClient & {
  get: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/memory/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", threads: 2, lastActivity: "2026-08-28" }]
      if (path === "/memory/projects/kclaw-a3f2c9") return { id: "kclaw-a3f2c9", threads: [{ topic: "ws-reconnect", title: "重连排查", status: "active", updated: "2026-08-28" }] }
      if (path === "/memory/threads/kclaw-a3f2c9/ws-reconnect") return { content: "---\ntopic: ws-reconnect\n---\n\n正文" }
      if (path === "/memory/global") return [{ kind: "persona", name: "persona", path: "persona.md", scope: "global", updated: "2026-08-28" }]
      if (path === "/memory/global/persona/persona") return { content: "画像正文" }
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => { throw new Error("unused") }),
    ...over,
  } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(
  api: ApiClient,
  notice?: (text: string) => void,
  openTarget?: MemoryWrittenInfo | null,
  onOpenConsumed?: () => void,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryView
        api={api}
        notice={notice ?? (() => {})}
        openTarget={openTarget}
        onOpenConsumed={onOpenConsumed}
      />,
    )
  })
  await flush() // 初始两个 GET（projects + global）落定
  return { container, root }
}

/** 找到文本包含 `text` 的第一个按钮（list 项按钮按 label 渲染）。 */
function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = ([...container.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => b.textContent?.includes(text))
  if (btn === undefined) throw new Error(`no button containing ${text}`)
  return btn
}

function setTextArea(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("MemoryView", () => {
  it("renders the three sections and navigates project → thread → editor", async () => {
    const api = fakeApi()
    const { container, root } = await mount(api)
    try {
      expect(api.get).toHaveBeenCalledWith("/memory/projects")
      expect(api.get).toHaveBeenCalledWith("/memory/global")
      // 区块 1：项目线列表
      expect(container.querySelector('[data-testid="memory-projects"]')!.textContent).toContain("kclaw-a3f2c9")
      // 区块 3：全局认知列表
      expect(container.querySelector('[data-testid="memory-cognitions"]')!.textContent).toContain("persona/persona")
      // 选项目 → 线清单
      await act(async () => {
        buttonByText(container, "kclaw-a3f2c9").click()
      })
      await flush()
      expect(container.querySelector('[data-testid="memory-threads"]')!.textContent).toContain("重连排查")
      // 点开线 → 编辑器载入整文件内容
      await act(async () => {
        buttonByText(container, "重连排查").click()
      })
      await flush()
      const editor = container.querySelector('[data-testid="memory-editor"]') as HTMLTextAreaElement
      expect(editor.value).toContain("topic: ws-reconnect")
      expect(editor.value).toContain("正文")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("saves an edited thread via PATCH and shows a notice", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container, root } = await mount(api, (t) => { notices.push(t) })
    try {
      await act(async () => {
        buttonByText(container, "kclaw-a3f2c9").click()
      })
      await flush()
      await act(async () => {
        buttonByText(container, "重连排查").click()
      })
      await flush()
      const editor = container.querySelector('[data-testid="memory-editor"]') as HTMLTextAreaElement
      setTextArea(editor, "改后的内容")
      await act(async () => {
        ;(container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(api.patch).toHaveBeenCalledWith("/memory/threads/kclaw-a3f2c9/ws-reconnect", { content: "改后的内容" })
      expect(notices).toContain("已保存")
      // Minor 3：保存后显式刷新所属项目线程列表（updated 时间戳跟上）
      expect(api.get.mock.calls.filter((c) => c[0] === "/memory/projects/kclaw-a3f2c9")).toHaveLength(2)
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("edits and deletes a global cognition file via PATCH/DELETE", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container, root } = await mount(api, (t) => { notices.push(t) })
    try {
      await act(async () => {
        buttonByText(container, "persona/persona").click()
      })
      await flush()
      const editor = container.querySelector('[data-testid="memory-editor"]') as HTMLTextAreaElement
      expect(editor.value).toContain("画像正文")
      setTextArea(editor, "改后的画像")
      await act(async () => {
        ;(container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(api.patch).toHaveBeenCalledWith("/memory/global/persona/persona", { content: "改后的画像" })
      // 删除：编辑器清空回默认占位
      await act(async () => {
        ;(container.querySelector('[data-testid="memory-delete"]') as HTMLButtonElement).click()
      })
      await flush()
      expect(api.del).toHaveBeenCalledWith("/memory/global/persona/persona")
      expect(notices).toContain("已删除")
      expect(container.querySelector('[data-testid="memory-editor"]')).toBeNull()
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("does not re-fetch the lists when the notice callback identity changes", async () => {
    // 回归（审查 Important）：App 传的是内联箭头，父重渲染每次新建 notice
    // identity。reloadProjects 的 effect 不得跟着 notice 变——否则停在记忆
    // tab 时每个父重渲染都重复拉 projects + global。
    const api = fakeApi()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<MemoryView api={api} notice={() => {}} />)
      })
      await flush()
      expect(api.get).toHaveBeenCalledTimes(2) // projects + global 各一次
      // 父重渲染 → 新 identity 的 notice → 组件重渲染，但不许再拉取
      await act(async () => {
        root.render(<MemoryView api={api} notice={() => {}} />)
      })
      await flush()
      expect(api.get.mock.calls.filter((c) => c[0] === "/memory/projects")).toHaveLength(1)
      expect(api.get.mock.calls.filter((c) => c[0] === "/memory/global")).toHaveLength(1)
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("shows a notice when loading threads fails and renders the empty states", async () => {
    const notices: string[] = []
    const api = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/memory/projects") return [{ id: "kclaw-a3f2c9", workdir: "/w/kclaw", threads: 2, lastActivity: "2026-08-28" }]
        if (path === "/memory/projects/kclaw-a3f2c9") throw new Error("memory unavailable")
        if (path === "/memory/global") return []
        throw new Error(`unexpected ${path}`)
      }),
    })
    const { container, root } = await mount(api, (t) => { notices.push(t) })
    try {
      // 全局认知为空 → 空态文案（而不是空 <ul>）
      expect(container.querySelector('[data-testid="memory-cognitions"]')).toBeNull()
      expect(container.textContent).toContain("还没有全局认知")
      // 线程加载失败 → notice + 空态文案（而不是静默）
      await act(async () => {
        buttonByText(container, "kclaw-a3f2c9").click()
      })
      await flush()
      expect(notices.some((n) => n.includes("加载线程失败"))).toBe(true)
      expect(container.textContent).toContain("该主题无线程")
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("openTarget: opens an episode thread from scope+topic and consumes the target", async () => {
    const api = fakeApi()
    const consumed = vi.fn()
    const { container, root } = await mount(
      api, () => {},
      { kind: "episode", path: "/m/projects/kclaw-a3f2c9/ws-reconnect.md", topic: "ws-reconnect", scope: "project:kclaw-a3f2c9" },
      consumed,
    )
    try {
      await flush()
      expect(api.get).toHaveBeenCalledWith("/memory/threads/kclaw-a3f2c9/ws-reconnect")
      const editor = container.querySelector('[data-testid="memory-editor"]') as HTMLTextAreaElement
      expect(editor.value).toContain("topic: ws-reconnect")
      expect(consumed).toHaveBeenCalled()
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("openTarget: opens a cognition file parsed from its path and consumes the target", async () => {
    const api = fakeApi()
    const consumed = vi.fn()
    const { container, root } = await mount(
      api, () => {},
      { kind: "cognition", path: "/m/global/persona/persona.md" },
      consumed,
    )
    try {
      await flush()
      expect(api.get).toHaveBeenCalledWith("/memory/global/persona/persona")
      const editor = container.querySelector('[data-testid="memory-editor"]') as HTMLTextAreaElement
      expect(editor.value).toContain("画像正文")
      expect(consumed).toHaveBeenCalled()
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
