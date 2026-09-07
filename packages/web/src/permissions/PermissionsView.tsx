/**
 * PermissionsView — decided-rules management: lists both scopes (global
 * ~/.kclaw/permissions.yaml and project <workspace>/.kclaw/permissions.yaml)
 * with provenance per rule (tool / args / time / session), deletable one by
 * one. The YAML files remain the hand-editable surface; this view is the same
 * data in a human-friendly form. A git-tracked project file is ignored by the
 * gate (a cloned repo cannot ship a pre-authorized allow list), so it is
 * labelled as such here.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiClient } from "../api.js"

interface RuleRow {
  rule: string
  decidedAt: string
  origin: { tool: string; argsJson?: string; sessionId?: string }
}

interface ScopeBlock {
  path: string
  rules: RuleRow[]
}

interface ProjectBlock extends ScopeBlock {
  tracked: boolean
  ignored: boolean
}

interface RulesPayload {
  global: ScopeBlock
  project: ProjectBlock
}

/** "2026-09-06T12:34:56.789Z" → "2026-09-06 12:34" (local time). */
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function PermissionsView({ api, notice, workdir }: {
  api: ApiClient
  notice: (text: string) => void
  /** The current session's workdir: the project scope's read range; unknown → global only. */
  workdir?: string
}) {
  // notice goes through a ref: App passes an inline arrow that is a fresh
  // reference each render; depending on `notice` would refetch on every parent
  // re-render (same guard as SkillsView).
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [data, setData] = useState<RulesPayload | null>(null)

  const query = workdir !== undefined && workdir !== "" ? `?workspace=${encodeURIComponent(workdir)}` : ""

  const reload = useCallback(() => {
    api.get<RulesPayload>(`/permissions/rules${query}`).then(setData).catch((e) => noticeRef.current(`加载权限规则失败: ${String(e)}`))
  }, [api, query])

  useEffect(() => { reload() }, [reload])

  const remove = async (scope: "global" | "project", index: number): Promise<void> => {
    try {
      await api.del(`/permissions/rules${query}`, { scope, index })
      reload()
    } catch (e) {
      notice(`删除规则失败: ${String(e)}`)
    }
  }

  const scopeBlock = (scope: "global" | "project", block: ScopeBlock) => (
    <section className="perm-scope" data-testid={`perm-scope-${scope}`}>
      <h3>
        {scope === "global" ? "全局" : "项目"}
        <code className="perm-path">{block.path}</code>
      </h3>
      {scope === "project" && (block as ProjectBlock).ignored === true && (
        <p className="muted" data-testid="perm-project-ignored">
          该文件已被 git 跟踪，为防仓库预埋授权，其中的规则不会生效。
        </p>
      )}
      {block.rules.length === 0 ? (
        <p className="muted">{scope === "project" && (block as ProjectBlock).ignored === true ? "（未读取）" : "还没有沉淀的规则"}</p>
      ) : (
        <ul className="perm-rules">
          {block.rules.map((r, i) => (
            <li key={i} data-testid={`perm-rule-${scope}-${i}`}>
              <code className="perm-rule">{r.rule}</code>
              <span className="perm-meta">
                {shortTime(r.decidedAt)}
                {r.origin.sessionId !== undefined ? ` · ${r.origin.sessionId}` : ""}
              </span>
              <button
                type="button"
                data-testid={`perm-delete-${scope}-${i}`}
                aria-label={`删除规则 ${r.rule}`}
                onClick={() => void remove(scope, i)}
              >删除</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  return (
    <div className="permissions-view" data-testid="permissions-view">
      <p className="muted perm-intro">
        这些规则来自审批确认里选择「总是允许」的操作：项目档存工作区的
        <code>.kclaw/permissions.yaml</code>（自动加入 .gitignore），全局档存
        <code>~/.kclaw/permissions.yaml</code>。删除即收回自动放行。
      </p>
      {data === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          {scopeBlock("global", data.global)}
          {scopeBlock("project", data.project)}
        </>
      )}
    </div>
  )
}
