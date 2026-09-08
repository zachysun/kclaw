/**
 * AuditView — the audit page (审计页): a live, filterable, virtualized read
 * over a session's persisted event stream (the single source of truth,
 * GET /sessions/:id/events). Guiding principle: the user masters everything
 * that happened.
 *
 * Live tailing: the page opens its OWN ws connection (the chat connection is
 * untouched) and subscribes to the session. The store announces every
 * persisted event with a `session.appended` frame (persist BEFORE announce,
 * for every event type — memory included), and the page answers it with an
 * incremental `?since=` fetch; the append-only array index is the cursor.
 * Initial load, reconnect reconcile, and retry all run the same tail-pull
 * (since = current length), so there is exactly one cursor to keep honest.
 * A failed live pull surfaces a slim retry bar instead of dropping the
 * loaded rows — the cursor stays put, so the retry re-pulls the same window.
 * Only persisted facts are shown — no streaming intermediates.
 *
 * Rendering is virtualized (react-virtuoso): variable row heights, bottom
 * following (auto-follow while pinned to the bottom, pause on scroll-up, a
 * "回到最新" bubble to resume), and stable row keys carrying the event index
 * so expansion survives appends. Type toggles + time range FILTER rows;
 * keyword SEARCH marks hits (row marker + hit counter + prev/next jumps,
 * like an editor search); jumps also target the previous/next compaction
 * boundary. Session selection follows the sidebar (owned by the shell); the
 * component stays mounted (hidden) across tab switches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { type ApiClient } from "../api.js"
import { WsAuthError, type WsClient } from "../ws.js"
import type { SessionEvent } from "../types.js"
import { AuditRowItem } from "./AuditRowItem.js"
import {
  ALL_KINDS, appendEvents, DEFAULT_FILTER, filterRows, flattenAudit, isAppendedFrame,
  jumpTarget, matchRowIndexes, type AuditFilter, type AuditRowKind, type TimePreset,
} from "./model.js"

/** Max consecutive failed reconnects before giving up with a notice. */
const MAX_RECONNECT_ATTEMPTS = 3

const KIND_LABELS: Record<AuditRowKind, string> = {
  block: "消息",
  compaction: "压缩",
  memory: "记忆",
  system: "系统",
  sandbox: "沙箱",
  session: "会话",
}

const TIME_PRESETS: Array<{ value: TimePreset; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "1h", label: "最近 1 小时" },
  { value: "today", label: "今天" },
  { value: "custom", label: "自定义" },
]

