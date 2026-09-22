/**
 * SkillsView — 技能页：三个子页签。
 *
 * 「已装技能」：左栏技能清单（名字 / 作用域 / 可见性标记 / 截断两行的描
 * 述），右栏点开后的 SKILL.md 正文。user-invocable:false 的技能服务端已
 * 当作不存在（列表与点名都不出现）。
 *
 * 「从其他 agent 复用」：复用管理面——顶部已建链接的紧凑表格（来源、四
 * 档可见档位单选、删除；链接目标不再是探测正在提供的版本时标"过时"），
 * 下方探测发现列表：搜索框 + 按来源分组折叠（用户级 agent 目录展开、插
 * 件技能折叠），每条可预览正文、单个复用或批量复用。复用的元数据（目标/
 * 来源/档位）在服务端 .links.json，外部 SKILL.md 一字不动；复用链接的管
 * 理记录不受用户可见性过滤影响（否则"仅模型"档改不回）。
 *
 * 「提案」（技能进化，提案制）：后台提炼/skill_create 产出的待确认技能变
 * 更全部落在这里，未经确认绝不进入技能目录。列表按状态展示，操作随状态
 * 显隐：待确认可采纳/驳回，已采纳可回退（并显示采纳后的调用次数），已驳
 * 回/已回退可删除。提案自带 workdir/scope，与顶部作用域下拉无关。
 *
 * 顶部作用域下拉（默认全局，候选来自会话列表的工作目录）对前两个页签共同
 * 生效，与 run 时注入同源同规则。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type React from "react"
import type { ApiClient } from "../api.js"
import type { NoticeFn } from "../toast.js"
import type { SkillProposalRow } from "@kclaw/core/protocol"

interface SkillRow {
  name: string
  displayName: string
  description: string
  visibility: "all" | "user-only"
  origin: "global" | "project"
  /** 复用链接技能所属的插件（自有技能无此字段）。 */
  plugin?: string
}

interface DiscoveredSkill {
  name: string
  displayName: string
  description: string
  target: string
  sources: string[]
  plugin?: string
  /** 源 SKILL.md 可见性字段映射出的档位——复用时的默认档位，尊重作者意图。 */
  suggestedTier: "all" | "user" | "model" | "off"
  reused: boolean
  conflict: boolean
  stale: boolean
}

interface DiscoveryPayload {
  sources: { agent: string; dir: string; stale: boolean }[]
  skills: DiscoveredSkill[]
  projectSources: { agent: string; dir: string; stale: boolean }[]
}

interface LinkRecord {
  name: string
  target: string
  agent: string
  tier: "all" | "user" | "model" | "off"
  /** false = 目标已不是探测正在提供的版本（插件升级过）——链接可用但过时。 */
  current?: boolean
}

interface LinksPayload {
  links: LinkRecord[]
  extraSources: string[]
}

/** 复用来源与可见档位的中文标签（接口仍是服务端约定的小写枚举）。 */
const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", dsh: "DeepSeek", zcode: "zCode", custom: "自定义目录" }
const TIER_LABEL: Record<LinkRecord["tier"], string> = { all: "完全可见", user: "仅用户", model: "仅模型", off: "暂不启用" }
const TIERS: LinkRecord["tier"][] = ["all", "user", "model", "off"]

/** 提案行（GET /skills/proposals）：形状即 protocol 正本 SkillProposalRow
 * （完整提案字段 + applied 时的用量口径），本地不再手抄镜像。 */

const PROPOSAL_STATUS_LABEL: Record<SkillProposalRow["status"], string> = { proposed: "待确认", applied: "已采纳", rejected: "已驳回", reverted: "已回退" }
const PROPOSAL_KIND_LABEL: Record<SkillProposalRow["kind"], string> = { new: "新增", revise: "修订" }
const PROPOSAL_SCOPE_LABEL: Record<SkillProposalRow["scope"], string> = { global: "全局", project: "项目" }

type SubTab = "installed" | "reuse" | "proposals"

