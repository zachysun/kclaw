/**
 * PermissionsView — decided-rules management: lists both scopes (global
 * ~/.kclaw/permissions.yaml and project <workspace>/.kclaw/permissions.yaml)
 * with provenance per rule (tool / args / time / session), deletable one by
 * one. The YAML files remain the hand-editable surface; this view is the same
 * data in a human-friendly form. A git-tracked project file is ignored by the
 * gate (a cloned repo cannot ship a pre-authorized allow list), so it is
 * labelled as such here.
 */
import { useCallback, useEffect, useState } from "react"
import type { ApiClient } from "../api.js"
import { formatStamp } from "../usage/format.js"
import type { NoticeFn } from "../toast.js"

interface RuleRow {
  rule: string
  decidedAt: string
  origin: { tool: string; argsJson?: string; sessionId?: string }
  /** Absent/omitted reads as manual (a human chose "always allow"). */
  source?: "auto" | "manual"
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

export function PermissionsView({ api, notice, workdir }: {
  api: ApiClient
  notice: NoticeFn
  /** The current session's workdir: the project scope's read range; unknown → global only. */
  workdir?: string
}) {
  // notice comes from App's useToasts: its identity is stable across renders
  // (empty-deps useCallback), so it goes straight into callback deps.

  const [data, setData] = useState<RulesPayload | null>(null)

  const query = workdir !== undefined && workdir !== "" ? `?workspace=${encodeURIComponent(workdir)}` : ""

  const reload = useCallback(() => {
    api.get<RulesPayload>(`/permissions/rules${query}`).then(setData).catch((e) => notice(`加载权限规则失败: ${String(e)}`, "error"))
  }, [api, query, notice])

  useEffect(() => { reload() }, [reload])

  const remove = async (scope: "global" | "project", index: number): Promise<void> => {
    try {
      await api.del(`/permissions/rules${query}`, { scope, index })
      reload()
    } catch (e) {
      notice(`删除规则失败: ${String(e)}`, "error")
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
                {r.source === "auto" && <em className="perm-source" data-testid={`perm-source-${scope}-${i}`}>自动学习</em>}
                {formatStamp(r.decidedAt)}
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
      <h2 className="view-title">权限</h2>
      {data === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          {data.project.path === data.global.path && (
            <p className="muted" data-testid="perm-same-path-note">
              当前会话的工作目录是用户主目录，项目档与全局档指向同一个文件。
            </p>
          )}
          {scopeBlock("global", data.global)}
          {scopeBlock("project", data.project)}
        </>
      )}
    </div>
  )
}
