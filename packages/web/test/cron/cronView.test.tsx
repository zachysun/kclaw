/**
 * CronView — crons CRUD surface (scheduled crons, GET /cron, POST /cron,
 * PATCH /cron/:id, DELETE /cron/:id). Covers list rendering, create/edit form
 * submit (including the 400 error from an invalid cron), delete confirmation,
 * and the enabled toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { ApiError, type ApiClient } from "../../src/api.js"
import { CronView } from "../../src/cron/CronView.js"
import type { Cron } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function cron(overrides: Partial<Cron> = {}): Cron {
  return {
    id: "cron_1",
    name: "早报",
    cron: "0 9 * * *",
    prompt: "给我今日早报",
    enabled: true,
    nextRunAt: "2026-08-16T09:00:00.000Z",
    ...overrides,
  }
}

function makeApi(): ApiClient & {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(), upload: vi.fn(),
  }
}

/** Mount the view and flush the initial GET /cron effect. */
async function mount(api: ApiClient): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CronView api={api} />)
  })
  await act(async () => {}) // flush the GET /cron promise + state update
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  root.unmount()
  container.remove()
}

function setValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function setTextArea(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("CronView", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders the cron list with the scheduled columns", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([
      cron(),
      cron({ id: "cron_2", name: "备份", cron: "*/5 * * * *", enabled: false, lastStatus: "ok", lastRunAt: "2026-08-15T08:00:00.000Z" }),
    ])
    const { container, root } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/cron")
    const table = container.querySelector('[data-testid="cron-table"]')!
    expect(table.textContent).toContain("早报")
    expect(table.textContent).toContain("0 9 * * *")
    expect(table.textContent).toContain("备份")
    expect(table.textContent).toContain("ok") // lastStatus
    expect(container.querySelector('[data-testid="cron-enabled-cron_1"]')?.textContent).toContain("启用")
    expect(container.querySelector('[data-testid="cron-enabled-cron_2"]')?.textContent).toContain("禁用")
    // Schedule times render in the compact local form (MM/DD HH:MM), derived
    // here with local Date arithmetic so the assertion holds in any TZ.
    const expectLocal = (iso: string): string => {
      const d = new Date(iso)
      const md = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`
      const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
      return `${md} ${hhmm}`
    }
    expect(table.textContent).toContain(expectLocal("2026-08-16T09:00:00.000Z"))
    expect(table.textContent).toContain(expectLocal("2026-08-15T08:00:00.000Z"))
    expect(table.textContent).not.toContain("2026-08-16T09:00:00.000Z") // raw ISO never shown
    unmount(root, container)
  })

  it("submits the create form and prepends the new cron", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    api.post.mockResolvedValue(cron({ id: "cron_new", name: "备份", cron: "*/5 * * * *", prompt: "每五分钟跑一次" }))
    const { container, root } = await mount(api)

    const inputs = container.querySelectorAll('form[data-testid="cron-form"] input')
    const nameInput = inputs[0] as HTMLInputElement
    const cronInput = inputs[1] as HTMLInputElement
    const promptInput = container.querySelector('textarea[data-testid="cron-prompt"]') as HTMLTextAreaElement
    setValue(nameInput, "备份")
    setValue(cronInput, "*/5 * * * *")
    setTextArea(promptInput, "每五分钟跑一次")
    await act(async () => {
      ;(container.querySelector('button[data-testid="cron-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/cron", { name: "备份", cron: "*/5 * * * *", prompt: "每五分钟跑一次" })
    // The new cron appears as the first row.
    expect(container.querySelector('[data-testid="cron-row-cron_new"]')).not.toBeNull()
    expect(container.textContent).toContain("备份")
    // Form resets after a successful create.
    expect(nameInput.value).toBe("")
    unmount(root, container)
  })

  it("create mode: enabled checkbox is checked AND disabled, with an explanatory hint", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    const { container, root } = await mount(api)
    const enabledInput = container.querySelector('input[data-testid="cron-enabled"]') as HTMLInputElement
    expect(enabledInput.checked).toBe(true)
    expect(enabledInput.disabled).toBe(true)
    expect(container.querySelector('[data-testid="cron-enabled-hint"]')?.textContent).toContain("默认启用")
    unmount(root, container)
  })

  it("edit mode: the enabled checkbox is interactive and its toggle reaches the PATCH", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([cron({ id: "cron_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: true })])
    api.patch.mockResolvedValue(cron({ id: "cron_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="cron-edit-cron_1"]') as HTMLButtonElement).click()
    })
    const enabledInput = container.querySelector('input[data-testid="cron-enabled"]') as HTMLInputElement
    expect(enabledInput.disabled).toBe(false)
    expect(enabledInput.checked).toBe(true)
    // Uncheck it — this must flow into the PATCH.
    await act(async () => {
      enabledInput.click()
    })
    await act(async () => {
      ;(container.querySelector('button[data-testid="cron-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/cron/cron_1", {
      name: "早报",
      cron: "0 9 * * *",
      prompt: "给我今日早报",
      enabled: false,
    })
    unmount(root, container)
  })

  it("blocks a submit with empty required fields and does not call the api", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="cron-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="cron-error"]')?.textContent).toContain("必填")
    expect(api.post).not.toHaveBeenCalled()
    unmount(root, container)
  })

  it("surfaces the server 400 error.message for an invalid cron", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    api.post.mockRejectedValue(new ApiError(400, "Invalid cron expression"))
    const { container, root } = await mount(api)

    const inputs = container.querySelectorAll('form[data-testid="cron-form"] input')
    setValue(inputs[0] as HTMLInputElement, "坏任务")
    setValue(inputs[1] as HTMLInputElement, "not-a-cron")
    setTextArea(container.querySelector('textarea[data-testid="cron-prompt"]') as HTMLTextAreaElement, "p")
    await act(async () => {
      ;(container.querySelector('button[data-testid="cron-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="cron-error"]')?.textContent).toContain("Invalid cron expression")
    unmount(root, container)
  })

  it("deletes only after the native confirm() approves", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([cron({ id: "cron_1" }), cron({ id: "cron_2" })])
    api.del.mockResolvedValue(undefined)
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal("confirm", confirmMock)
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="cron-delete-cron_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.del).toHaveBeenCalledWith("/cron/cron_1")
    expect(container.querySelector('[data-testid="cron-row-cron_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="cron-row-cron_2"]')).not.toBeNull()
    unmount(root, container)
  })

  it("does not delete when the confirm() is declined", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([cron()])
    const confirmMock = vi.fn(() => false)
    vi.stubGlobal("confirm", confirmMock)
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="cron-delete-cron_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.del).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="cron-row-cron_1"]')).not.toBeNull()
    unmount(root, container)
  })

  it("toggles enabled via PATCH {enabled}", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([cron({ enabled: true })])
    api.patch.mockResolvedValue(cron({ enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="cron-toggle-cron_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/cron/cron_1", { enabled: false })
    expect(container.querySelector('[data-testid="cron-enabled-cron_1"]')?.textContent).toContain("禁用")
    unmount(root, container)
  })

  it("prefills the form when editing and PATCHes the updated fields", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([cron({ id: "cron_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: false })])
    api.patch.mockResolvedValue(cron({ id: "cron_1", name: "晚间报", cron: "0 18 * * *", prompt: "给我晚间报", enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="cron-edit-cron_1"]') as HTMLButtonElement).click()
    })
    const inputs = container.querySelectorAll('form[data-testid="cron-form"] input')
    expect((inputs[0] as HTMLInputElement).value).toBe("早报")
    expect((inputs[1] as HTMLInputElement).value).toBe("0 9 * * *")
    expect((container.querySelector('textarea[data-testid="cron-prompt"]') as HTMLTextAreaElement).value).toBe("给我今日早报")
    expect((container.querySelector('input[data-testid="cron-enabled"]') as HTMLInputElement).checked).toBe(false)

    setValue(inputs[0] as HTMLInputElement, "晚间报")
    setValue(inputs[1] as HTMLInputElement, "0 18 * * *")
    setTextArea(container.querySelector('textarea[data-testid="cron-prompt"]') as HTMLTextAreaElement, "给我晚间报")
    await act(async () => {
      ;(container.querySelector('button[data-testid="cron-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/cron/cron_1", {
      name: "晚间报",
      cron: "0 18 * * *",
      prompt: "给我晚间报",
      enabled: false,
    })
    expect(container.textContent).toContain("晚间报")
    unmount(root, container)
  })
})
