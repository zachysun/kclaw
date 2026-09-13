/**
 * SkillsView — 技能页测试。照 memoryView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回裸数据。覆盖：已装清单 + 复用管理面
 * （scope 下拉 / 发现列表 / 复用与取消 / 档位单选 / 批量复用 / 预览）。
 * scope 默认全局；探测与链接数据加载失败静默降级，只有主清单失败走 notice。
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

const DISCOVERY = {
  sources: [
    { agent: "claude", dir: "/home/.claude/skills", stale: false },
    { agent: "custom", dir: "/w/extra-skills", stale: true },
  ],
  skills: [
    { name: "pdf", displayName: "pdf", description: "PDF 处理。", target: "/cc/pdf", sources: ["claude"], reused: false, conflict: false, stale: false },
    { name: "rival", displayName: "rival", description: "同名冲突。", target: "/cc/rival", sources: ["claude"], reused: false, conflict: true, stale: false },
    { name: "ghost", displayName: "ghost", description: "", target: "", sources: ["codex"], reused: false, conflict: false, stale: true },
    { name: "docs", displayName: "docs", description: "已复用。", target: "/cc/docs", sources: ["zcode"], reused: true, conflict: false, stale: false },
    { name: "parked", displayName: "parked", description: "他处复用。", target: "/cc/parked", sources: ["dsh"], reused: true, conflict: false, stale: false },
  ],
  projectSources: [],
}

const LINKS = { links: [{ name: "docs", target: "/cc/docs", agent: "zcode", tier: "all" }], extraSources: ["/w/extra-skills"] }

function fakeApi(over: Record<string, unknown> = {}): ApiClient & Record<"get" | "post" | "patch" | "del", ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/sessions") return [{ workdir: "/w/proj" }, { workdir: "/w/proj" }, { workdir: "/w/other" }, {}]
      if (path === "/skills") return ROWS
      if (path === "/skills/discovery") return DISCOVERY
      if (path === "/skills/links") return LINKS
      if (path === "/skills/commit-helper") return { name: "commit-helper", content: "# 提交规程\n\n一行标题。" }
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/skills/discovery/preview") return { name: "pdf", body: "PDF 预览正文" }
      return {}
    }),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => { throw new Error("unused") }),
    ...over,
  } as unknown as ApiClient & Record<"get" | "post" | "patch" | "del", ReturnType<typeof vi.fn>>
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(api: ApiClient, notice = () => {}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<SkillsView api={api} notice={notice} />)
  })
  await flush()
  return { container, root }
}

describe("SkillsView", () => {
  it("lists owned skills and the reuse surface on the default global scope", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/skills")
    expect(api.get).toHaveBeenCalledWith("/skills/discovery")
    expect(container.textContent).toContain("commit-helper")
    expect(container.textContent).toContain("提交规范。")
    expect(container.textContent).toContain("heavy-flow")
    expect(container.textContent).toContain("仅用户")
    // 复用管理面：发现条目 + 状态标 + 来源聚合
    expect(container.textContent).toContain("pdf")
    expect(container.textContent).toContain("Claude Code")
    expect(container.textContent).toContain("与已有技能同名冲突")
    expect(container.textContent).toContain("已失效")
    expect(container.textContent).toContain("已在其他作用域复用")
  })

  it("scope dropdown candidates come from session workdirs, deduplicated", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const select = container.querySelector<HTMLSelectElement>('[data-testid="scope-select"]')!
    expect([...select.options].map((o) => o.value)).toEqual(["", "/w/other", "/w/proj"])
  })

  it("clicking an owned skill opens its read-only body", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const item = container.querySelector<HTMLElement>('[data-testid="skill-commit-helper"]')!
    await act(async () => {
      item.click()
    })
    await flush()
    expect(api.get).toHaveBeenCalledWith("/skills/commit-helper")
    expect(container.textContent).toContain("# 提交规程")
  })

  it("clicking a discovered skill previews its body with a reuse action", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const item = container.querySelector<HTMLElement>('[data-testid="discover-pdf"]')!
    await act(async () => {
      item.click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/skills/discovery/preview", { path: "/cc/pdf" })
    expect(container.textContent).toContain("PDF 预览正文")
    expect(container.querySelector('[data-testid="reuse-preview"]')).not.toBeNull()
  })

  it("reusing posts a link with the scope and reloads", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const btn = container.querySelector<HTMLElement>('[data-testid="reuse-pdf"]')!
    await act(async () => {
      btn.click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "pdf", target: "/cc/pdf", agent: "claude", tier: "all", workdir: undefined })
    // 复用后刷新发现列表与链接清单
    expect(api.get).toHaveBeenCalledWith("/skills/links")
  })

  it("changing a link tier patches it and the batch action skips conflicted or reused rows", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const tier = container.querySelector<HTMLSelectElement>('[data-testid="tier-docs"]')!
    await act(async () => {
      tier.value = "off"
      tier.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
    expect(api.patch).toHaveBeenCalledWith("/skills/links/docs", { tier: "off", workdir: undefined })

    const all = container.querySelector<HTMLElement>('[data-testid="reuse-all"]')!
    await act(async () => {
      all.click()
    })
    await flush()
    // 仅 pdf 可批量复用（rival 冲突、ghost 失效、docs 已复用）
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "pdf", target: "/cc/pdf", agent: "claude", tier: "all", workdir: undefined })
  })

  it("canceling a reuse deletes the link", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    const btn = container.querySelector<HTMLElement>('[data-testid="unlink-docs"]')!
    await act(async () => {
      btn.click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledWith("/skills/links/docs")
  })

  it("empty listing points at the skill directories and the reuse surface", async () => {
    const api = fakeApi({ get: vi.fn(async (path: string) => (path === "/sessions" ? [] : path === "/skills/discovery" ? { sources: [], skills: [], projectSources: [] } : path === "/skills/links" ? { links: [], extraSources: [] } : [])) })
    const { container } = await mount(api)
    expect(container.textContent).toContain("还没有技能")
    expect(container.textContent).toContain(".kclaw/skills")
    expect(container.textContent).toContain("未发现可复用的技能")
  })

  it("main list failure lands in the notice area while the reuse surface degrades silently", async () => {
    const api = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path === "/sessions") return []
        if (path === "/skills/discovery") throw new Error("HTTP 503")
        if (path === "/skills/links") throw new Error("HTTP 503")
        throw new Error("HTTP 503")
      }),
    })
    const notice = vi.fn()
    await mount(api, notice)
    expect(notice.mock.calls.some(([t]) => String(t).includes("加载技能失败"))).toBe(true)
  })
})