/** ISO string → datetime-local input value ("yyyy-MM-ddThh:mm"), local time. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local input value → ISO string ("" stays ""). */
function localInputToIso(v: string): string {
  if (v === "") return ""
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

export interface AuditViewProps {
  api: ApiClient
  /** Per-connection ws factory (from useDaemonClients) — the page owns its connection. */
  createWs: () => WsClient
  /** Follows the shell's selected session; null → the "no session" empty state. */
  sessionId: string | null
  /** Display-only: the selected session's title (chip next to the page title). */
  sessionTitle?: string | null
}

export function AuditView({ api, createWs, sessionId, sessionTitle }: AuditViewProps) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null)
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading")
  const [errorText, setErrorText] = useState("")
  const [filter, setFilter] = useState<AuditFilter>(DEFAULT_FILTER)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  /** A failed frame-driven (live) pull — non-destructive: loaded rows stay. */
  const [liveError, setLiveError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const [hitCursor, setHitCursor] = useState(0)
  const [reloadTick, setReloadTick] = useState(0)

  const virtRef = useRef<VirtuosoHandle>(null)
  /** Last jump/scroll anchor (visible-row index) — the "from" of relative jumps. */
  const cursorRowRef = useRef(0)
  /** The effect's live re-pull (since=cursor), exposed to the retry button. */
  const liveRetryRef = useRef<(() => void) | null>(null)

  // One data effect per session: initial tail-pull (since=0 = full stream),
  // then a private ws subscription whose session.appended frames drive
  // incremental pulls. Reconnects re-pull the tail to reconcile; consecutive
  // failures are bounded, mirroring the chat panel's contract.
  useEffect(() => {
    if (sessionId === null) {
      setEvents(null)
      setPhase("ready")
      return
    }
    let cancelled = false
    let client = createWs()
    let cursor = 0
    let pulling = false
    let dirty = false

    setEvents(null)
    setPhase("loading")
    setErrorText("")
    setNotice(null)
    setLiveError(null)
    setFollowing(true)
    setExpanded(new Set())
    cursorRowRef.current = 0

    // since = current cursor: full stream on first call, increments after.
    const pullTail = async (): Promise<void> => {
      if (pulling) {
        dirty = true
        return
      }
      pulling = true
      try {
        const fresh = await api.get<SessionEvent[]>(
          `/sessions/${encodeURIComponent(sessionId)}/events?since=${cursor}`,
        )
        if (cancelled) return
        cursor += fresh.length
        if (fresh.length > 0) setEvents((prev) => appendEvents(prev ?? [], fresh))
        setLiveError(null)
        setPhase("ready")
      } finally {
        pulling = false
        if (dirty && !cancelled) {
          dirty = false
          pullTailLive()
        }
      }
    }

    // Live pulls (frame-driven, merged re-pulls) must never dead-end the page:
    // a failure surfaces as a slim retry bar and the cursor stays put, so the
    // next frame — or the retry button — re-pulls the same window.
    const pullTailLive = (): void => {
      void pullTail().catch((err) => {
        if (cancelled) return
        setLiveError(err instanceof Error ? err.message : "实时更新失败")
      })
    }
    liveRetryRef.current = pullTailLive

    const subscribe = (c: WsClient): void => {
      try {
        c.send({ type: "subscribe", sessionId })
      } catch {
        // A closed socket drops the frame silently; the reconnect loop re-subscribes.
      }
    }

    const eventLoop = async (c: WsClient): Promise<"closed" | "auth" | "error"> => {
      try {
        for await (const frame of c.frames) {
          if (cancelled) return "closed"
          if (isAppendedFrame(frame)) pullTailLive()
        }
        return "closed"
      } catch (err) {
        return err instanceof WsAuthError ? "auth" : "error"
      }
    }

    const run = async (): Promise<void> => {
      let attempts = 0
      while (!cancelled) {
        subscribe(client)
        const outcome = await eventLoop(client)
        if (cancelled) return
        if (outcome === "auth") {
          setNotice("认证已失效，请刷新页面重新输入 token")
          return
        }
        attempts += 1
        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          setNotice("实时连接已断开，请刷新页面")
          return
        }
        setNotice("连接已断开，正在重连…")
        try {
          client = createWs()
          subscribe(client)
          await pullTail() // reconnect reconcile: catch up on missed appends
          if (cancelled) return
          attempts = 0
          setNotice(null)
        } catch {
          if (cancelled) return
          setNotice("重连失败，请刷新页面")
        }
      }
    }

    pullTail().catch((err) => {
      if (cancelled) return
      setPhase("error")
      setErrorText(err instanceof Error ? err.message : "加载事件流失败")
    })
    void run()

    return () => {
      cancelled = true
      liveRetryRef.current = null
      client.close()
    }
  }, [api, createWs, sessionId, reloadTick])

  const rows = useMemo(() => flattenAudit(events ?? []), [events])
  const visibleRows = useMemo(() => filterRows(rows, filter, new Date()), [rows, filter])
  const hits = useMemo(() => matchRowIndexes(visibleRows, filter.keyword), [visibleRows, filter.keyword])
  const hitSet = useMemo(() => new Set(hits), [hits])

  const setKind = useCallback((kind: AuditRowKind, on: boolean) => {
    setFilter((f) => ({ ...f, kinds: { ...f.kinds, [kind]: on } }))
  }, [])

  const setKeyword = useCallback((kw: string) => {
    setFilter((f) => ({ ...f, keyword: kw }))
    setHitCursor(0) // a new search restarts the hit walk
  }, [])

  const setTimePreset = useCallback((preset: TimePreset) => {
    setFilter((f) => ({ ...f, timePreset: preset }))
  }, [])

  const setTimeBound = useCallback((which: "timeFrom" | "timeTo", iso: string) => {
    setFilter((f) => ({ ...f, [which]: iso }))
  }, [])

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const scrollToRow = useCallback((index: number) => {
    cursorRowRef.current = index
    virtRef.current?.scrollToIndex({ index, align: "center" })
  }, [])

  const jumpRows = useCallback((candidates: number[], dir: 1 | -1) => {
    const from = cursorRowRef.current
    const target = jumpTarget(candidates, from, dir)
    if (target !== null) scrollToRow(target)
    return target
  }, [scrollToRow])

  const compactionIndexes = useMemo(
    () => visibleRows.reduce<number[]>((acc, r, i) => (r.kind === "compaction" ? (acc.push(i), acc) : acc), []),
    [visibleRows],
  )

  const jumpHit = useCallback(
    (dir: 1 | -1) => {
      if (hits.length === 0) return
      const next = (hitCursor + (dir === 1 ? 1 : -1) + hits.length) % hits.length
      setHitCursor(next)
      scrollToRow(hits[next]!)
    },
    [hits, hitCursor, scrollToRow],
  )

  const jumpLatest = useCallback(() => {
    setFollowing(true)
    if (visibleRows.length > 0) scrollToRow(visibleRows.length - 1)
  }, [visibleRows.length, scrollToRow])

  const keyword = filter.keyword.trim()
  const rowsBody = (() => {
    if (phase === "loading") {
      return (
        <p className="muted table-empty" data-testid="audit-loading">
          加载事件流…
        </p>
      )
    }
    if (sessionId === null) {
      return (
        <p className="muted table-empty" data-testid="audit-empty">
          在左侧选择一个会话查看它的审计事件流
        </p>
      )
    }
    if (rows.length === 0) {
      return (
        <p className="muted table-empty" data-testid="audit-empty">
          暂无事件
        </p>
      )
    }
    if (visibleRows.length === 0) {
      return (
        <p className="muted table-empty" data-testid="audit-empty">
          当前过滤条件下没有匹配的事件
        </p>
      )
    }
    return (
      <div className="audit-list-wrap">
        <Virtuoso
          ref={virtRef}
          key={sessionId}
          className="audit-list"
          data-testid="audit-list"
          style={{ height: "100%" }}
          data={visibleRows}
          initialTopMostItemIndex={visibleRows.length - 1}
          followOutput={following ? "auto" : false}
          atBottomStateChange={setFollowing}
          computeItemKey={(_index, row) => row.key}
          itemContent={(index, row) => (
            <AuditRowItem
              row={row}
              expanded={expanded.has(row.key)}
              hit={hitSet.has(index)}
              onToggle={toggleExpanded}
            />
          )}
        />
        {!following && (
          <button
            type="button"
            className="audit-latest-fab"
            data-testid="audit-jump-latest"
            onClick={jumpLatest}
          >
            回到最新 ↓
          </button>
        )}
      </div>
    )
  })()

  return (
    <div className="audit-view" data-testid="audit-view">
      <div className="view-head">
        <h2 className="view-title">审计</h2>
        <span className="audit-session-chip" data-testid="audit-session-chip">
          {sessionTitle ?? (sessionId !== null ? sessionId : "未选择会话")}
        </span>
      </div>

      <div className="audit-toolbar">
        <div className="audit-toolbar-row" role="group" aria-label="行类型过滤">
          {ALL_KINDS.map((kind) => (
            <label key={kind} className="audit-kind-toggle">
              <input
                type="checkbox"
                data-testid={`kind-${kind}`}
                checked={filter.kinds[kind]}
                onChange={(e) => setKind(kind, e.target.checked)}
              />
              {KIND_LABELS[kind]}
            </label>
          ))}
        </div>
        <div className="audit-toolbar-row">
          <input
            type="search"
            className="audit-kw"
            data-testid="audit-keyword"
            placeholder="搜索事件内容…"
            value={filter.keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword !== "" && (
            <span className="audit-hits muted" data-testid="audit-hit-count">
              命中 {hits.length > 0 ? (hitCursor % hits.length) + 1 : 0}/{hits.length}
            </span>
          )}
          <button
            type="button"
            className="audit-jump-btn"
            data-testid="audit-hit-prev"
            disabled={hits.length === 0}
            onClick={() => jumpHit(-1)}
          >
            ↑ 上一处
          </button>
          <button
            type="button"
            className="audit-jump-btn"
            data-testid="audit-hit-next"
            disabled={hits.length === 0}
            onClick={() => jumpHit(1)}
          >
            ↓ 下一处
          </button>
          <button
            type="button"
            className="audit-jump-btn"
            data-testid="audit-jump-compaction-prev"
            disabled={compactionIndexes.length === 0}
            onClick={() => void jumpRows(compactionIndexes, -1)}
          >
            ↑ 上次压缩
          </button>
          <button
            type="button"
            className="audit-jump-btn"
            data-testid="audit-jump-compaction-next"
            disabled={compactionIndexes.length === 0}
            onClick={() => void jumpRows(compactionIndexes, 1)}
          >
            ↓ 下次压缩
          </button>
          <select
            className="audit-time-preset"
            data-testid="audit-time-preset"
            value={filter.timePreset}
            onChange={(e) => setTimePreset(e.target.value as TimePreset)}
          >
            {TIME_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {filter.timePreset === "custom" && (
            <>
              <input
                type="datetime-local"
                className="audit-time-input"
                data-testid="audit-time-from"
                value={isoToLocalInput(filter.timeFrom)}
                onChange={(e) => setTimeBound("timeFrom", localInputToIso(e.target.value))}
              />
              <span className="muted">–</span>
              <input
                type="datetime-local"
                className="audit-time-input"
                data-testid="audit-time-to"
                value={isoToLocalInput(filter.timeTo)}
                onChange={(e) => setTimeBound("timeTo", localInputToIso(e.target.value))}
              />
            </>
          )}
        </div>
      </div>

      {notice !== null && (
        <div className="audit-notice muted" data-testid="audit-notice" role="status">
          {notice}
        </div>
      )}
      {liveError !== null && phase !== "error" && (
        <div className="audit-error-bar" data-testid="audit-live-error" role="status">
          <span className="form-error">实时更新失败：{liveError}</span>
          <button
            type="button"
            className="audit-retry"
            data-testid="audit-live-retry"
            onClick={() => {
              setLiveError(null)
              liveRetryRef.current?.()
            }}
          >
            重试
          </button>
        </div>
      )}
      {phase === "error" && (
        <div className="audit-error-bar" data-testid="audit-error" role="alert">
          <span className="form-error">{errorText}</span>
          <button
            type="button"
            className="audit-retry"
            data-testid="audit-retry"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            重试
          </button>
        </div>
      )}

      {rowsBody}
    </div>
  )
}
