/**
 * ChannelView — IM Channel 管理页测试。照 mcpView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回快照。覆盖：状态徽标与表单回填、secret
 * 永不回显、allowlist 编辑、保存（payload 形状/失败显示）、测试连接、一键加白。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { ChannelView } from "../../src/channel/ChannelView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT = {
  config: { enabled: true, appId: "cli_a", appSecretSet: true, allowlist: ["ou_1", "ou_2"], primaryOpenId: "ou_1" },
  status: { state: "running" as const },
  pendingSenders: [{ openId: "ou_9", count: 2, lastSeen: Date.now() }],
}

function fakeApi(over: Record<string, unknown> = {}): ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/channel") return SNAPSHOT
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => SNAPSHOT),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
    upload: vi.fn(async () => {
      throw new Error("unused")
    }),
    ...over,
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
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
    root.render(<ChannelView api={api} notice={notice} />)
  })
  await flush()
  return { container, root }
}

const INPUT_SETTER = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!

const input = (container: HTMLElement, testid: string): HTMLInputElement =>
  container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement

async function type(container: HTMLElement, testid: string, value: string): Promise<void> {
  const field = input(container, testid)
  await act(async () => {
    INPUT_SETTER.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("ChannelView", () => {
  it("renders the status badge and prefills the form from the snapshot (secret never echoed)", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/channel")
    expect(container.querySelector('[data-testid="channel-status"]')?.textContent).toBe("运行中")
    expect(input(container, "channel-app-id").value).toBe("cli_a")
    expect(input(container, "channel-app-secret").value).toBe("")
    expect(container.querySelector('[data-testid="channel-form"]')?.textContent).toContain("已设置")
    expect(container.querySelectorAll('[data-testid="channel-allowlist-tags"] .channel-tag')).toHaveLength(2)
    expect(input(container, "channel-primary").value).toBe("ou_1")
    expect(container.querySelector('[data-testid="channel-pending-ou_9"]')).not.toBeNull()
    // The stored secret is nowhere in the DOM.
    expect(container.innerHTML).not.toContain("s3cret")
  })

  it("shows the error badge with the failure reason", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ ...SNAPSHOT, status: { state: "error", error: "handshake timeout" } })),
    })
    const { container } = await mount(api)
    expect(container.querySelector('[data-testid="channel-status"]')?.textContent).toContain("出错")
    expect(container.querySelector('[data-testid="channel-status"]')?.textContent).toContain("handshake timeout")
  })

  it("saves the draft; an empty secret field is omitted (keep the stored one)", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container } = await mount(api, (t) => notices.push(t))
    await type(container, "channel-app-secret", "new-secret")
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-save"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/channel/config", {
      enabled: true,
      appId: "cli_a",
      appSecret: "new-secret",
      allowlist: ["ou_1", "ou_2"],
      primaryOpenId: "ou_1",
    })
    expect(notices.join("\n")).toContain("已保存")
    // The secret field resets after a successful save.
    expect(input(container, "channel-app-secret").value).toBe("")
  })

  it("shows a validation failure inline", async () => {
    const api = fakeApi({
      post: vi.fn(async () => { throw new Error("400 推送接收人必须在白名单里") }),
    })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-save"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="channel-form-error"]')?.textContent).toContain("白名单")
  })

  it("edits the allowlist (add and remove) before saving", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await type(container, "channel-allowlist-input", "ou_3")
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-allowlist-add"]') as HTMLButtonElement).click()
    })
    expect(container.querySelectorAll('[data-testid="channel-allowlist-tags"] .channel-tag')).toHaveLength(3)
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-allowlist-remove-ou_1"]') as HTMLButtonElement).click()
    })
    const tags = [...container.querySelectorAll('[data-testid="channel-allowlist-tags"] .channel-tag code')]
    expect(tags.map((t) => t.textContent)).toEqual(["ou_2", "ou_3"])
  })

  it("tests the connection with the draft credentials and shows the verdict", async () => {
    const api = fakeApi({
      post: vi.fn(async (path: string) => {
        if (path === "/channel/test") return { ok: true }
        throw new Error(`unexpected ${path}`)
      }),
    })
    const { container } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-test"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/channel/test", { appId: "cli_a" })
    expect(container.querySelector('[data-testid="channel-test-result"]')?.textContent).toBe("凭据有效")
  })

  it("allowlists a pending sender with one click and refreshes", async () => {
    const api = fakeApi()
    const notices: string[] = []
    const { container } = await mount(api, (t) => notices.push(t))
    await act(async () => {
      ;(container.querySelector('button[data-testid="channel-allow-ou_9"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/channel/allowlist/ou_9")
    expect(notices.join("\n")).toContain("已加入白名单")
  })

  it("shows the pending list empty state", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ ...SNAPSHOT, pendingSenders: [] })),
    })
    const { container } = await mount(api)
    expect(container.querySelector('[data-testid="channel-pending-empty"]')?.textContent).toContain("暂无记录")
  })
})
