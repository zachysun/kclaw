/**
 * SkillsView — 技能页测试。照 memoryView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回裸数据。两个子页签：默认「已装技能」，
 * 「从其他 agent 复用」页签承载发现列表（搜索/分组）、已建链接表格与批量
 * 复用。scope 默认全局；探测与链接数据加载失败静默降级，只有主清单失败走
 * notice。
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
    { agent: "dsh", dir: "/home/.dsh/skills", stale: true },
  ],
  skills: [
    { name: "pdf", displayName: "pdf", description: "PDF 处理。", target: "/cc/pdf", sources: ["claude"], reused: false, conflict: false, stale: false },
    { name: "rival", displayName: "rival", description: "同名冲突。", target: "/cc/rival", sources: ["claude"], reused: false, conflict: true, stale: false },
    { name: "ghost", displayName: "ghost", description: "", target: "", sources: ["codex"], reused: false, conflict: false, stale: true },
    { name: "docs", displayName: "docs", description: "已复用。", target: "/cc/docs", sources: ["zcode"], reused: true, conflict: false, stale: false },
    { name: "parked", displayName: "parked", description: "他处复用。", target: "/cc/parked", sources: ["dsh"], reused: true, conflict: false, stale: false },
    { name: "tdd", displayName: "tdd", description: "插件技能。", target: "/plugins/tdd", sources: ["zcode"], plugin: "superpowers", reused: false, conflict: false, stale: false },
    { name: "grill", displayName: "grill", description: "插件技能二。", target: "/plugins/grill", sources: ["zcode"], plugin: "superpowers", reused: false, conflict: false, stale: false },
  ],
  projectSources: [],
}

const LINKS = {
  links: [
    { name: "docs", target: "/cc/docs", agent: "zcode", tier: "all", current: true },
    { name: "stale-link", target: "/plugins/old/tdd", agent: "zcode", tier: "off", current: false },
  ],
  extraSources: ["/w/extra-skills"],
}

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

async function openReuseTab(container: HTMLElement): Promise<void> {
  const tab = container.querySelector<HTMLElement>('[data-testid="subtab-reuse"]')!
  await act(async () => {
    tab.click()
  })
  await flush()
}

describe("SkillsView", () => {
  it("shows owned skills on the default tab and the reuse tab carries a badge", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/skills")
    // 默认页签：已装清单，发现列表不可见
    expect(container.textContent).toContain("commit-helper")
    expect(container.textContent).toContain("提交规范。")
    expect(container.textContent).toContain("heavy-flow")
    expect(container.textContent).toContain("仅用户")
    expect(container.querySelector('[data-testid="discover-pdf"]')).toBeNull()
    expect(container.querySelector('[data-testid="subtab-reuse"]')!.textContent).toContain("（3）")
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

  it("reuse tab splits discovery into two sections: agent dirs open, plugin groups collapsed, searchable", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
    // 两个区块：用户级技能目录（展开）与已安装插件（折叠）
    const sections = [...container.querySelectorAll(".skills-section-title")]
    expect(sections.map((s) => s.childNodes[0]!.textContent)).toEqual(["用户级技能目录", "已安装插件"])
    const agentSection = sections[0]!.closest(".skills-section")!
    const pluginSection = sections[1]!.closest(".skills-section")!
    const agentGroups = [...agentSection.querySelectorAll("details.discover-group")]
    const pluginGroups = [...pluginSection.querySelectorAll("details.discover-group")]
    const agentGroupNames = agentGroups.map((d) => d.querySelector(".group-label")!.textContent)
    expect(agentGroupNames).toEqual(["Claude Code（2）", "Codex（1）", "zCode（1）", "DeepSeek（1）"])
    const pluginGroupNames = pluginGroups.map((d) => d.querySelector(".group-label")!.textContent)
    expect(pluginGroupNames).toEqual(["superpowers（2）"])
    expect(agentGroups.every((d) => (d as HTMLDetailsElement).open)).toBe(true)
    expect(pluginGroups.every((d) => (d as HTMLDetailsElement).open)).toBe(false)
    // 搜索命中插件技能：命中组保留并强制展开，未命中条目被滤掉。
    // React 受控 input 必须经原生 value setter 触发（直接赋值不触发 onChange）。
    const input = container.querySelector<HTMLInputElement>('[data-testid="discover-search"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(input, "tdd")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await flush()
    expect(container.textContent).toContain("tdd")
    const filteredGroup = [...container.querySelectorAll("details.discover-group")].find((d) => d.textContent!.includes("superpowers"))!
    expect((filteredGroup as HTMLDetailsElement).open).toBe(true)
    expect(filteredGroup.querySelector('[data-testid="discover-grill"]')).toBeNull()
    // 用户级区在搜索无命中时整区消失
    const sectionsAfter = [...container.querySelectorAll(".skills-section-title")].map((s) => s.childNodes[0]!.textContent)
    expect(sectionsAfter).toEqual(["已安装插件"])
  })

  it("plugin group titles carry origin agents and offer group-level reuse-all / unlink-all", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
    const pluginGroup = [...container.querySelectorAll("details.discover-group")].find((d) => d.textContent!.includes("superpowers"))!
    // 组标题带来源 agent（组内条目来源的并集）
    expect(pluginGroup.querySelector(".group-origins")!.textContent).toBe("zCode")
    // 组级按钮存在且可点
    const reuseAll = pluginGroup.querySelector<HTMLElement>('[data-testid="group-reuse-superpowers"]')!
    expect(reuseAll).not.toBeNull()
    await act(async () => {
      reuseAll.click()
    })
    await flush()
    // 组内未复用无冲突的 tdd、grill 都被建链
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "tdd", target: "/plugins/tdd", agent: "zcode", tier: "all", workdir: undefined })
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "grill", target: "/plugins/grill", agent: "zcode", tier: "all", workdir: undefined })
    // 区块级按钮：fake 的 links 记录不回写（tdd/grill 刚建链但记录里没有、
    // docs 属用户级不在插件区块），区块级删除作用范围内无可删，del 不发生
    const sectionUnlinkAll = container.querySelector<HTMLElement>('[data-testid="plugin-unlink-all"]')!
    expect(sectionUnlinkAll).not.toBeNull()
    const delCallsBefore = api.del.mock.calls.length
    await act(async () => {
      sectionUnlinkAll.click()
    })
    await flush()
    expect(api.del).toHaveBeenCalledTimes(delCallsBefore)
  })

  it("built-in source missing shows neutral unused mark; custom source missing shows stale warning", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
    const badges = [...container.querySelectorAll(".skill-source")]
    const dsh = badges.find((b) => b.textContent!.includes("DeepSeek"))!
    const custom = badges.find((b) => b.textContent!.includes("自定义目录"))!
    expect(dsh.textContent).toContain("（未使用）")
    expect(custom.textContent).toContain("（已失效）")
  })

  it("reuse tab shows status marks and the links table with the outdated badge", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
    expect(container.textContent).toContain("与已有技能同名冲突")
    expect(container.textContent).toContain("已失效")
    expect(container.textContent).toContain("已在其他作用域复用")
    expect(container.querySelector('[data-testid="links-table"]')).not.toBeNull()
    expect(container.textContent).toContain("已过时")
  })

  it("clicking a discovered skill previews its body with a reuse action", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
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
    await openReuseTab(container)
    const btn = container.querySelector<HTMLElement>('[data-testid="reuse-pdf"]')!
    await act(async () => {
      btn.click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "pdf", target: "/cc/pdf", agent: "claude", tier: "all", workdir: undefined })
    expect(api.get).toHaveBeenCalledWith("/skills/links")
  })

  it("changing a link tier patches it and the batch action skips conflicted, stale, reused rows", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
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
    // 仅 pdf/tdd/grill 可批量复用（rival 冲突、ghost 失效、docs/parked 已复用）
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "pdf", target: "/cc/pdf", agent: "claude", tier: "all", workdir: undefined })
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "tdd", target: "/plugins/tdd", agent: "zcode", tier: "all", workdir: undefined })
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ name: "rival" }))
  })

  it("canceling a reuse deletes the link", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openReuseTab(container)
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
    await openReuseTab(container)
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
