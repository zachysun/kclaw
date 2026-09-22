/**
 * SkillsView — 技能页测试。照 memoryView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回裸数据。两个子页签：默认「已装技能」，
 * 「从其他 agent 复用」页签承载发现列表（搜索/分组）、已建链接表格与批量
 * 复用，「提案」页签承载技能进化的治理面（角标、按状态显隐的操作按钮、
 * 修订对照、warning toast）。scope 默认全局；探测与链接数据加载失败静默
 * 降级，只有主清单失败走 notice。
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
  { name: "tdd", displayName: "tdd", description: "插件复用技能。", visibility: "all", origin: "global", plugin: "superpowers" },
]

const DISCOVERY = {
  sources: [
    { agent: "claude", dir: "/home/.claude/skills", stale: false },
    { agent: "custom", dir: "/w/extra-skills", stale: true },
    { agent: "dsh", dir: "/home/.dsh/skills", stale: true },
  ],
  skills: [
    { name: "pdf", displayName: "pdf", description: "PDF 处理。", target: "/cc/pdf", sources: ["claude"], suggestedTier: "all", reused: false, conflict: false, stale: false },
    { name: "rival", displayName: "rival", description: "同名冲突。", target: "/cc/rival", sources: ["claude"], suggestedTier: "all", reused: false, conflict: true, stale: false },
    { name: "ghost", displayName: "ghost", description: "", target: "", sources: ["codex"], suggestedTier: "all", reused: false, conflict: false, stale: true },
    { name: "docs", displayName: "docs", description: "已复用。", target: "/cc/docs", sources: ["zcode"], suggestedTier: "all", reused: true, conflict: false, stale: false },
    { name: "parked", displayName: "parked", description: "他处复用。", target: "/cc/parked", sources: ["dsh"], suggestedTier: "all", reused: true, conflict: false, stale: false },
    { name: "tdd", displayName: "tdd", description: "插件技能。", target: "/plugins/tdd", sources: ["zcode"], plugin: "superpowers", suggestedTier: "user", reused: false, conflict: false, stale: false },
    { name: "grill", displayName: "grill", description: "插件技能二。", target: "/plugins/grill", sources: ["zcode"], plugin: "superpowers", suggestedTier: "all", reused: false, conflict: false, stale: false },
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

const PROPOSALS = [
  {
    id: "1730000000000-new-kit", status: "proposed", kind: "new", name: "new-kit", scope: "project", workdir: "/w/proj",
    title: "新技能", rationale: "反复出现的做法", content: "---\ndescription: d\n---\n新正文", source: "follow", sourceSessionId: "s1",
    createdAt: "2026-09-21T08:30:00.000Z",
  },
  {
    id: "1730000000001-old-kit", status: "applied", kind: "revise", name: "old-kit", scope: "global",
    title: "old-kit", rationale: "", changes: "改了第 2 步", content: "V2 正文", baseline: "V1 正文",
    source: "skill_create", sourceSessionId: "s1", createdAt: "2026-09-21T07:00:00.000Z",
    decidedAt: "2026-09-21T07:10:00.000Z", appliedAt: "2026-09-21T07:10:00.000Z", usage: 4,
  },
]

function fakeApi(over: Record<string, unknown> = {}): ApiClient & Record<"get" | "post" | "patch" | "del", ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/sessions") return [{ workdir: "/w/proj" }, { workdir: "/w/proj" }, { workdir: "/w/other" }, {}]
      if (path === "/skills") return ROWS
      if (path === "/skills/discovery") return DISCOVERY
      if (path === "/skills/links") return LINKS
      if (path === "/skills/proposals") return { proposals: PROPOSALS }
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
    // setImmediate 与 React act 收尾用的 enqueueTask 同源（node timers）：
    // 等 flush 内的 promise 落定要走同一条宏任务通道，否则下一个 act 进场
    // 会撞上前一个 act 未排空的队列（overlapping act，后续 render 被丢弃）。
    await new Promise((resolve) => setImmediate(resolve))
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
    // 插件复用技能在已装清单里带归属说明
    expect(container.textContent).toContain("来自插件 superpowers")
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
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "tdd", target: "/plugins/tdd", agent: "zcode", tier: "user", plugin: "superpowers", workdir: undefined })
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "grill", target: "/plugins/grill", agent: "zcode", tier: "all", plugin: "superpowers", workdir: undefined })
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
    // 源档位非"完全可见"的条目带提示（tdd 的源 frontmatter 是仅用户）
    expect(container.textContent).toContain("源档位 仅用户")
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
    expect(api.post).toHaveBeenCalledWith("/skills/links", { name: "tdd", target: "/plugins/tdd", agent: "zcode", tier: "user", plugin: "superpowers", workdir: undefined })
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

describe("SkillsView proposals tab（提案面）", () => {
  async function openProposalsTab(container: HTMLElement): Promise<void> {
    const tab = container.querySelector<HTMLElement>('[data-testid="subtab-proposals"]')!
    await act(async () => {
      tab.click()
    })
    await flush()
  }

  async function pickSelect(container: HTMLElement, testid: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)!
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
  }

  it("badge counts pending proposals; rows show status/kind/scope tail/time/usage; kind filter narrows", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    // 角标：仅 1 条待确认
    expect(container.querySelector('[data-testid="subtab-proposals"]')!.textContent).toContain("（1 待确认）")
    await openProposalsTab(container)
    expect(api.get).toHaveBeenCalledWith("/skills/proposals")
    // 行内：状态 + 种类 + 项目尾段 + 创建时间 + applied 用量
    expect(container.textContent).toContain("待确认")
    expect(container.textContent).toContain("新增 · 项目（proj）")
    // 创建时间按本地时区展示，期望值用同一 ISO 串本地算出，不钉死时区。
    const created = new Date("2026-09-21T08:30:00.000Z")
    const pad = (n: number) => String(n).padStart(2, "0")
    expect(container.textContent).toContain(
      `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`,
    )
    expect(container.textContent).toContain("被调用 4 次")
    // 种类筛选（本地过滤）：只看修订
    await pickSelect(container, "proposal-kind-filter", "revise")
    expect(container.querySelector('[data-testid="proposal-1730000000000-new-kit"]')).toBeNull()
    expect(container.querySelector('[data-testid="proposal-1730000000001-old-kit"]')).not.toBeNull()
    // 状态筛选走服务端 ?status= 参数
    await pickSelect(container, "proposal-status-filter", "applied")
    expect(api.get).toHaveBeenCalledWith("/skills/proposals?status=applied")
  })

  it("proposed rows offer apply/reject hitting POST; applied rows offer revert with usage", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openProposalsTab(container)
    // proposed：采纳/驳回可见
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-1730000000000-new-kit"]')!.click()
    })
    await flush()
    expect(container.querySelector('[data-testid="proposal-apply"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="proposal-reject"]')).not.toBeNull()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-apply"]')!.click()
    })
    await flush()
    expect(api.post).toHaveBeenCalledWith("/skills/proposals/1730000000000-new-kit/apply", {})
    // applied：回退 + 用量，无采纳/驳回
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-1730000000001-old-kit"]')!.click()
    })
    await flush()
    expect(container.querySelector('[data-testid="proposal-revert"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="proposal-apply"]')).toBeNull()
    expect(container.textContent).toContain("采纳后被调用 4 次")
  })

  it("revise detail renders the baseline and candidate content side by side", async () => {
    const api = fakeApi()
    const { container } = await mount(api)
    await openProposalsTab(container)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-1730000000001-old-kit"]')!.click()
    })
    await flush()
    expect(container.textContent).toContain("当前正文（对照）")
    expect(container.textContent).toContain("提案内容（完整 SKILL.md）")
    expect(container.textContent).toContain("V1 正文")
    expect(container.textContent).toContain("V2 正文")
    expect(container.textContent).toContain("改了第 2 步")
  })

  it("apply warning surfaces as a notice", async () => {
    const api = fakeApi({
      post: vi.fn(async (path: string) => (path === "/skills/discovery/preview" ? { name: "pdf", body: "" } : { ok: true, warning: "项目 /w/proj 存在同名技能，将在该项目遮蔽全局版本" })),
    })
    const notice = vi.fn()
    const { container } = await mount(api, notice)
    await openProposalsTab(container)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-1730000000000-new-kit"]')!.click()
    })
    await flush()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="proposal-apply"]')!.click()
    })
    await flush()
    expect(notice.mock.calls.some(([t]) => String(t).includes("遮蔽全局版本"))).toBe(true)
  })
})
