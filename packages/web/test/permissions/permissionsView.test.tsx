/**
 * PermissionsView — 权限规则管理页测试。照 skillsView.test.tsx 的 fake-api
 * 模式：vi.fn 的 ApiClient，get 按路径返回快照；两档清单 + ignored 标注 +
 * 单条删除 + 失败提示。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { PermissionsView } from "../../src/permissions/PermissionsView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT = {
  global: {
    path: "/home/.kclaw/permissions.yaml",
    rules: [
      { rule: "exec:git push*", decidedAt: "2026-09-06T00:00:00.000Z", origin: { tool: "exec", argsJson: "{}", sessionId: "ses_1" }, source: "auto" },
    ],
  },
  project: {
    path: "/w/proj/.kclaw/permissions.yaml",
    tracked: false,
    ignored: false,
    rules: [
      { rule: "fs_write:/w/proj/a.md", decidedAt: "2026-09-06T01:00:00.000Z", origin: { tool: "fs_write", argsJson: "{}" } },
    ],
  },
}

const IGNORED = {
  global: { path: "/home/.kclaw/permissions.yaml", rules: [] },
  project: { path: "/w/proj/.kclaw/permissions.yaml", tracked: true, ignored: true, rules: [] },
}

function fakeApi(over: Record<string, unknown> = {}): ApiClient & { get: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/permissions/rules")) return SNAPSHOT
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => { throw new Error("unused") }),
    ...over,
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(api: ApiClient, notice = () => {}, workdir?: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<PermissionsView api={api} notice={notice} workdir={workdir} />)
  })
  await flush()
  return { container, root }
}

describe("PermissionsView", () => {
  it("lists both scopes with rules, paths and provenance", async () => {
    const api = fakeApi()
    const { container } = await mount(api, undefined, "/w/proj")
    expect(api.get).toHaveBeenCalledWith("/permissions/rules?workspace=%2Fw%2Fproj")
    expect(container.textContent).toContain("exec:git push*")
    expect(container.textContent).toContain("fs_write:/w/proj/a.md")
    expect(container.textContent).toContain("ses_1")
    expect(container.textContent).toContain("/home/.kclaw/permissions.yaml")
    // the auto-learned marker renders for a source:"auto" rule, not for manual ones
    expect(container.querySelector('[data-testid="perm-source-global-0"]')?.textContent).toBe("自动学习")
    expect(container.querySelector('[data-testid="perm-source-project-0"]')).toBeNull()
  })

  it("flags a git-tracked project file as ignored", async () => {
    const api = fakeApi({ get: vi.fn(async () => IGNORED) })
    const { container } = await mount(api)
    expect(container.querySelector('[data-testid="perm-project-ignored"]')).not.toBeNull()
    expect(container.textContent).toContain("不会生效")
  })

  it("deletes a rule by scope+index and reloads", async () => {
    const api = fakeApi()
    const { container } = await mount(api, undefined, "/w/proj")
    await act(async () => {
      ;(container.querySelector('button[data-testid="perm-delete-global-0"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith("/permissions/rules?workspace=%2Fw%2Fproj", { scope: "global", index: 0 })
  })

  it("lands delete failures in the notice instead of rejecting", async () => {
    const api = fakeApi({ del: vi.fn(async () => { throw new Error("boom") }) })
    const notice = vi.fn()
    const { container } = await mount(api, notice, "/w/proj")
    await act(async () => {
      ;(container.querySelector('button[data-testid="perm-delete-project-0"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("删除规则失败"), "error")
  })
})
