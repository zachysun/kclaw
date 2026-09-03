/**
 * SkillsView — 只读技能页：左栏技能清单（名字 / 作用域 / 可见性标记 / 描述），
 * 右栏点开后的 SKILL.md 正文。技能是文件即真相（~/.kclaw/skills/ 与工作区
 * .kclaw/skills/），本页没有编辑动作；user-invocable:false 的技能服务端
 * 已经当作不存在（列表与点名都不出现）。项目级技能的生效范围跟当前会话的
 * 工作目录（workdir prop），与 run 时注入同源同规则。
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

export function SkillsView({ api, notice, workdir }: {
  api: ApiClient
  notice: (text: string) => void
  /** 当前会话的工作目录：项目级技能的扫描范围；未知时只列全局。 */
  workdir?: string
}) {
  // notice 走 ref：App 传内联箭头，每次父组件重渲染都是新引用；若 reload 依赖
  // notice，停留本页会反复拉取（MemoryView 曾犯过的同类审查问题，同款防御）。
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [rows, setRows] = useState<SkillRow[] | null>(null)
  const [body, setBody] = useState<{ name: string; content: string } | null>(null)

  const listUrl = workdir !== undefined && workdir !== "" ? `/skills?workdir=${encodeURIComponent(workdir)}` : "/skills"
  const query = workdir !== undefined && workdir !== "" ? `?workdir=${encodeURIComponent(workdir)}` : ""

  const reload = useCallback(() => {
    api.get<SkillRow[]>(listUrl).then(setRows).catch((e) => noticeRef.current(`加载技能失败: ${String(e)}`))
  }, [api, listUrl])

  useEffect(() => { reload() }, [reload])

  const open = async (name: string): Promise<void> => {
    try {
      const res = await api.get<{ name: string; content: string }>(`/skills/${encodeURIComponent(name)}${query}`)
      setBody({ name: res.name, content: res.content })
    } catch (e) {
      notice(`读取技能失败: ${String(e)}`)
    }
  }

  return (
    <div className="skills-view" data-testid="skills-view">
      <div className="skills-list">
        {rows === null ? (
          <p className="muted">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">
            还没有技能。把技能目录放进 <code>~/.kclaw/skills/</code>（全局）或工作区的
            <code>.kclaw/skills/</code>（本项目），下一个会话轮次即生效。
          </p>
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.name}>
                <button
                  type="button"
                  data-testid={`skill-${r.name}`}
                  className={body?.name === r.name ? "skill-item active" : "skill-item"}
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
      </div>
      <div className="skills-body">
        {body === null ? (
          <p className="muted">选择一个技能查看完整说明</p>
        ) : (
          <>
            <h3>{body.name}</h3>
            <pre>{body.content}</pre>
          </>
        )}
      </div>
    </div>
  )
}
