/**
 * MemoryView — 记忆管理页（spec 9.3）：三个区块 = 项目线列表（选项目 → 线清单 →
 * 点开线详情可编辑保存/删除）、全局认知（persona/wiki/rule 文件列表 → 查看/编辑/
 * 删除）、写入通知（由 ChatPanel 的 notice + 跳转按钮承接，不在本组件内重复）。
 * 纯 REST 拉取 + 本地筛选；编辑是整文件 textarea + 保存 PATCH / 删除 DELETE。
 * 服务端 503（记忆未装配）时相应 GET 走 catch → notice 提示。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiClient } from "../api.js"
import type { MemoryWrittenInfo } from "../chat/model.js"

interface ProjectRow { id: string; workdir: string; threads: number; lastActivity: string }
interface ThreadRow { topic: string; title: string; status: string; updated: string }
interface CogRow { kind: "persona" | "wiki" | "rule"; name: string; path: string; scope: string; updated: string }

export function MemoryView({ api, notice, openTarget, onOpenConsumed }: {
  api: ApiClient
  notice: (text: string) => void
  /** 写入通知的跳转目标（spec 9.1）：切换到记忆页后自动打开对应线/认知文件，消费后置空。 */
  openTarget?: MemoryWrittenInfo | null
  onOpenConsumed?: () => void
}) {
  // notice 走 ref：reloadProjects 只依赖 api（稳定），effect 不会因父组件每次
  // 重渲染新建的内联 notice identity 而重复触发（审查 Important：App 传内联箭头，
  // 若 reloadProjects 依赖 notice，删除/停留记忆 tab 会反复拉 projects + global）。
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)
  const [threadTopic, setThreadTopic] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [cogs, setCogs] = useState<CogRow[] | null>(null)
  const [cogTarget, setCogTarget] = useState<{ kind: CogRow["kind"]; name: string } | null>(null)
  const [dirtyPath, setDirtyPath] = useState<string | null>(null) // 保存目标（thread 或 cognition 的 PATCH 路径）

  const reloadProjects = useCallback(() => {
    api.get<ProjectRow[]>("/memory/projects").then(setProjects).catch((e) => noticeRef.current(`加载项目失败: ${String(e)}`))
    api.get<CogRow[]>("/memory/global").then(setCogs).catch((e) => noticeRef.current(`加载全局认知失败: ${String(e)}`))
  }, [api])

  useEffect(() => { reloadProjects() }, [reloadProjects])

  // 写入通知跳转（spec 9.1）：切换到本页时 openTarget 带一次目标，打开对应文件后消费。
  useEffect(() => {
    if (openTarget === undefined || openTarget === null) return
    const t = openTarget
    void (async () => {
      try {
        if (t.kind === "episode" && t.scope !== undefined && t.topic !== undefined) {
          // scope 形如 "project:<id>"（当前项目线），取 id 打开该线。
          const pid = t.scope.startsWith("project:") ? t.scope.slice("project:".length) : t.scope
          await openThread(pid, t.topic)
        } else if (t.kind === "cognition") {
          // path 形如 …/global/<kind>/<name>.md；从路径反推 kind/name 打开。
          const m = /\/global\/(persona|wiki|rule)\/([^/]+)\.md$/.exec(t.path)
          if (m !== null) await openCog(m[1] as CogRow["kind"], m[2])
        }
      } finally {
        onOpenConsumed?.()
      }
    })()
    // openTarget 是单次跳转意图，每次变化消费一次即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget])

  const openThread = async (pid: string, topic: string): Promise<void> => {
    try {
      const { content } = await api.get<{ content: string }>(`/memory/threads/${encodeURIComponent(pid)}/${encodeURIComponent(topic)}`)
      setDraft(content); setDirtyPath(`/memory/threads/${encodeURIComponent(pid)}/${encodeURIComponent(topic)}`)
      setThreadTopic(topic)
    } catch (e) { notice(`读取线失败: ${String(e)}`) }
  }

  const openCog = async (kind: CogRow["kind"], name: string): Promise<void> => {
    try {
      const { content } = await api.get<{ content: string }>(`/memory/global/${kind}/${encodeURIComponent(name)}`)
      setDraft(content); setDirtyPath(`/memory/global/${kind}/${encodeURIComponent(name)}`)
      setCogTarget({ kind, name })
    } catch (e) { notice(`读取认知文件失败: ${String(e)}`) }
  }

  const save = async (): Promise<void> => {
    if (dirtyPath === null) return
    try {
      await api.patch(dirtyPath, { content: draft })
      notice("已保存")
      // 保存后刷新所属列表，让 updated 时间戳跟上（reloadProjects 稳定后 effect
      // 不会自动补拉——这里显式刷新，不叠加重复 GET）。
      if (threadTopic !== null && projectId !== null) {
        api.get<{ threads: ThreadRow[] }>(`/memory/projects/${encodeURIComponent(projectId)}`)
          .then((r) => setThreads(r.threads))
          .catch((e) => notice(`加载线程失败: ${String(e)}`))
      } else if (cogTarget !== null) {
        api.get<CogRow[]>("/memory/global")
          .then(setCogs)
          .catch((e) => notice(`加载全局认知失败: ${String(e)}`))
      }
    } catch (e) { notice(`保存失败: ${String(e)}`) }
  }

  const remove = async (): Promise<void> => {
    if (dirtyPath === null) return
    try {
      await api.del(dirtyPath)
      notice("已删除")
      setThreadTopic(null); setCogTarget(null); setDraft(""); setDirtyPath(null)
      reloadProjects()
      if (projectId !== null) {
        api.get<{ threads: ThreadRow[] }>(`/memory/projects/${encodeURIComponent(projectId)}`)
          .then((r) => setThreads(r.threads))
          .catch((e) => { setThreads([]); notice(`加载线程失败: ${String(e)}`) })
      }
    } catch (e) { notice(`删除失败: ${String(e)}`) }
  }

  // 结构：左列（项目/线/全局认知两棵清单）+ 右列（编辑器）。
  return (
    <div className="memory-view" data-testid="memory-view">
      <div className="memory-list">
        <section>
          <h3>项目</h3>
          {projects === null ? <p className="muted">加载中…</p> : projects.length === 0 ? <p className="muted">还没有项目记忆</p> : (
            <ul data-testid="memory-projects">
              {projects.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={async () => {
                    setProjectId(p.id); setThreadTopic(null)
                    try { setThreads((await api.get<{ threads: ThreadRow[] }>(`/memory/projects/${encodeURIComponent(p.id)}`)).threads) }
                    catch (e) { setThreads([]); notice(`加载线程失败: ${String(e)}`) }
                  }}>{p.id}（{p.threads} 线）</button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {threads !== null && (
          <section>
            <h3>主题线</h3>
            {threads.length === 0 ? <p className="muted">该主题无线程</p> : (
              <ul data-testid="memory-threads">
                {threads.map((t) => (
                  <li key={t.topic}>
                    <button type="button" onClick={() => { if (projectId !== null) void openThread(projectId, t.topic) }}>
                      {t.title} · {t.status} · {t.updated}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section>
          <h3>全局认知</h3>
          {cogs === null ? <p className="muted">加载中…</p> : cogs.length === 0 ? <p className="muted">还没有全局认知</p> : (
            <ul data-testid="memory-cognitions">
              {cogs.map((c) => (
                <li key={c.path}>
                  <button type="button" onClick={() => void openCog(c.kind, c.name)}>{c.kind}/{c.name} · {c.updated}</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="memory-editor">
        {(threadTopic !== null || cogTarget !== null) ? (
          <>
            <h3>{threadTopic ?? `${cogTarget!.kind}/${cogTarget!.name}`}</h3>
            <textarea data-testid="memory-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} />
            <div className="memory-editor-actions">
              <button type="button" data-testid="memory-save" onClick={() => void save()}>保存</button>
              <button type="button" data-testid="memory-delete" onClick={() => void remove()}>删除</button>
            </div>
          </>
        ) : <p className="muted">选择一条主题线或一个认知文件查看与编辑</p>}
      </div>
    </div>
  )
}
