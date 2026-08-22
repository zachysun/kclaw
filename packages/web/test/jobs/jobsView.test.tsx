/**
 * JobsView — jobs CRUD surface (spec §4/调度, GET /jobs, POST /jobs,
 * PATCH /jobs/:id, DELETE /jobs/:id). Covers list rendering, create/edit form
 * submit (including the 400 error from an invalid cron), delete confirmation,
 * and the enabled toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { ApiError, type ApiClient } from "../../src/api.js"
import { JobsView } from "../../src/jobs/JobsView.js"
import type { Job } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
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
    del: vi.fn(),
  }
}

/** Mount the view and flush the initial GET /jobs effect. */
async function mount(api: ApiClient): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<JobsView api={api} />)
  })
  await act(async () => {}) // flush the GET /jobs promise + state update
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

describe("JobsView", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders the job list with the scheduled columns", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([
      job(),
      job({ id: "job_2", name: "备份", cron: "*/5 * * * *", enabled: false, lastStatus: "ok", lastRunAt: "2026-08-15T08:00:00.000Z" }),
    ])
    const { container, root } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/jobs")
    const table = container.querySelector('[data-testid="jobs-table"]')!
    expect(table.textContent).toContain("早报")
    expect(table.textContent).toContain("0 9 * * *")
    expect(table.textContent).toContain("2026-08-16T09:00:00.000Z")
    expect(table.textContent).toContain("备份")
    expect(table.textContent).toContain("ok") // lastStatus
    expect(table.textContent).toContain("2026-08-15T08:00:00.000Z") // lastRunAt
    expect(container.querySelector('[data-testid="job-enabled-job_1"]')?.textContent).toContain("启用")
    expect(container.querySelector('[data-testid="job-enabled-job_2"]')?.textContent).toContain("禁用")
    unmount(root, container)
  })

  it("submits the create form and prepends the new job", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    api.post.mockResolvedValue(job({ id: "job_new", name: "备份", cron: "*/5 * * * *", prompt: "每五分钟跑一次" }))
    const { container, root } = await mount(api)

    const inputs = container.querySelectorAll('form[data-testid="job-form"] input')
    const nameInput = inputs[0] as HTMLInputElement
    const cronInput = inputs[1] as HTMLInputElement
    const promptInput = container.querySelector('textarea[data-testid="job-prompt"]') as HTMLTextAreaElement
    setValue(nameInput, "备份")
    setValue(cronInput, "*/5 * * * *")
    setTextArea(promptInput, "每五分钟跑一次")
    await act(async () => {
      ;(container.querySelector('button[data-testid="job-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/jobs", { name: "备份", cron: "*/5 * * * *", prompt: "每五分钟跑一次" })
    // The new job appears as the first row.
    expect(container.querySelector('[data-testid="job-row-job_new"]')).not.toBeNull()
    expect(container.textContent).toContain("备份")
    // Form resets after a successful create.
    expect(nameInput.value).toBe("")
    unmount(root, container)
  })

  it("create mode: enabled checkbox is checked AND disabled, with an explanatory hint", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    const { container, root } = await mount(api)
    const enabledInput = container.querySelector('input[data-testid="job-enabled"]') as HTMLInputElement
    expect(enabledInput.checked).toBe(true)
    expect(enabledInput.disabled).toBe(true)
    expect(container.querySelector('[data-testid="job-enabled-hint"]')?.textContent).toContain("默认启用")
    unmount(root, container)
  })

  it("edit mode: the enabled checkbox is interactive and its toggle reaches the PATCH", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([job({ id: "job_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: true })])
    api.patch.mockResolvedValue(job({ id: "job_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="job-edit-job_1"]') as HTMLButtonElement).click()
    })
    const enabledInput = container.querySelector('input[data-testid="job-enabled"]') as HTMLInputElement
    expect(enabledInput.disabled).toBe(false)
    expect(enabledInput.checked).toBe(true)
    // Uncheck it — this must flow into the PATCH.
    await act(async () => {
      enabledInput.click()
    })
    await act(async () => {
      ;(container.querySelector('button[data-testid="job-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/jobs/job_1", {
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
      ;(container.querySelector('button[data-testid="job-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="job-error"]')?.textContent).toContain("必填")
    expect(api.post).not.toHaveBeenCalled()
    unmount(root, container)
  })

  it("surfaces the server 400 error.message for an invalid cron", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    api.post.mockRejectedValue(new ApiError(400, "Invalid cron expression"))
    const { container, root } = await mount(api)

    const inputs = container.querySelectorAll('form[data-testid="job-form"] input')
    setValue(inputs[0] as HTMLInputElement, "坏任务")
    setValue(inputs[1] as HTMLInputElement, "not-a-cron")
    setTextArea(container.querySelector('textarea[data-testid="job-prompt"]') as HTMLTextAreaElement, "p")
    await act(async () => {
      ;(container.querySelector('button[data-testid="job-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="job-error"]')?.textContent).toContain("Invalid cron expression")
    unmount(root, container)
  })

  it("deletes only after the native confirm() approves", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([job({ id: "job_1" }), job({ id: "job_2" })])
    api.del.mockResolvedValue(undefined)
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal("confirm", confirmMock)
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="job-delete-job_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.del).toHaveBeenCalledWith("/jobs/job_1")
    expect(container.querySelector('[data-testid="job-row-job_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="job-row-job_2"]')).not.toBeNull()
    unmount(root, container)
  })

  it("does not delete when the confirm() is declined", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([job()])
    const confirmMock = vi.fn(() => false)
    vi.stubGlobal("confirm", confirmMock)
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="job-delete-job_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.del).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="job-row-job_1"]')).not.toBeNull()
    unmount(root, container)
  })

  it("toggles enabled via PATCH {enabled}", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([job({ enabled: true })])
    api.patch.mockResolvedValue(job({ enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="job-toggle-job_1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/jobs/job_1", { enabled: false })
    expect(container.querySelector('[data-testid="job-enabled-job_1"]')?.textContent).toContain("禁用")
    unmount(root, container)
  })

  it("prefills the form when editing and PATCHes the updated fields", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([job({ id: "job_1", name: "早报", cron: "0 9 * * *", prompt: "给我今日早报", enabled: false })])
    api.patch.mockResolvedValue(job({ id: "job_1", name: "晚间报", cron: "0 18 * * *", prompt: "给我晚间报", enabled: false }))
    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('[data-testid="job-edit-job_1"]') as HTMLButtonElement).click()
    })
    const inputs = container.querySelectorAll('form[data-testid="job-form"] input')
    expect((inputs[0] as HTMLInputElement).value).toBe("早报")
    expect((inputs[1] as HTMLInputElement).value).toBe("0 9 * * *")
    expect((container.querySelector('textarea[data-testid="job-prompt"]') as HTMLTextAreaElement).value).toBe("给我今日早报")
    expect((container.querySelector('input[data-testid="job-enabled"]') as HTMLInputElement).checked).toBe(false)

    setValue(inputs[0] as HTMLInputElement, "晚间报")
    setValue(inputs[1] as HTMLInputElement, "0 18 * * *")
    setTextArea(container.querySelector('textarea[data-testid="job-prompt"]') as HTMLTextAreaElement, "给我晚间报")
    await act(async () => {
      ;(container.querySelector('button[data-testid="job-submit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/jobs/job_1", {
      name: "晚间报",
      cron: "0 18 * * *",
      prompt: "给我晚间报",
      enabled: false,
    })
    expect(container.textContent).toContain("晚间报")
    unmount(root, container)
  })
})
