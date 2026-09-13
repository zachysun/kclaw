/**
 * SkillsView — 技能页：左栏技能清单（名字 / 作用域 / 可见性标记 / 描述），
 * 右栏点开后的 SKILL.md 正文；外加技能复用管理面——顶部项目下拉（默认
 * 全局）切换 scope，探测其他 coding agent 的用户级技能目录列出可复用技
 * 能，一键建软链接接入（全局或项目级），已建链接的可见档位（完全可见/
 * 仅用户/仅模型/暂不启用）单选可改。技能本体仍是文件即真相；复用链接的
 * 元数据（目标/来源/档位）在服务端 .links.json，本页只经 /skills 路由族
 * 读写。user-invocable:false 的技能服务端当作不存在（列表与点名都不出
 * 现），复用链接的管理记录不受该过滤影响（否则"仅模型"档改不回）。
 * 项目级技能与复用的生效范围由 scope 下拉决定，与 run 时注入同源同规则。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiClient } from "../api.js"

interface SkillRow {
  name: string
  displayName: string
  description: string
  visibility: "all" | "user-only"
  origin: "global" | "project"
}

interface DiscoveredSkill {
  name: string
  displayName: string
  description: string
  target: string
  sources: string[]
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
}

interface LinksPayload {
  links: LinkRecord[]
  extraSources: string[]
}

/** 复用来源与可见档位的中文标签（接口仍是服务端约定的小写枚举）。 */
const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", dsh: "DeepSeek", zcode: "zCode", custom: "自定义" }
const TIER_LABEL: Record<LinkRecord["tier"], string> = { all: "完全可见", user: "仅用户", model: "仅模型", off: "暂不启用" }
const TIERS: LinkRecord["tier"][] = ["all", "user", "model", "off"]

