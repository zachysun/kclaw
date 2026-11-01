/**
 * ChangesPanel — the in-chat change drawer: a floating chip ("⇎ 改动 · N",
 * hidden while the session has no change records) over the chat area's
 * top-right corner, sliding out a list-plus-detail drawer (same slot as the
 * team/goal panels).
 *
 * Data: the aggregation comes from GET /sessions/:id/changes (server-side
 * scan of the event stream — ok write calls only, compaction-proof); the
 * "当前全文" tab reads GET /sessions/:id/changes/file on demand. The panel
 * refetches the list when ChatPanel bumps refreshTick (a message frame
 * carrying new write activity arrived), so a live run grows the list.
 */
import { useCallback, useEffect, useState } from "react"
import type React from "react"
import type { ChangeFile } from "@kclaw/core/protocol"
import type { ApiClient } from "../api.js"
import { DiffView } from "./DiffView.js"
import { CodeView } from "./CodeView.js"
import { langFromPath } from "./lang.js"

type FileBody =
  | { state: "ok"; content: string; bytes: number }
  | { state: "binary"; bytes: number }
  | { state: "missing" }
  | { state: "too-large" }
  | { state: "error"; message: string }

/** Tool-card jump signal: open the drawer focused on one file (a fresh
 * object identity each time, so repeated clicks re-run the focus effect). */
export interface ChangesFocus {
  path: string
}

export interface ChangesPanelProps {
  api: ApiClient
  sessionId: string
  /** +1 on run-final frames — refetch while closed (chip count) too. */
  refreshTick: number
  /** +1 on every message frame — refetched only while the drawer is open. */
  messageTick: number
  focus: ChangesFocus | null
}

function timeShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return sameDay ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ChangesPanel({ api, sessionId, refreshTick, messageTick, focus }: ChangesPanelProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<ChangeFile[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<"content" | "history">("content")
  const [body, setBody] = useState<FileBody | null>(null)

  const reload = useCallback((): void => {
    api.get<{ files: ChangeFile[] }>(`/sessions/${encodeURIComponent(sessionId)}/changes`)
      // 响应形状不信任：缺 files 字段（测试桩、异常网关）视同空清单。
      .then((r) => setFiles(Array.isArray(r?.files) ? r.files : []))
      .catch(() => setFiles([])) // 清单拉不到时胶囊静默——少一个入口不碍聊天
  }, [api, sessionId])

  // 会话切换：整体回到收起态再重拉（列表是会话局部的）。
  useEffect(() => {
    setFiles(null)
    setOpen(false)
    setSelected(null)
    setTab("content")
  }, [sessionId])
  // run 收尾帧无条件重拉（胶囊计数在关闭时也要新）。
  useEffect(() => { reload() }, [reload, refreshTick])
  // 抽屉开着时每个消息帧都重拉（正在看的清单即时长出来）；关闭时不跟随
  // message 帧——那是流式期间每步一次 events.jsonl 全量扫描，中间态拉取没有意义。
  useEffect(() => {
    if (!open) return
    reload()
  }, [open, messageTick, reload])

  // 工具卡的跳转信号：展开抽屉并定位到该文件的当前全文（focus 每次点击
  // 都是新对象，重复点击同一路径也会重新触发定位）。
  useEffect(() => {
    if (focus === null) return
    setOpen(true)
    setSelected(focus.path)
    setTab("content")
  }, [focus])

  // 选中文件的当前全文：每次选中/切换 tab 时现读（磁盘现状，不做缓存）。
  useEffect(() => {
    if (selected === null || tab !== "content") return
    setBody(null)
    api.get<{ content?: string; bytes?: number; binary?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/changes/file?path=${encodeURIComponent(selected)}`,
    )
      .then((r) => {
        if (r?.binary === true) setBody({ state: "binary", bytes: r.bytes ?? 0 })
        else if (typeof r?.content === "string") setBody({ state: "ok", content: r.content, bytes: r.bytes ?? 0 })
        else setBody({ state: "error", message: "响应缺少内容" })
      })
      .catch((err: { status?: number; message?: string }) => {
        if (err?.status === 404) setBody({ state: "missing" })
        else if (err?.status === 413) setBody({ state: "too-large" })
        else setBody({ state: "error", message: err instanceof Error ? err.message : String(err) })
      })
  }, [api, sessionId, selected, tab])

  const selectedFile = files?.find((f) => f.path === selected) ?? null
  const chipVisible = files !== null && (files.length > 0 || open)

  return (
    // The wrapper is position:static, so the drawer's absolute containing
    // block is the chat area itself (the wrapper just hosts the chip in the
    // float-panels column).
    <div className="changes-wrap">
      {chipVisible && (
        <button type="button" className="changes-chip" data-testid="changes-chip" onClick={() => setOpen(!open)}>
          ⇎ 改动 · {files?.length ?? 0}
        </button>
      )}
      {open && (
        <div className="changes-drawer" data-testid="changes-drawer">
          <div className="changes-head">
            <span className="changes-title">改动 · {files?.length ?? 0} 个文件</span>
            <button type="button" className="changes-close" data-testid="changes-close" aria-label="关闭改动抽屉" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="changes-body">
            <ul className="changes-list" data-testid="changes-list">
              {(files ?? []).map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className={`changes-item${selected === f.path ? " on" : ""}`}
                    onClick={() => { setSelected(f.path); setTab("content") }}
                  >
                    <span className="changes-item-path">{f.relativePath ?? f.path}</span>
                    <span className="changes-item-meta">{f.ops.length} 次 · {timeShort(f.lastAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="changes-detail" data-testid="changes-detail">
              {selectedFile === null ? (
                <div className="changes-empty">选择一个文件查看改动</div>
              ) : (
                <>
                  <div className="changes-detail-head">
                    <span className="changes-detail-path">{selectedFile.relativePath ?? selectedFile.path}</span>
                    <div className="changes-tabs">
                      <button type="button" className={tab === "content" ? "on" : ""} onClick={() => setTab("content")}>当前全文</button>
                      <button type="button" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>改动历史</button>
                    </div>
                  </div>
                  {tab === "content" ? (
                    <div className="changes-detail-body" data-testid="changes-content">
                      {body === null ? (
                        <div className="changes-empty">读取中…</div>
                      ) : body.state === "ok" ? (
                        <CodeView content={body.content} lang={langFromPath(selectedFile.path)} />
                      ) : body.state === "binary" ? (
                        <div className="changes-empty">二进制文件，不支持内容预览（{formatBytes(body.bytes)}）</div>
                      ) : body.state === "missing" ? (
                        <div className="changes-empty">文件已不在磁盘上（改动历史仍可回看）</div>
                      ) : body.state === "too-large" ? (
                        <div className="changes-empty">文件超过 1 MiB，不支持预览</div>
                      ) : (
                        <div className="changes-empty">读取失败：{body.message}</div>
                      )}
                    </div>
                  ) : (
                    <div className="changes-detail-body" data-testid="changes-history">
                      {selectedFile.ops.map((op) => (
                        <div key={op.callId} className="changes-op">
                          <div className="changes-op-head">
                            <span className={`changes-op-tool changes-op-${op.tool}`}>
                              {op.tool === "fs_edit" ? "✎ fs_edit" : "+ fs_write"}
                            </span>
                            <span className="changes-op-time">{timeShort(op.at)}</span>
                          </div>
                          {op.tool === "fs_edit" ? (
                            <DiffView oldText={op.args.old ?? ""} newText={op.args.new ?? ""} lang={langFromPath(selectedFile.path)} compact />
                          ) : (
                            <details className="changes-op-write">
                              <summary>写入 {formatBytes(new TextEncoder().encode(op.args.content ?? "").length)}</summary>
                              <CodeView content={op.args.content ?? ""} lang={langFromPath(selectedFile.path)} compact />
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
