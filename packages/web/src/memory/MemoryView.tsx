/**
 * MemoryView — 记忆管理页（spec 9.3）：三个区块 = 项目线列表（选项目 → 线清单 →
 * 点开线详情可编辑保存/删除）、全局认知（persona/wiki/rule 文件列表 → 查看/编辑/
 * 删除）、写入通知（由 ChatPanel 的 notice + 跳转按钮承接，不在本组件内重复）。
 * 纯 REST 拉取 + 本地筛选；编辑是整文件 textarea + 保存 PATCH / 删除 DELETE。
 * 服务端 503（记忆未装配）时相应 GET 走 catch → notice 提示。
 */
import { useCallback, useEffect, useState } from "react"
import type { ApiClient } from "../api.js"

interface ProjectRow { id: string; workdir: string; threads: number; lastActivity: string }
interface ThreadRow { topic: string; title: string; status: string; updated: string }
interface CogRow { kind: "persona" | "wiki" | "rule"; name: string; path: string; scope: string; updated: string }

export function MemoryView({ api, notice }: { api: ApiClient; notice: (text: string) => void }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)
  const [threadTopic, setThreadTopic] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [cogs, setCogs] = useState<CogRow[] | null>(null)
  const [cogTarget, setCogTarget] = useState<{ kind: CogRow["kind"]; name: string } | null>(null)
  const [dirtyPath, setDirtyPath] = useState<string | null>(null) // 保存目标（thread 或 cognition 的 PATCH 路径）

  const reloadProjects = useCallback(() => {
    api.get<ProjectRow[]>("/memory/projects").then(setProjects).catch((e) => notice(`加载项目失败: ${String(e)}`))
    api.get<CogRow[]>("/memory/global").then(setCogs).catch((e) => notice(`加载全局认知失败: ${String(e)}`))
  }, [api, notice])

  useEffect(() => { reloadProjects() }, [reloadProjects])

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
        api.get<{ threads: ThreadRow[] }>(`/memory/projects/${encodeURIComponent(projectId)}`).then((r) => setThreads(r.threads)).catch(() => setThreads([]))
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
                    catch { setThreads([]) }
                  }}>{p.id}（{p.threads} 线）</button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {threads !== null && (
          <section>
            <h3>主题线</h3>
            <ul data-testid="memory-threads">
              {threads.map((t) => (
                <li key={t.topic}>
                  <button type="button" onClick={() => { if (projectId !== null) void openThread(projectId, t.topic) }}>
                    {t.title} · {t.status} · {t.updated}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>全局认知</h3>
          {cogs === null ? <p className="muted">加载中…</p> : (
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
