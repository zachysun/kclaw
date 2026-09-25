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
      name: "existing",
      config: { type: "stdio", command: "run", env: { TOKEN: "s3cret" } },
      scope: "global",
      state: "connected",
      tools: [],
    },
    {
      name: "filesystem",
      config: { type: "stdio", command: "npx -y srv" },
      scope: "project",
      state: "connected",
      tools: [
        { name: "mcp__filesystem__read", originalName: "read", description: "Read a file" },
        { name: "mcp__filesystem__write", originalName: "write", description: "" },
      ],
    },
    {
      name: "remote",
      config: { type: "http", url: "https://x.test/mcp" },
      scope: "global",
      state: "failed",
      lastError: "connect ECONNREFUSED",
      tools: [],
    },
    {
      name: "off",
      config: { type: "stdio", command: "unused", enabled: false },
      scope: "global",
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
    // source-layer badges
    expect(container.querySelector('[data-testid="mcp-scope-filesystem"]')?.textContent).toBe("项目")
    expect(container.querySelector('[data-testid="mcp-scope-existing"]')?.textContent).toBe("全局")
    // config summary lines
    expect(container.textContent).toContain("npx -y srv")
    expect(container.textContent).toContain("https://x.test/mcp")
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

describe("McpView form (add / edit / delete)", () => {
  async function openAdd(container: HTMLElement): Promise<void> {
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-add"]') as HTMLButtonElement).click()
    })
  }

  function typeInto(container: HTMLElement, testid: string, value: string): void {
    const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement | HTMLTextAreaElement
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!
    act(() => {
      setter.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  it("adds a stdio server through the form (default layer: global)", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await openAdd(container)
    expect(container.querySelector('[data-testid="mcp-form"]')).not.toBeNull()
    typeInto(container, "mcp-form-name", "new-srv")
    typeInto(container, "mcp-form-command", "npx -y srv")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers", {
      name: "new-srv",
      config: { type: "stdio", command: "npx -y srv" },
      layer: "global",
    })
    expect(api.get).toHaveBeenCalledTimes(2)
    // form closes after a successful save
    expect(container.querySelector('[data-testid="mcp-form"]')).toBeNull()
  })

  it("creates into the project layer when the form selects it", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await openAdd(container)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-layer-project"]') as HTMLButtonElement).click()
    })
    typeInto(container, "mcp-form-name", "proj-srv")
    typeInto(container, "mcp-form-command", "npx -y proj")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers", {
      name: "proj-srv",
      config: { type: "stdio", command: "npx -y proj" },
      layer: "project",
    })
  })

  it("hides the layer choice when editing an existing entry", async () => {
    const api = fakeApi({ patch: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-edit-existing"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="mcp-form-layer-project"]')).toBeNull()
    expect(container.querySelector('[data-testid="mcp-form-layer-global"]')).toBeNull()
  })

  it("switches to http fields and carries headers through", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await openAdd(container)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-type-http"]') as HTMLButtonElement).click()
    })
    typeInto(container, "mcp-form-name", "remote")
    typeInto(container, "mcp-form-url", "https://x.test/mcp")
    // add one header pair
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-headers-add"]') as HTMLButtonElement).click()
    })
    typeInto(container, "mcp-form-headers-key-0", "Authorization")
    typeInto(container, "mcp-form-headers-value-0", "Bearer k")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers", {
      name: "remote",
      config: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer k" } },
      layer: "global",
    })
  })

  it("edits an existing server with plaintext echo of env", async () => {
    const api = fakeApi({ patch: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-edit-existing"]') as HTMLButtonElement).click()
    })
    const nameInput = container.querySelector('[data-testid="mcp-form-name"]') as HTMLInputElement
    expect(nameInput.value).toBe("existing")
    expect(nameInput.disabled).toBe(true)
    expect((container.querySelector('[data-testid="mcp-form-command"]') as HTMLInputElement).value).toBe("run")
    // env echoes back in plaintext
    expect((container.querySelector('[data-testid="mcp-form-env-key-0"]') as HTMLInputElement).value).toBe("TOKEN")
    expect((container.querySelector('[data-testid="mcp-form-env-value-0"]') as HTMLInputElement).value).toBe("s3cret")
    typeInto(container, "mcp-form-command", "run2")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/mcp/servers/existing", {
      config: { type: "stdio", command: "run2", env: { TOKEN: "s3cret" } },
    })
  })

  it("keeps the form open and shows the error when the API rejects", async () => {
    const api = fakeApi({
      post: vi.fn(async () => {
        throw new Error("MCP server already exists: x")
      }),
    })
    const { container } = await mount(api)
    await openAdd(container)
    typeInto(container, "mcp-form-name", "x")
    typeInto(container, "mcp-form-command", "c")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="mcp-form"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-form-error"]')?.textContent).toContain("already exists")
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it("deletes a server and re-fetches", async () => {
    const api = fakeApi({ del: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-delete-existing"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith("/mcp/servers/existing")
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})

describe("McpView background polling", () => {
  /** Render under fake timers: mount()/flush() rely on real setTimeout. */
  async function mountFakeTimers(api: ApiClient, notice: (text: string) => void = (): void => {}): Promise<{ container: HTMLElement; root: Root }> {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<McpView api={api} notice={notice} />)
    })
    return { container, root }
  }

  it("polls every 2s while the tab is visible and stops when hidden or unmounted", async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      const { root } = await mountFakeTimers(api)
      expect(api.get).toHaveBeenCalledTimes(1) // entry fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(api.get).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(api.get).toHaveBeenCalledTimes(4)
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(api.get).toHaveBeenCalledTimes(4) // hidden tab: no fetches
      visibility.mockRestore()
      await act(async () => {
        root.unmount()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(api.get).toHaveBeenCalledTimes(4) // unmounted: interval cleared
    } finally {
      vi.useRealTimers()
    }
  })

  it("background poll failures stay quiet (no toast)", async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const api = fakeApi({
        get: vi.fn(async () => {
          calls += 1
          if (calls > 1) throw new Error("daemon gone")
          return SNAPSHOT
        }),
      })
      const notices: string[] = []
      const { container } = await mountFakeTimers(api, (t) => notices.push(t))
      expect(container.textContent).toContain("filesystem") // entry fetch still renders
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      }) // two failing background polls
      expect(notices).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("McpView form review fix", () => {
  it("saving an edit to a disabled server keeps enabled:false", async () => {
    const api = fakeApi({ patch: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-edit-off"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/mcp/servers/off", {
      config: { type: "stdio", command: "unused", enabled: false },
    })
  })
})
