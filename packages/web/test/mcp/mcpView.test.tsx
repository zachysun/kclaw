/**
 * McpView — MCP 服务器管理页测试。照 permissionsView.test.tsx 的 fake-api
 * 模式：vi.fn 的 ApiClient，get 按路径返回快照。覆盖：分组渲染（全局 +
 * 项目组）、组折叠、状态徽标与连接按钮、动作携带组定位、目标下拉（默认
 * 当前会话目录）、编辑换层（toGroup）、删除带组、手动刷新、空态、加载失
 * 败提示、后台轮询静默。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { McpView } from "../../src/mcp/McpView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJ_A = "/tmp/proj-a"
const PROJ_B = "/tmp/proj-b"

const SNAPSHOT = {
  groups: [
    {
      id: "global",
      servers: [
        {
          name: "existing",
          config: { type: "stdio", command: "run", env: { TOKEN: "s3cret" } },
          group: "global",
          state: "disconnected",
          tools: [],
        },
        {
          name: "remote",
          config: { type: "http", url: "https://x.test/mcp" },
          group: "global",
          state: "failed",
          lastError: "connect ECONNREFUSED",
          tools: [],
        },
        {
          name: "off",
          config: { type: "stdio", command: "unused", enabled: false },
          group: "global",
          state: "disabled",
          tools: [],
        },
      ],
    },
    {
      id: PROJ_A,
      servers: [
        {
          name: "filesystem",
          config: { type: "stdio", command: "npx -y srv" },
          group: PROJ_A,
          state: "connected",
          tools: [
            { name: "mcp__filesystem__read", originalName: "read", description: "Read a file" },
            { name: "mcp__filesystem__write", originalName: "write", description: "" },
          ],
        },
      ],
    },
    {
      id: PROJ_B,
      servers: [
        {
          name: "filesystem",
          config: { type: "stdio", command: "b-srv" },
          group: PROJ_B,
          state: "connecting",
          tools: [],
        },
      ],
    },
  ],
  mainWorkspace: PROJ_A,
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

async function mount(api: ApiClient, notice: (text: string) => void = (): void => {}, sessionWorkdir?: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<McpView api={api} notice={notice} sessionWorkdir={sessionWorkdir} />)
  })
  await flush()
  return { container, root }
}

describe("McpView grouped snapshot", () => {
  it("renders one section per group (global first) with per-entry states and errors", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/mcp")
    // groups in snapshot order, group labels localized
    const ids = [...container.querySelectorAll(".mcp-group")].map((el) => el.getAttribute("data-testid"))
    expect(ids).toEqual([`mcp-group-global`, `mcp-group-${PROJ_A}`, `mcp-group-${PROJ_B}`])
    expect(container.querySelector('[data-testid="mcp-fold-global"]')?.textContent).toContain("全局")
    expect(container.querySelector(`[data-testid="mcp-fold-${PROJ_A}"]`)?.textContent).toContain(PROJ_A)
    // entry counts
    expect(container.querySelector('[data-testid="mcp-fold-global"]')?.textContent).toContain("3 个条目")
    // states
    expect(container.querySelector('[data-testid="mcp-state-existing"]')?.textContent).toBe("未连接")
    expect(container.querySelector('[data-testid="mcp-state-remote"]')?.textContent).toBe("失败")
    expect(container.querySelector('[data-testid="mcp-state-off"]')?.textContent).toBe("已禁用")
    expect(container.querySelector('[data-testid="mcp-error-remote"]')?.textContent).toContain("ECONNREFUSED")
    // config summary lines
    expect(container.textContent).toContain("npx -y srv")
    expect(container.textContent).toContain("https://x.test/mcp")
  })

  it("scopes same-name entries to their group section", async () => {
    const { container } = await mount(fakeApi())
    const inA = container.querySelector(`[data-testid="mcp-group-${PROJ_A}"]`)
    const inB = container.querySelector(`[data-testid="mcp-group-${PROJ_B}"]`)
    expect(inA?.querySelector('[data-testid="mcp-state-filesystem"]')?.textContent).toBe("已连接")
    expect(inB?.querySelector('[data-testid="mcp-state-filesystem"]')?.textContent).toBe("连接中")
    expect(inA?.querySelector('[data-testid="mcp-state-filesystem"]')).not.toBe(inB?.querySelector('[data-testid="mcp-state-filesystem"]'))
  })

  it("folds and unfolds a group", async () => {
    const { container } = await mount(fakeApi())
    const group = container.querySelector(`[data-testid="mcp-group-${PROJ_A}"]`)!
    expect(group.querySelector('[data-testid="mcp-server-filesystem"]')).not.toBeNull()
    await act(async () => {
      ;(group.querySelector(`button[data-testid="mcp-fold-${PROJ_A}"]`) as HTMLButtonElement).click()
    })
    expect(group.querySelector('[data-testid="mcp-server-filesystem"]')).toBeNull()
    await act(async () => {
      ;(group.querySelector(`button[data-testid="mcp-fold-${PROJ_A}"]`) as HTMLButtonElement).click()
    })
    expect(group.querySelector('[data-testid="mcp-server-filesystem"]')).not.toBeNull()
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
    const api = fakeApi({ get: vi.fn(async () => ({ groups: [{ id: "global", servers: [] }], mainWorkspace: "/tmp/main" })) })
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

describe("McpView actions (toggle / connect / delete carry the group)", () => {
  it("offers 连接 on a disconnected entry, 重试 on a failed one, neither on connected", async () => {
    const { container } = await mount(fakeApi())
    expect(container.querySelector('button[data-testid="mcp-connect-existing"]')?.textContent).toBe("连接")
    expect(container.querySelector('button[data-testid="mcp-connect-remote"]')?.textContent).toBe("重试")
    expect(container.querySelector('button[data-testid="mcp-connect-filesystem"]')).toBeNull()
  })

  it("sends the connect probe with the entry's group", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-connect-existing"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers/existing/connect", { group: "global" })
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("sends the enable call with the entry's group", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-toggle-filesystem"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith(`/mcp/servers/filesystem/enable`, { group: PROJ_A, enabled: false })
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("deletes with the group as a query parameter", async () => {
    const api = fakeApi({ del: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-delete-filesystem"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith(`/mcp/servers/filesystem?group=${encodeURIComponent(PROJ_A)}`)
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

describe("McpView form (add / edit / move / delete)", () => {
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

  function selectOption(container: HTMLElement, testid: string, value: string): void {
    const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }

  it("defaults the target to the selected session's workdir", async () => {
    const api = fakeApi()
    const { container } = await mount(api, () => {}, PROJ_A)
    await openAdd(container)
    const select = container.querySelector('[data-testid="mcp-form-group"]') as HTMLSelectElement
    expect(select.value).toBe(PROJ_A)
  })

  it("falls back to the daemon workspace, then global, when no session is selected", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openAdd(container)
    expect((container.querySelector('[data-testid="mcp-form-group"]') as HTMLSelectElement).value).toBe(PROJ_A)

    const noMain = fakeApi({ get: vi.fn(async () => ({ groups: [{ id: "global", servers: [] }], mainWorkspace: "" })) })
    const { container: c2 } = await mount(noMain)
    await openAdd(c2)
    expect((c2.querySelector('[data-testid="mcp-form-group"]') as HTMLSelectElement).value).toBe("global")
  })

  it("keeps the session workdir as the default even when the client snapshot predates its group", async () => {
    const api = fakeApi()
    const fresh = "/tmp/fresh-proj"
    const { container } = await mount(api, () => {}, fresh)
    await openAdd(container)
    const select = container.querySelector('[data-testid="mcp-form-group"]') as HTMLSelectElement
    expect(select.value).toBe(fresh)
    // the fresh group is offered as an option even though the snapshot doesn't list it yet
    expect([...select.options].some((o) => o.value === fresh)).toBe(true)
  })

  it("adds a stdio server into the chosen group", async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await openAdd(container)
    selectOption(container, "mcp-form-group", PROJ_A)
    typeInto(container, "mcp-form-name", "new-srv")
    typeInto(container, "mcp-form-command", "npx -y srv")
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/mcp/servers", {
      name: "new-srv",
      config: { type: "stdio", command: "npx -y srv" },
      group: PROJ_A,
    })
    expect(api.get).toHaveBeenCalledTimes(2)
    // form closes after a successful save
    expect(container.querySelector('[data-testid="mcp-form"]')).toBeNull()
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
      group: PROJ_A,
    })
  })

  it("edits an entry in place with plaintext env echo (no toGroup when the target is unchanged)", async () => {
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
      group: "global",
      config: { type: "stdio", command: "run2", env: { TOKEN: "s3cret" } },
    })
  })

  it("moving an entry to another group sends toGroup", async () => {
    const api = fakeApi({ patch: vi.fn(async () => ({ ok: true })) })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-edit-filesystem"]') as HTMLButtonElement).click()
    })
    selectOption(container, "mcp-form-group", PROJ_B)
    await act(async () => {
      ;(container.querySelector('button[data-testid="mcp-form-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/mcp/servers/filesystem", {
      group: PROJ_A,
      toGroup: PROJ_B,
      config: { type: "stdio", command: "npx -y srv" },
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
      group: "global",
      config: { type: "stdio", command: "unused", enabled: false },
    })
  })
})

describe("McpView background polling", () => {
  /** Render under fake timers: mount()/flush() rely on real setTimeout. */
  async function mountFakeTimers(api: ApiClient, notice: (text: string) => void = (): void => {}, sessionWorkdir?: string): Promise<{ container: HTMLElement; root: Root }> {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<McpView api={api} notice={notice} sessionWorkdir={sessionWorkdir} />)
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
