/**
 * SkillsView — 只读技能页测试。照 memoryView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回裸数据；列表 + 点开看正文 + 空态 + 失败提示。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { SkillsView } from "../../src/skills/SkillsView.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS = [
  { name: "commit-helper", displayName: "commit-helper", description: "提交规范。", visibility: "all", origin: "global" },
  { name: "heavy-flow", displayName: "heavy-flow", description: "重流程。", visibility: "user-only", origin: "project" },
]

function fakeApi(over: Record<string, unknown> = {}): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/skills?workdir=%2Fw%2Fproj") return ROWS
      if (path === "/skills") return ROWS
      if (path === "/skills/commit-helper?workdir=%2Fw%2Fproj") {
        return { name: "commit-helper", content: "# 提交规程\n\n一行标题。" }
      }
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => { throw new Error("unused") }),
    ...over,
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn> }
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
    root.render(<SkillsView api={api} notice={notice} workdir={workdir} />)
  })
  await flush()
  return { container, root }
}

describe("SkillsView", () => {
  it("lists user-visible skills scoped by the session workdir", async () => {
    const api = fakeApi()
    const { container } = await mount(api, undefined, "/w/proj")
    expect(api.get).toHaveBeenCalledWith("/skills?workdir=%2Fw%2Fproj")
    expect(container.textContent).toContain("commit-helper")
    expect(container.textContent).toContain("提交规范。")
    expect(container.textContent).toContain("heavy-flow")
    expect(container.textContent).toContain("仅用户")
  })

  it("fetches without the workdir query when no session workdir is known", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/skills")
    expect(container.textContent).toContain("commit-helper")
  })

  it("clicking a skill opens its read-only body", async () => {
    const api = fakeApi()
    const { container } = await mount(api, undefined, "/w/proj")
    const item = container.querySelector<HTMLElement>('[data-testid="skill-commit-helper"]')!
    await act(async () => {
      item.click()
    })
    await flush()
    expect(api.get).toHaveBeenCalledWith("/skills/commit-helper?workdir=%2Fw%2Fproj")
    expect(container.textContent).toContain("# 提交规程")
  })

  it("empty listing points at the two skill directories", async () => {
    const api = fakeApi({ get: vi.fn(async () => []) })
    const { container } = await mount(api)
    expect(container.textContent).toContain("还没有技能")
    expect(container.textContent).toContain(".kclaw/skills")
  })

  it("load failure lands in the notice area", async () => {
    const api = fakeApi({ get: vi.fn(async () => { throw new Error("HTTP 503") }) })
    const notice = vi.fn()
    await mount(api, notice)
    expect(notice.mock.calls.some(([t]) => String(t).includes("加载技能失败"))).toBe(true)
  })
})