export function SkillsView({ api, notice }: {
  api: ApiClient
  notice: (text: string) => void
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
  const [rows, setRows] = useState<SkillRow[] | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryPayload | null>(null)
  const [links, setLinks] = useState<LinksPayload | null>(null)
  const [body, setBody] = useState<{ title: string; content: string; reusable?: DiscoveredSkill } | null>(null)
  const [newSource, setNewSource] = useState("")
  const [busy, setBusy] = useState(false)

  const scopeQuery = scope !== "" ? `?workdir=${encodeURIComponent(scope)}` : ""

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
    api.get<SkillRow[]>(`/skills${scopeQuery}`).then(setRows).catch((e) => noticeRef.current(`加载技能失败: ${String(e)}`))
    // 复用管理面的三份数据失败都走行内降级，不打扰主清单的 notice。
    api.get<DiscoveryPayload>(`/skills/discovery${scopeQuery}`).then(setDiscovery).catch(() => setDiscovery(null))
    api.get<LinksPayload>(`/skills/links${scopeQuery}`).then(setLinks).catch(() => setLinks(null))
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
      notice(`读取技能失败: ${String(e)}`)
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

  const reuse = async (item: DiscoveredSkill, tier: LinkRecord["tier"] = "all"): Promise<void> => {
    setBusy(true)
    try {
      await api.post("/skills/links", { name: item.name, target: item.target, agent: item.sources[0] ?? "custom", tier, workdir: scope !== "" ? scope : undefined })
      setBody(null)
      refreshAfterWrite(`已复用 ${item.name}`)
    } catch (e) {
      notice(`复用失败: ${String(e)}`)
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
      notice(`取消复用失败: ${String(e)}`)
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
      notice(`改档位失败: ${String(e)}`)
      reload()
    } finally {
      setBusy(false)
    }
  }

  const reuseAll = async (): Promise<void> => {
    if (discovery === null) return
    const candidates = discovery.skills.filter((s) => !s.reused && !s.conflict && !s.stale)
    if (candidates.length === 0) {
      notice("没有可批量复用的技能（其余均已复用或存在冲突）")
      return
    }
    setBusy(true)
    let ok = 0
    for (const item of candidates) {
      try {
        await api.post("/skills/links", { name: item.name, target: item.target, agent: item.sources[0] ?? "custom", tier: "all", workdir: scope !== "" ? scope : undefined })
        ok += 1
      } catch {
        // 单条失败不中断批量，结束后统一刷新并提示。
      }
    }
    setBusy(false)
    refreshAfterWrite(`批量复用完成：${ok}/${candidates.length}`)
  }

  const addSource = async (): Promise<void> => {
    const dir = newSource.trim()
    if (dir === "") return
    setBusy(true)
    try {
      await api.post("/skills/sources", { dir, workdir: scope !== "" ? scope : undefined })
      setNewSource("")
      reload()
    } catch (e) {
      notice(`添加探测目录失败: ${String(e)}`)
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
      notice(`移除探测目录失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const linkNames = new Set((links?.links ?? []).map((l) => l.name))
  const reusableRows = discovery?.skills ?? []
  const discoveredCount = reusableRows.filter((s) => !s.reused && !s.conflict && !s.stale).length

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
        <button type="button" data-testid="reuse-all" className="skills-reuse-all" disabled={busy || discoveredCount === 0} onClick={() => void reuseAll()}>
          全部复用{discoveredCount > 0 ? `（${discoveredCount}）` : ""}
        </button>
        {busy && <span className="muted">处理中…</span>}
      </div>
      <div className="skills-list">
        <h4 className="skills-seg-title">已装技能</h4>
        {rows === null ? (
          <p className="muted">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">
            还没有技能。把技能目录放进 <code>~/.kclaw/skills/</code>（全局）或工作区的
            <code>.kclaw/skills/</code>（本项目），或在下方从其他 coding agent 复用。
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
                    {r.visibility === "user-only" ? " · 仅用户" : ""}
                  </span>
                  <span className="skill-desc">{r.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <h4 className="skills-seg-title">可复用技能<span className="muted">（来自其他 coding agent 的技能目录）</span></h4>
        {discovery !== null && discovery.sources.length > 0 && (
          <div className="skills-sources" data-testid="discovery-sources">
            {discovery.sources.map((s) => (
              <span key={s.dir} className={s.stale ? "skill-source stale" : "skill-source"} title={s.dir}>
                {AGENT_LABEL[s.agent] ?? s.agent}
                {s.stale ? "（已失效）" : ""}
                {s.agent === "custom" && (
                  <button type="button" className="skill-source-del" aria-label={`移除 ${s.dir}`} disabled={busy} onClick={() => void removeSource(s.dir)}>×</button>
                )}
              </span>
            ))}
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
        {reusableRows.length === 0 ? (
          <p className="muted">未发现可复用的技能。四家 agent 的用户级技能目录没有内容，或都已在上方。</p>
        ) : (
          <ul>
            {reusableRows.map((item) => {
              const reusedHere = linkNames.has(item.name)
              const hint = item.stale ? "已失效" : item.conflict ? "与已有技能同名冲突" : item.reused && !reusedHere ? "已在其他作用域复用" : ""
              return (
                <li key={`${item.name}-${item.target}`}>
                  <div
                    data-testid={`discover-${item.name}`}
                    className={body?.reusable?.name === item.name ? "skill-item discover active" : "skill-item discover"}
                    role="button"
                    tabIndex={0}
                    onClick={() => void preview(item)}
                    onKeyDown={(e) => { if (e.key === "Enter") void preview(item) }}
                  >
                    <span className="skill-name">{item.name}</span>
                    <span className="skill-meta">
                      {item.sources.map((a) => AGENT_LABEL[a] ?? a).join(" · ")}
                      {hint !== "" ? ` · ${hint}` : ""}
                    </span>
                    <span className="skill-desc">{item.stale ? "源目录或链接已失效" : item.description}</span>
                    <span className="discover-actions">
                      {item.reused && reusedHere ? (
                        <button type="button" data-testid={`unlink-${item.name}`} disabled={busy} onClick={(e) => { e.stopPropagation(); void unlink(item.name) }}>取消复用</button>
                      ) : (
                        <button
                          type="button"
                          data-testid={`reuse-${item.name}`}
                          disabled={busy || item.stale || item.conflict}
                          title={item.conflict ? "先处理同名技能" : item.reused ? "该内容已在其他作用域复用，仍可在此再建链接" : ""}
                          onClick={(e) => { e.stopPropagation(); void reuse(item) }}
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
        )}

        {links !== null && links.links.length > 0 && (
          <>
            <h4 className="skills-seg-title">已建链接<span className="muted">（复用技能的可见档位）</span></h4>
            <ul>
              {links.links.map((l) => (
                <li key={l.name}>
                  <div className="skill-item link-row" data-testid={`link-${l.name}`}>
                    <span className="skill-name">{l.name}</span>
                    <span className="skill-meta">{AGENT_LABEL[l.agent] ?? l.agent} · {l.target}</span>
                    <span className="link-actions">
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
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="skills-body">
        {body === null ? (
          <p className="muted">选择一个技能查看完整说明；点开可复用技能先预览正文</p>
        ) : (
          <>
            <h3>
              {body.title}
              {body.reusable !== undefined && !body.reusable.reused && (
                <button type="button" data-testid="reuse-preview" disabled={busy || body.reusable.conflict} onClick={() => void reuse(body.reusable!)}>复用此技能</button>
              )}
            </h3>
            <pre>{body.content}</pre>
          </>
        )}
      </div>
    </div>
  )
}
