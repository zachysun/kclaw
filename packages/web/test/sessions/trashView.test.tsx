/**
 * TrashView — the recycle bin (GET /sessions?deleted=true, spec §10 WebUI).
 * Covers list rendering (deleted session titles + 恢复/彻底删除 buttons),
 * restore (POST /sessions/:id/restore), purge (POST /sessions/:id/purge),
 * and the empty state.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { TrashView } from "../../src/sessions/TrashView.js"
import type { SessionMeta } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function session(id: string, title: string): SessionMeta {
  return {
    id,
    title,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    deleted: true,
    deletedAt: "2026-08-15T10:00:00.000Z",
  }
}

function makeApi(): ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }
}

async function mount(api: ApiClient): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<TrashView api={api} />)
  })
  await act(async () => {}) // flush the GET /sessions?deleted=true effect
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  root.unmount()
  container.remove()
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("TrashView", () => {
  it("fetches deleted sessions and renders titles with restore/purge buttons", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([session("s1", "旧会话")])
    const { container, root } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/sessions?deleted=true")
    expect(container.querySelector('[data-testid="trash-item-s1"]')?.textContent).toContain("旧会话")
    expect(container.querySelector('[data-testid="trash-restore-s1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="trash-purge-s1"]')).not.toBeNull()
    unmount(root, container)
  })

  it("restores a session via POST /sessions/:id/restore and removes it from the list", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([session("s1", "旧会话")])
    api.post.mockResolvedValue({ ok: true })
    const { container, root } = await mount(api)
    api.get.mockResolvedValue([]) // after restore the trash empties
    await act(async () => {
      ;(container.querySelector('[data-testid="trash-restore-s1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/sessions/s1/restore")
    expect(container.querySelector('[data-testid="trash-item-s1"]')).toBeNull()
    unmount(root, container)
  })

  it("purges a session via POST /sessions/:id/purge and removes it from the list", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([session("s1", "旧会话")])
    api.post.mockResolvedValue({ ok: true })
    const { container, root } = await mount(api)
    api.get.mockResolvedValue([])
    await act(async () => {
      ;(container.querySelector('[data-testid="trash-purge-s1"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/sessions/s1/purge")
    expect(container.querySelector('[data-testid="trash-item-s1"]')).toBeNull()
    unmount(root, container)
  })

  it("renders an empty state when the trash is empty", async () => {
    const api = makeApi()
    api.get.mockResolvedValue([])
    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="trash-empty"]')).not.toBeNull()
    unmount(root, container)
  })
})
