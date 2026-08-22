/**
 * TrashView — the session recycle bin (spec §10 WebUI). Pulls the soft-deleted
 * sessions (GET /sessions?deleted=true) and offers, per row, 恢复
 * (POST /sessions/:id/restore) and 彻底删除 (POST /sessions/:id/purge). After
 * either mutation it re-pulls the list so the row disappears. No selection
 * state: the trash only mutates, it never opens a session.
 */
import { useCallback, useEffect, useState } from "react"
import { type ApiClient } from "../api.js"
import type { SessionMeta } from "../types.js"

export function TrashView({ api }: { api: ApiClient }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSessions(await api.get<SessionMeta[]>("/sessions?deleted=true"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载回收站失败")
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const restore = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        await api.post(`/sessions/${encodeURIComponent(id)}/restore`)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : "恢复失败")
      }
    },
    [api, load],
  )

  const purge = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        await api.post(`/sessions/${encodeURIComponent(id)}/purge`)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : "彻底删除失败")
      }
    },
    [api, load],
  )

  return (
    <div className="trash-view" data-testid="trash-view">
      <div className="view-head">
        <h2 className="view-title">回收站</h2>
      </div>
      {error !== null && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {sessions !== null && sessions.length === 0 && (
        <p className="muted table-empty" data-testid="trash-empty">
          回收站为空。
        </p>
      )}
      {sessions !== null && sessions.length > 0 && (
        <ul className="trash-items">
          {sessions.map((meta) => (
            <li key={meta.id} className="trash-row" data-testid={`trash-item-${meta.id}`}>
              <span className="session-title">{meta.title}</span>
              <button
                type="button"
                data-testid={`trash-restore-${meta.id}`}
                onClick={() => void restore(meta.id)}
              >
                恢复
              </button>
              <button
                type="button"
                data-testid={`trash-purge-${meta.id}`}
                onClick={() => void purge(meta.id)}
              >
                彻底删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