export function SkillsView({ api, notice }: {
  api: ApiClient
  notice: NoticeFn
}) {
  // notice 走 ref：App 传内联箭头，每次父组件重渲染都是新引用；若 reload 依赖
  // notice，停留本页会反复拉取（MemoryView 曾犯过的同类审查问题，同款防御）。
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  // scope 为空串表示全局；项目下拉的候选从会话列表的 workdir 去重而来。
  const [scope, setScope] = useState("")
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [subTab, setSubTab] = useState<SubTab>("installed")
  const [rows, setRows] = useState<SkillRow[] | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryPayload | null>(null)
  const [links, setLinks] = useState<LinksPayload | null>(null)
  const [proposals, setProposals] = useState<SkillProposalRow[] | null>(null)
  const [proposalId, setProposalId] = useState<string | null>(null)
  // 状态筛选走服务端 ?status=（路由已支持）；种类筛选是本地过滤（数据量小）。
  const [proposalStatus, setProposalStatus] = useState<"all" | SkillProposalRow["status"]>("all")
  const [proposalKind, setProposalKind] = useState<"all" | SkillProposalRow["kind"]>("all")
  const [body, setBody] = useState<{ title: string; content: string; reusable?: DiscoveredSkill } | null>(null)
  const [newSource, setNewSource] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)

  const scopeQuery = scope !== "" ? `?workdir=${encodeURIComponent(scope)}` : ""
  const proposalQuery = proposalStatus === "all" ? "" : `?status=${proposalStatus}`

  const reloadProposals = useCallback(() => {
    // 提案面：全局数据（提案自带 workdir/scope），拉取失败行内降级。
    api
      .get<{ proposals: SkillProposalRow[] }>(`/skills/proposals${proposalQuery}`)
      .then((r) => setProposals(r.proposals))
      .catch(() => setProposals(null))
  }, [api, proposalQuery])
  useEffect(() => { reloadProposals() }, [reloadProposals])

  useEffect(() => {
    // 会话 workdir 集合只影响下拉候选，拉取失败静默（下拉退化为仅全局）。
    api
      .get<{ workdir?: string }[]>("/sessions")
      .then((metas) => {
        const set = new Set<string>()
        for (const m of metas) if (typeof m.workdir === "string" && m.workdir !== "") set.add(m.workdir)
        setWorkdirs([...set].sort())
      })
      .catch(() => {})
  }, [api])

  const reload = useCallback(() => {
    api.get<SkillRow[]>(`/skills${scopeQuery}`).then(setRows).catch((e) => noticeRef.current(`加载技能失败: ${String(e)}`, "error"))
    // 复用管理面的三份数据失败都走行内降级，不打扰主清单的 notice。
    api.get<DiscoveryPayload>(`/skills/discovery${scopeQuery}`).then(setDiscovery).catch(() => setDiscovery(null))
    api.get<LinksPayload>(`/skills/links${scopeQuery}`).then(setLinks).catch(() => setLinks(null))
    // 提案面不挂在这里：它有自己的 effect 与写后刷新（reloadProposals），避免
    // proposalQuery 变化连带主清单三份数据重拉、挂载时提案重复请求。
  }, [api, scopeQuery])
  useEffect(() => { reload() }, [reload])

  const refreshAfterWrite = useCallback((message: string) => {
    noticeRef.current(message)
    reload()
  }, [reload])

  const open = async (name: string): Promise<void> => {
    try {
      const res = await api.get<{ name: string; content: string }>(`/skills/${encodeURIComponent(name)}${scopeQuery}`)
      setBody({ title: res.name, content: res.content })
    } catch (e) {
      notice(`读取技能失败: ${String(e)}`, "error")
    }
  }

  const preview = async (item: DiscoveredSkill): Promise<void> => {
    if (item.stale) return
    try {
      const res = await api.post<{ name: string; body: string }>("/skills/discovery/preview", { path: item.target })
      setBody({ title: res.name, content: res.body, reusable: item })
    } catch (e) {
      notice(`读取技能失败: ${String(e)}`)
    }
  }

  const reuse = async (item: DiscoveredSkill, tier: LinkRecord["tier"] = item.suggestedTier ?? "all"): Promise<void> => {
    setBusy(true)
    try {
      await api.post("/skills/links", { name: item.name, target: item.target, agent: item.sources[0] ?? "custom", tier, plugin: item.plugin, workdir: scope !== "" ? scope : undefined })
      setBody(null)
      refreshAfterWrite(`已复用 ${item.name}`)
    } catch (e) {
      notice(`复用失败: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const unlink = async (name: string): Promise<void> => {
    setBusy(true)
    try {
      await api.del(`/skills/links/${encodeURIComponent(name)}${scopeQuery}`)
      refreshAfterWrite(`已取消复用 ${name}`)
    } catch (e) {
      notice(`取消复用失败: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const setTier = async (name: string, tier: LinkRecord["tier"]): Promise<void> => {
    setBusy(true)
    try {
      await api.patch(`/skills/links/${encodeURIComponent(name)}`, { tier, workdir: scope !== "" ? scope : undefined })
      reload()
    } catch (e) {
      notice(`改档位失败: ${String(e)}`, "error")
      reload()
    } finally {
      setBusy(false)
    }
  }

  const reuseMany = async (label: string, items: DiscoveredSkill[]): Promise<void> => {
    const candidates = items.filter((s) => !s.reused && !s.conflict && !s.stale)
    if (candidates.length === 0) {
      notice("没有可批量复用的技能（其余均已复用或存在冲突）")
      return
    }
    setBusy(true)
    let ok = 0
    for (const item of candidates) {
      try {
        await api.post("/skills/links", { name: item.name, target: item.target, agent: item.sources[0] ?? "custom", tier: item.suggestedTier ?? "all", plugin: item.plugin, workdir: scope !== "" ? scope : undefined })
        ok += 1
      } catch {
        // 单条失败不中断批量，结束后统一刷新并提示。
      }
    }
    setBusy(false)
    refreshAfterWrite(`批量复用完成（${label}）：${ok}/${candidates.length}`)
  }

  const unlinkMany = async (label: string, items: DiscoveredSkill[]): Promise<void> => {
    const linked = items.filter((s) => linkNames.has(s.name))
    if (linked.length === 0) {
      notice(`${label}没有已复用的链接可删除`)
      return
    }
    setBusy(true)
    let ok = 0
    for (const item of linked) {
      try {
        await api.del(`/skills/links/${encodeURIComponent(item.name)}${scopeQuery}`)
        ok += 1
      } catch {
        // 单条失败不中断批量。
      }
    }
    setBusy(false)
    refreshAfterWrite(`批量删除完成（${label}）：${ok}/${linked.length}`)
  }

  const reuseAll = (): Promise<void> => reuseMany("全部", reusableRows)

  const addSource = async (): Promise<void> => {
    const dir = newSource.trim()
    if (dir === "") return
    setBusy(true)
    try {
      await api.post("/skills/sources", { dir, workdir: scope !== "" ? scope : undefined })
      setNewSource("")
      reload()
    } catch (e) {
      notice(`添加探测目录失败: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const removeSource = async (dir: string): Promise<void> => {
    setBusy(true)
    try {
      await api.del(`/skills/sources${scopeQuery}${scopeQuery === "" ? "?" : "&"}dir=${encodeURIComponent(dir)}`)
      reload()
    } catch (e) {
      notice(`移除探测目录失败: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const linkNames = new Set((links?.links ?? []).map((l) => l.name))
  const reusableRows = discovery?.skills ?? []
  const discoveredCount = reusableRows.filter((s) => !s.reused && !s.conflict && !s.stale).length

  // ---- 提案面（技能进化） --------------------------------------------------
  // 行列表 = 服务端状态筛选结果再做本地种类过滤；角标按服务端返回全集算。
  const proposalRows = (proposals ?? []).filter((p) => proposalKind === "all" || p.kind === proposalKind)
  const pendingCount = (proposals ?? []).filter((p) => p.status === "proposed").length
  const selectedProposal = proposalRows.find((p) => p.id === proposalId) ?? (proposalKind === "all" ? (proposals ?? []).find((p) => p.id === proposalId) ?? null : null)

  /** 项目落点的展示尾段：多项目时区分落点（全局无 workdir）。 */
  const workdirTail = (wd: string | undefined): string => {
    if (wd === undefined || wd === "") return ""
    return wd.split("/").filter(Boolean).pop() ?? wd
  }
  /** ISO → 本地时区 "YYYY-MM-DD HH:mm"（列表行足够，不需要秒）。 */
  const shortTime = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const proposalAction = async (p: SkillProposalRow, op: "apply" | "reject" | "revert"): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.post<{ ok: boolean; warning?: string }>(`/skills/proposals/${encodeURIComponent(p.id)}/${op}`, {})
      if (res.warning !== undefined) notice(res.warning) // 非致命提示（如全局提案被某项目同名技能遮蔽）
      const verb = op === "apply" ? "已采纳" : op === "reject" ? "已驳回" : "已回退"
      notice(`提案 ${p.name} ${verb}`)
      reload()
      reloadProposals()
    } catch (e) {
      notice(`操作失败: ${String(e)}`, "error")
      reload()
    } finally {
      setBusy(false)
    }
  }

  const removeProposal = async (p: SkillProposalRow): Promise<void> => {
    setBusy(true)
    try {
      await api.del(`/skills/proposals/${encodeURIComponent(p.id)}`)
      setProposalId(null)
      notice(`已删除提案 ${p.name}`)
      reloadProposals()
    } catch (e) {
      notice(`删除失败: ${String(e)}`, "error")
      reload()
    } finally {
      setBusy(false)
    }
  }

  // 发现列表分两个区块，层级对齐心智模型：
  //   「用户级技能目录」按 agent 分组（展开）——用户亲手放的技能；
  //   「已安装插件」按插件分组（折叠）——插件带给你的技能。
  // 搜索词过滤名字与描述，命中时全部组展开。
  const filtering = search.trim() !== ""
  const matches = (s: DiscoveredSkill): boolean => {
    const word = search.trim().toLowerCase()
    return word === "" || s.name.toLowerCase().includes(word) || s.description.toLowerCase().includes(word) || (s.plugin ?? "").toLowerCase().includes(word)
  }
  const agentGroups = useMemo(() => {
    const map = new Map<string, { label: string; items: DiscoveredSkill[] }>()
    for (const s of reusableRows) {
      if (s.plugin !== undefined || !matches(s)) continue
      const key = s.sources[0] ?? "custom"
      const hit = map.get(key)
      if (hit !== undefined) hit.items.push(s)
      else map.set(key, { label: AGENT_LABEL[key] ?? key, items: [s] })
    }
    return [...map.values()]
  }, [reusableRows, search])
  const pluginGroups = useMemo(() => {
    const map = new Map<string, { label: string; items: DiscoveredSkill[] }>()
    for (const s of reusableRows) {
      if (s.plugin === undefined || !matches(s)) continue
      const hit = map.get(s.plugin)
      if (hit !== undefined) hit.items.push(s)
      else map.set(s.plugin, { label: s.plugin, items: [s] })
    }
    return [...map.values()]
  }, [reusableRows, search])

  return (
    <div className="skills-view" data-testid="skills-view">
      <div className="skills-scope-row">
        <label className="skills-scope">
          作用域
          <select data-testid="scope-select" value={scope} onChange={(e) => { setScope(e.target.value); setBody(null) }}>
            <option value="">全局</option>
            {workdirs.map((wd) => (
              <option key={wd} value={wd}>{wd}</option>
            ))}
          </select>
        </label>
        {busy && <span className="muted">处理中…</span>}
        <div className="skills-subtabs" role="tablist">
          <button type="button" role="tab" aria-selected={subTab === "installed"} data-testid="subtab-installed" className={subTab === "installed" ? "active" : ""} onClick={() => { setSubTab("installed"); setBody(null) }}>已装技能</button>
          <button type="button" role="tab" aria-selected={subTab === "reuse"} data-testid="subtab-reuse" className={subTab === "reuse" ? "active" : ""} onClick={() => { setSubTab("reuse"); setBody(null) }}>
            从其他 agent 复用{discoveredCount > 0 ? `（${discoveredCount}）` : ""}
          </button>
          <button type="button" role="tab" aria-selected={subTab === "proposals"} data-testid="subtab-proposals" className={subTab === "proposals" ? "active" : ""} onClick={() => { setSubTab("proposals"); setBody(null) }}>
            提案{pendingCount > 0 ? `（${pendingCount} 待确认）` : ""}
          </button>
        </div>
      </div>

      {subTab === "installed" ? (
        <div className="skills-panes">
          <div className="skills-list">
            {rows === null ? (
              <p className="muted">加载中…</p>
            ) : rows.length === 0 ? (
              <p className="muted">
                还没有技能。把技能目录放进 <code>~/.kclaw/skills/</code>（全局）或工作区的
                <code>.kclaw/skills/</code>（本项目），或到「从其他 agent 复用」页签一键接入。
              </p>
            ) : (
              <ul>
                {rows.map((r) => (
                  <li key={r.name}>
                    <button
                      type="button"
                      data-testid={`skill-${r.name}`}
                      className={body?.title === r.name && body.reusable === undefined ? "skill-item active" : "skill-item"}
                      onClick={() => void open(r.name)}
                    >
                      <span className="skill-name">{r.name}</span>
                      <span className="skill-meta">
                        {r.origin === "project" ? "项目" : "全局"}
                        {r.plugin !== undefined ? ` · 来自插件 ${r.plugin}` : ""}
                        {r.visibility === "user-only" ? " · 仅用户" : ""}
                      </span>
                      <span className="skill-desc clamp2">{r.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="skills-body">
            {body === null ? (
              <p className="muted">选择一个技能查看完整说明</p>
            ) : (
              <>
                <h3>{body.title}</h3>
                <pre>{body.content}</pre>
              </>
            )}
          </div>
        </div>
      ) : subTab === "proposals" ? (
        <div className="skills-panes" data-testid="proposals-pane">
          <div className="skills-list">
            <div className="skills-toolbar">
              <select
                data-testid="proposal-status-filter"
                value={proposalStatus}
                onChange={(e) => setProposalStatus(e.target.value as typeof proposalStatus)}
              >
                <option value="all">全部状态</option>
                {(["proposed", "applied", "rejected", "reverted"] as const).map((s) => (
                  <option key={s} value={s}>{PROPOSAL_STATUS_LABEL[s]}</option>
                ))}
              </select>
              <select
                data-testid="proposal-kind-filter"
                value={proposalKind}
                onChange={(e) => setProposalKind(e.target.value as typeof proposalKind)}
              >
                <option value="all">全部种类</option>
                {(["new", "revise"] as const).map((k) => (
                  <option key={k} value={k}>{PROPOSAL_KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            {proposalRows.length === 0 ? (
              <p className="muted">
                {proposals !== null && (proposals ?? []).length > 0
                  ? "没有匹配筛选条件的提案。"
                  : "还没有提案。开启技能进化（配置 skills.evolution.enabled）后，用了技能的会话会在空闲时提炼经验形成提案；对话里模型也可通过 skill_create 主动提案。提案只是候选，未经你确认不会进入技能目录。"}
              </p>
            ) : (
              <ul>
                {proposalRows.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      data-testid={`proposal-${p.id}`}
                      className={proposalId === p.id ? "skill-item active" : "skill-item"}
                      onClick={() => setProposalId(p.id)}
                    >
                      <span className="skill-name">{p.name}</span>
                      <span className="skill-meta">
                        {PROPOSAL_STATUS_LABEL[p.status]}
                        {" · "}
                        {PROPOSAL_KIND_LABEL[p.kind]} · {p.scope === "project" ? `项目（${workdirTail(p.workdir)}）` : PROPOSAL_SCOPE_LABEL[p.scope]}
                        {" · "}
                        {shortTime(p.createdAt)}
                        {p.usage !== undefined ? ` · 被调用 ${p.usage} 次` : ""}
                      </span>
                      <span className="skill-desc clamp2">{p.rationale !== "" ? p.rationale : p.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="skills-body">
            {selectedProposal === null ? (
              <p className="muted">选择一个提案查看详情；待确认的提案在此采纳或驳回，已采纳的可回退</p>
            ) : (
              (() => {
                const p = selectedProposal
                const metaBits = [
                  PROPOSAL_STATUS_LABEL[p.status],
                  `来源：${p.source === "follow" ? "空闲提炼" : "模型 skill_create"}`,
                  `落点：${PROPOSAL_SCOPE_LABEL[p.scope]}${p.workdir !== undefined ? `（${p.workdir}）` : ""}`,
                  `创建于 ${shortTime(p.createdAt)}`,
                ]
                return (
                  <>
                    <h3>
                      {p.title}
                      {p.status === "proposed" && (
                        <span className="section-actions">
                          <button type="button" data-testid="proposal-apply" disabled={busy} onClick={() => void proposalAction(p, "apply")}>采纳</button>
                          <button type="button" data-testid="proposal-reject" disabled={busy} onClick={() => void proposalAction(p, "reject")}>驳回</button>
                        </span>
                      )}
                      {p.status === "applied" && (
                        <span className="section-actions">
                          <button type="button" data-testid="proposal-revert" disabled={busy} onClick={() => void proposalAction(p, "revert")}>回退</button>
                          <span className="muted">采纳后被调用 {p.usage ?? 0} 次</span>
                        </span>
                      )}
                      {(p.status === "rejected" || p.status === "reverted") && (
                        <span className="section-actions">
                          <button type="button" data-testid="proposal-remove" disabled={busy} onClick={() => void removeProposal(p)}>删除</button>
                        </span>
                      )}
                    </h3>
                    <p className="muted">{metaBits.join(" · ")}</p>
                    {p.rationale !== "" && (
                      <p>
                        <strong>为什么提案：</strong>
                        {p.rationale}
                      </p>
                    )}
                    {p.changes !== undefined && p.changes !== "" && (
                      <p>
                        <strong>改了哪里：</strong>
                        {p.changes}
                      </p>
                    )}
                    {/* 修订提案的对照视图：提案时看到的正文 vs 提案内容；applied
                        后对照改为回退快照（apply 前一刻的真实正文）。 */}
                    {(p.baseline !== undefined || p.snapshot !== undefined) && (
                      <details className="proposal-baseline" open>
                        <summary>{p.snapshot !== undefined ? "回退快照（apply 前的正文）" : "当前正文（对照）"}</summary>
                        <pre>{p.snapshot ?? p.baseline}</pre>
                      </details>
                    )}
                    <details className="proposal-content" open>
                      <summary>提案内容（完整 SKILL.md）</summary>
                      <pre>{p.content}</pre>
                    </details>
                  </>
                )
              })()
            )}
          </div>
        </div>
      ) : (
        <div className="skills-reuse">
          {links !== null && links.links.length > 0 && (
            <div className="skills-links" data-testid="links-table">
              <h4 className="skills-seg-title">已建链接<span className="muted">（复用技能的可见档位）</span></h4>
              <table className="links-table">
                <tbody>
                  {links.links.map((l) => (
                    <tr key={l.name} data-testid={`link-${l.name}`}>
                      <td className="link-name">{l.name}</td>
                      <td className="link-agent">{AGENT_LABEL[l.agent] ?? l.agent}{l.current === false ? <span className="link-outdated" title="插件已升级到新版本目录，此链接仍指向旧版本">已过时</span> : null}</td>
                      <td className="link-actions">
                        <select
                          data-testid={`tier-${l.name}`}
                          value={l.tier}
                          disabled={busy}
                          onChange={(e) => void setTier(l.name, e.target.value as LinkRecord["tier"])}
                        >
                          {TIERS.map((t) => (
                            <option key={t} value={t}>{TIER_LABEL[t]}</option>
                          ))}
                        </select>
                        <button type="button" data-testid={`unlink-row-${l.name}`} disabled={busy} onClick={() => void unlink(l.name)}>删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="skills-panes">
            <div className="skills-list">
              <div className="skills-toolbar">
                <input
                  type="text"
                  data-testid="discover-search"
                  className="discover-search"
                  placeholder={`搜索 ${reusableRows.length} 个可复用技能…`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button type="button" data-testid="reuse-all" className="skills-reuse-all" disabled={busy || discoveredCount === 0} onClick={() => void reuseAll()}>
                  全部复用{discoveredCount > 0 ? `（${discoveredCount}）` : ""}
                </button>
              </div>
              {discovery !== null && discovery.sources.length > 0 && (
                <div className="skills-sources" data-testid="discovery-sources">
                  {discovery.sources.map((s) => {
                    // 内置目录不存在=没装那个 agent（中性"未使用"）；自定义
                    // 目录不存在=登记过的目录消失了（警告"已失效"）。
                    const note = !s.stale ? "" : s.agent === "custom" ? "（已失效）" : "（未使用）"
                    return (
                      <span key={s.dir} className={s.stale ? "skill-source stale" : "skill-source"} title={s.stale ? `${s.dir}（目录不存在）` : s.dir}>
                        {AGENT_LABEL[s.agent] ?? s.agent}
                        {note}
                        {s.agent === "custom" && (
                          <button type="button" className="skill-source-del" aria-label={`移除 ${s.dir}`} disabled={busy} onClick={() => void removeSource(s.dir)}>×</button>
                        )}
                      </span>
                    )
                  })}
                  <span className="skills-source-add">
                    <input
                      type="text"
                      data-testid="source-input"
                      placeholder="添加探测目录（绝对路径）"
                      value={newSource}
                      onChange={(e) => setNewSource(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void addSource() }}
                    />
                    <button type="button" data-testid="source-add" disabled={busy || newSource.trim() === ""} onClick={() => void addSource()}>添加</button>
                  </span>
                </div>
              )}
              {agentGroups.length === 0 && pluginGroups.length === 0 ? (
                <p className="muted">{reusableRows.length === 0 ? "未发现可复用的技能。四家 agent 的用户级与插件技能都没有新内容，或都已在上方。" : "没有匹配的技能。"}</p>
              ) : (
                <>
                  {agentGroups.length > 0 && (
                    <div className="skills-section">
                      <div className="skills-section-title">用户级技能目录</div>
                      {agentGroups.map((g) => (
                        <DiscoveryGroup key={g.label} label={g.label} items={g.items} open byName={body?.reusable?.name} busy={busy} linkNames={linkNames} onPreview={preview} onReuse={reuse} onUnlink={unlink} />
                      ))}
                    </div>
                  )}
                  {pluginGroups.length > 0 && (
                    <div className="skills-section">
                      <div className="skills-section-title">
                        已安装插件
                        <span className="section-actions">
                          <button type="button" data-testid="plugin-reuse-all" disabled={busy || !pluginGroups.some((g) => g.items.some((s) => !s.reused && !s.conflict && !s.stale))} onClick={() => void reuseMany("已安装插件", reusableRows.filter((s) => s.plugin !== undefined))}>全部复用</button>
                          <button type="button" data-testid="plugin-unlink-all" disabled={busy || !pluginGroups.some((g) => g.items.some((s) => linkNames.has(s.name)))} onClick={() => void unlinkMany("已安装插件", reusableRows.filter((s) => s.plugin !== undefined))}>全部删除</button>
                        </span>
                      </div>
                      {pluginGroups.map((g) => (
                        <DiscoveryGroup key={g.label} label={g.label} items={g.items} open={filtering} byName={body?.reusable?.name} busy={busy} linkNames={linkNames} onPreview={preview} onReuse={reuse} onUnlink={unlink} onReuseAll={reuseMany} onUnlinkAll={unlinkMany} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="skills-body">
              {body === null ? (
                <p className="muted">点开一个技能先预览正文，再决定复用；档位在上方已建链接里调整</p>
              ) : (
                <>
                  <h3>
                    {body.title}
                    {body.reusable !== undefined && !body.reusable.reused && (
                      <button type="button" data-testid="reuse-preview" disabled={busy || body.reusable.conflict} onClick={() => void reuse(body.reusable!)}>
                        {body.reusable.suggestedTier !== "all" ? `按源档位复用（${TIER_LABEL[body.reusable.suggestedTier]}）` : "复用此技能"}
                      </button>
                    )}
                  </h3>
                  <pre>{body.content}</pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 一个可折叠分组（区块内的 agent 组或插件组）：标题带计数与来源 agent
 * （组内条目来源的并集），插件组另配"全部复用 / 全部删除"组级批量按钮；
 * 展开后是技能行（名字 / 状态或来源 / 两行截断的描述 / 复用开关）。open
 * 是初始展开状态——搜索过滤时由父级强制展开，用户随后仍可手动收起。
 */
function DiscoveryGroup({ label, items, open, byName, busy, linkNames, onPreview, onReuse, onUnlink, onReuseAll, onUnlinkAll }: {
  label: string
  items: DiscoveredSkill[]
  open: boolean
  byName?: string
  busy: boolean
  linkNames: Set<string>
  onPreview: (item: DiscoveredSkill) => void
  onReuse: (item: DiscoveredSkill) => void
  onUnlink: (name: string) => void
  onReuseAll?: (label: string, items: DiscoveredSkill[]) => Promise<void>
  onUnlinkAll?: (label: string, items: DiscoveredSkill[]) => Promise<void>
}): React.ReactElement {
  // 组内条目来源 agent 的并集（跨 agent 合并的条目标全部来源）。
  const originLabels: string[] = []
  for (const item of items) {
    for (const a of item.sources) {
      const shown = AGENT_LABEL[a] ?? a
      if (!originLabels.includes(shown)) originLabels.push(shown)
    }
  }
  const canReuse = items.some((s) => !s.reused && !s.conflict && !s.stale)
  const canUnlink = items.some((s) => linkNames.has(s.name))
  return (
    <details className="discover-group" open={open}>
      <summary>
        <span className="group-label">{label}<span className="muted">（{items.length}）</span></span>
        {onReuseAll !== undefined && originLabels.length > 0 && <span className="group-origins">{originLabels.join(" · ")}</span>}
        {onReuseAll !== undefined && onUnlinkAll !== undefined && (
          <span className="group-actions">
            <button type="button" data-testid={`group-reuse-${label}`} disabled={busy || !canReuse} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void onReuseAll(label, items) }}>全部复用</button>
            <button type="button" data-testid={`group-unlink-${label}`} disabled={busy || !canUnlink} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void onUnlinkAll(label, items) }}>全部删除</button>
          </span>
        )}
      </summary>
      <ul>
        {items.map((item) => {
          const reusedHere = linkNames.has(item.name)
          const hint = item.stale ? "已失效" : item.conflict ? "与已有技能同名冲突" : item.reused && !reusedHere ? "已在其他作用域复用" : ""
          return (
            <li key={`${item.name}-${item.target}`}>
              <div
                data-testid={`discover-${item.name}`}
                className={byName === item.name ? "skill-item discover active" : "skill-item discover"}
                role="button"
                tabIndex={0}
                onClick={() => onPreview(item)}
                onKeyDown={(e) => { if (e.key === "Enter") onPreview(item) }}
              >
                <span className="skill-name">{item.name}</span>
                <span className="skill-meta">
                  {hint !== "" ? hint : item.sources.map((a) => AGENT_LABEL[a] ?? a).join(" · ")}
                  {item.suggestedTier !== "all" ? ` · 源档位 ${TIER_LABEL[item.suggestedTier]}` : ""}
                </span>
                <span className="skill-desc clamp2">{item.stale ? "源目录或链接已失效" : item.description}</span>
                <span className="discover-actions">
                  {item.reused && reusedHere ? (
                    <button type="button" data-testid={`unlink-${item.name}`} disabled={busy} onClick={(e) => { e.stopPropagation(); onUnlink(item.name) }}>取消复用</button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`reuse-${item.name}`}
                      disabled={busy || item.stale || item.conflict}
                      title={item.conflict ? "先处理同名技能" : item.reused ? "该内容已在其他作用域复用，仍可在此再建链接" : ""}
                      onClick={(e) => { e.stopPropagation(); onReuse(item) }}
                    >
                      复用
                    </button>
                  )}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
