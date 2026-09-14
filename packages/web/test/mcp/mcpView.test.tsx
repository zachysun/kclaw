/**
 * McpView — MCP 服务器管理页测试。照 permissionsView.test.tsx 的 fake-api
 * 模式：vi.fn 的 ApiClient，get 按路径返回快照。覆盖：状态列表渲染、
 * 工具清单展开、手动刷新、空态、加载失败提示。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { McpView } from "../../src/mcp/McpView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT = {
  servers: [
    {
      name: "filesystem",
      config: { type: "stdio", command: "npx -y srv" },
      state: "connected",
      tools: [
        { name: "mcp__filesystem__read", originalName: "read", description: "Read a file" },
        { name: "mcp__filesystem__write", originalName: "write", description: "" },
      ],
    },
    {
      name: "remote",
      config: { type: "http", url: "https://x.test/mcp" },
      state: "failed",
      lastError: "connect ECONNREFUSED",
      tools: [],
    },
    {
      name: "off",
      config: { type: "stdio", command: "unused", enabled: false },
      state: "disabled",
      tools: [],
    },
  ],
}

function fakeApi(over: Record<string, unknown> = {}): ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/mcp") return SNAPSHOT
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => {
      throw new Error("unused")
    }),
    ...over,
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> }
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
    root.render(<McpView api={api} notice={notice} />)
  })
  await flush()
  return { container, root }
}

describe("McpView", () => {
  it("renders server names, states, errors and config summaries", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/mcp")
    expect(container.textContent).toContain("filesystem")
    expect(container.querySelector('[data-testid="mcp-state-filesystem"]')?.textContent).toBe("已连接")
    expect(container.querySelector('[data-testid="mcp-state-remote"]')?.textContent).toBe("失败")
    expect(container.querySelector('[data-testid="mcp-state-off"]')?.textContent).toBe("已禁用")
    expect(container.querySelector('[data-testid="mcp-error-remote"]')?.textContent).toContain("ECONNREFUSED")
    expect(container.querySelector('[data-testid="mcp-error-filesystem"]')).toBeNull()
    // config summary lines
    expect(container.textContent).toContain("npx -y srv")
    expect(container.textContent).toContain("https://x.test/mcp")
    // the readonly note is always visible
    expect(container.textContent).toContain("readonly")
  })

  it("expands a server into its tool list with sensitive badges", async () => {
    const { container } = await mount(fakeApi())
    expect(container.querySelector('[data-testid="mcp-tools-filesystem"]')).toBeNull()
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-expand-filesystem"]') as HTMLButtonElement).click()
    })
    const tools = container.querySelector('[data-testid="mcp-tools-filesystem"]')
    expect(tools?.textContent).toContain("mcp__filesystem__read")
    expect(tools?.textContent).toContain("Read a file")
    expect(tools?.textContent).toContain("mcp__filesystem__write")
    // every MCP tool carries the sensitive badge
    expect(tools?.querySelectorAll('[data-testid="mcp-sensitive"]').length).toBe(2)
  })

  it("manual refresh re-fetches the snapshot", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-refresh"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("shows an empty state when no servers are configured", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ servers: [] })) })
    const { container } = await mount(api)
    expect(container.querySelector('[data-testid="mcp-empty"]')).not.toBeNull()
  })

  it("surfaces load failures through the notice", async () => {
    const notices: string[] = []
    const api = fakeApi({ get: vi.fn(async () => { throw new Error("boom") }) })
    await mount(api, (t) => notices.push(t))
    expect(notices.some((n) => n.includes("boom"))).toBe(true)
  })
})

describe("McpView actions (toggle + reconnect)", () => {
  it("offers disable on a connected server and enable on a disabled one", async () => {
    const { container } = await mount(fakeApi())
    const disable = container.querySelector('button[data-testid="mcp-toggle-filesystem"]')
    expect(disable?.textContent).toBe("禁用")
    const enable = container.querySelector('button[data-testid="mcp-toggle-off"]')
    expect(enable?.textContent).toBe("启用")
  })

  it("sends the enable call and re-fetches on completion", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-toggle-filesystem"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers/filesystem/enable", { enabled: false })
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("shows reconnect only for failed servers and calls the endpoint", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    expect(container.querySelector('button[data-testid="mcp-reconnect-filesystem"]')).toBeNull()
    expect(container.querySelector('button[data-testid="mcp-reconnect-remote"]')).not.toBeNull()
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-reconnect-remote"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers/remote/reconnect")
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("surfaces action failures through the notice without a reload", async () => {
    const notices: string[] = []
    const api = fakeApi({ post: vi.fn(async () => { throw new Error("503 no manager") }) })
    const { container } = await mount(api, (t) => notices.push(t))
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-toggle-filesystem"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(notices.some((n) => n.includes("503 no manager"))).toBe(true)
    expect(api.get).toHaveBeenCalledTimes(1)
  })
})
