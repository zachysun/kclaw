/**
 * MemoryView — 记忆管理页（spec 9.3）测试。照 jobsView.test.tsx 的 fake-api
 * 模式：ApiClient 的 get/post/patch/del/upload 全是 vi.fn，真实 ApiClient 的
 * get 是泛型 get<T>(path)（api.ts），fake 直接返回裸数据即可（组件用
 * api.get<...> 解包）。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { MemoryView } from "../../src/memory/MemoryView.js"

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
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<MemoryView api={api} notice={notice ?? (() => {})} />)
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
})
