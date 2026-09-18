/**
 * The server-side subagent spawner — what `subagent_run` actually does.
 *
 * One dispatch = one child session + one run + one bus subscriber:
 * - The child session is created with `parentSessionId`, the parent's workdir
 *   and mode (frozen at creation like every session), and the parent's
 *   session-level model override; its run submits with trigger "agent".
 * - A plain bus subscriber (EventBus takes any {send} shape) watches the
 *   child's channel: tool calls and text deltas become throttled one-line
 *   status (the tool's onOutput → tool_result.delta on the PARENT channel),
 *   and confirmation/question requested/resolved are FORWARDED to the parent
 *   channel — the parent's subscribers (web/CLI) then show the card where the
 *   user is looking, and verdicts/answers settle through the same global
 *   broker by id.
 * - Parent abort → run.cancel(child): the child stops at its next checkpoint
 *   (parent-stop-child-stop), and the outcome settles the dispatch. Background
 *   dispatches (issue #22) deliberately SKIP this: their lifecycle attaches to
 *   the parent SESSION, so a parent-run abort/finish never cancels them.
 *
 * Background mode adds three pieces, all keyed by the parent session:
 * - an immediate tool result (child session id + label), the child keeps
 *   running past the parent run's end;
 * - a completion DELIVERY (#44): when the child settles, its report enters
 *   the parent through RunManager.submit (trigger "agent") — a real new run
 *   that digests the full answer and replies, on every surface at once. The
 *   report message carries a kind:"subagent" note declaring it
 *   machine-originated. If submit refuses (queue full / wake budget
 *   exhausted) the delivery degrades to the legacy shell assistant message +
 *   system note, so a completion is never silently lost;
 * - `cancelBackgroundForParent` for the delete/purge cascade (the routes
 *   call it before soft-deleting, so nothing keeps running orphaned).
 *
 * `collector` backs the `subagent_collect` tool: read a child's final answer
 * later, gated to the parent that spawned it.
 *
 * Everything child-specific in the ENGINE (lean prompt, surface, memory
 * isolation, usage attribution) keys off the session meta's parentSessionId —
 * this module only supplies that fact plus the lifecycle.
 */
import {
  makeEvent,
  newMessage,
  newBlockId,
  subagentTitle,
  truncateAnswer,
  type AnyAgentEvent,
  type KclawConfig,
  type EventBus,
  type RunOutcome,
  type SessionStore,
  type SubagentCollector,
  type SubagentSpawnRequest,
  type SubagentSpawnResult,
  type SubagentSpawner,
} from "@kclaw/core"
import type { RunManager } from "./run.js"

/** Minimum gap between two status lines (the "每隔一段时间更新" contract). */
const STATUS_INTERVAL_MS = 2_000

/** Chars of a text-delta excerpt shown in a status line. */
const STATUS_EXCERPT_CHARS = 80

/** Chars of the child answer carried by a background completion notice. */
const NOTICE_EXCERPT_CHARS = 400

/** 后台子代理落定的通知载荷（完成回投后由宿主发出；IM 频道转发为推送卡）。 */
export interface BackgroundSettlement {
  parentId: string
  childId: string
  who: string
  ok: boolean
  excerpt: string
}

export interface SubagentHostDeps {
  config: KclawConfig
  sessions: SessionStore
  bus: EventBus
  /** Late-bound: the spawner is wired into RunManager's deps before the manager exists. */
  getRun: () => RunManager
  /** 可选：后台子代理落定（投递或回退）后的回调；daemon 用它接 IM 推送。 */
  onBackgroundSettled?: (info: BackgroundSettlement) => void
}

/** What the daemon wires: the spawner, the collector, and the delete-cascade cancel. */
export interface SubagentHost {
  spawner: SubagentSpawner
  collector: SubagentCollector
  /**
   * Cancel every background child of one parent session (delete/purge
   * cascade). Returns how many were still live — informational only.
   */
  cancelBackgroundForParent(parentSessionId: string): number
}

/** Build the daemon's subagent host (one per daemon; live counts live here). */
export function createSubagentHost(deps: SubagentHostDeps): SubagentHost {
  const maxConcurrent = deps.config.subagents?.maxConcurrent ?? 4
  const maxBackground = deps.config.subagents?.maxBackground ?? 4
  /**
   * Live children, one record per child session: its parent and the dispatch
   * mode. The per-mode caps and the delete-cascade cancel scan this by
   * parent+mode — a handful of entries at most (caps are 4+4), so a scan is
   * free and every consumer reads the same source.
   */
  const live = new Map<string, { parentId: string; mode: "blocking" | "background" }>()

  const spawner: SubagentSpawner = async (req: SubagentSpawnRequest): Promise<SubagentSpawnResult> => {
    const parent = deps.sessions.meta(req.parentSessionId)
    if (parent === undefined) {
      return { status: "error", output: `subagent dispatch failed: parent session not found (${req.parentSessionId})` }
    }
    const mode = req.background === true ? "background" : "blocking"
    const background = mode === "background"
    // Cap first: an over-cap dispatch must not even create a session. The two
    // budgets are counted separately (issue #22) so background tasks cannot
    // starve foreground dispatches (or vice versa).
    let own = 0
    for (const rec of live.values()) {
      if (rec.parentId === req.parentSessionId && rec.mode === mode) own++
    }
    const cap = mode === "background" ? maxBackground : maxConcurrent
    if (own >= cap) {
      return {
        status: "error",
        output: mode === "background"
          ? `已达后台子代理并发上限（${maxBackground} 个同时运行）；等现有后台任务结束后再派，或改用阻塞模式`
          : `已达子代理并发上限（${maxConcurrent} 个同时运行）；等现有子代理结束后再派`,
      }
    }
    // A parent aborted before the dispatch started: nothing to run. (Background
    // dispatches don't carry the run signal at all — checked in the tool.)
    if (req.signal?.aborted === true) {
      return { status: "error", output: "run aborted before subagent dispatch" }
    }

    const label = req.label?.trim() === "" ? undefined : req.label
    const child = deps.sessions.create(
      subagentTitle(label, req.task),
      undefined,
      parent.workdir,
      parent.mode ?? "default",
      req.parentSessionId,
    )
    live.set(child.id, { parentId: req.parentSessionId, mode })
    const who = label ?? child.id

    // Status + confirmation forwarding: one bus subscriber on the child channel.
    let lastStatusAt = 0
    let latestText = ""
    const status = (line: string, force = false): void => {
      const now = Date.now()
      if (!force && now - lastStatusAt < STATUS_INTERVAL_MS) return
      lastStatusAt = now
      req.onStatus(`${line}\n`)
    }
    const forwardCtx = (e: AnyAgentEvent): { sessionId: string; runId?: string } =>
      e.runId === undefined ? { sessionId: req.parentSessionId } : { sessionId: req.parentSessionId, runId: e.runId }
    const subscriber = {
      send(data: string): void {
        let e: AnyAgentEvent
        try {
          e = JSON.parse(data) as AnyAgentEvent
        } catch {
          return
        }
        // A background dispatch has already returned its tool result — status
        // lines have no onOutput left to flow into; the CARDS STILL FORWARD
        // (a background child's sensitive calls must reach the user too).
        switch (e.type) {
          case "message.created":
            if (!background && e.payload?.message?.role === "assistant") status(`▸ 生成中`)
            break
          case "tool_call.completed": {
            if (background) break
            const block = e.payload.block
            if (block.type !== "tool_call") break
            latestText = ""
            status(`▸ 调用工具 ${block.name}`, true)
            break
          }
          case "text.delta":
            if (!background) {
              latestText += e.payload.delta
              status(`▸ 生成：${excerpt(latestText)}`)
            }
            break
          case "confirmation.requested": {
            // The card lands on the PARENT channel (where the user is looking),
            // labeled with the subagent; resolution stays global by id.
            deps.bus.emit(makeEvent("confirmation.requested", {
              ...e.payload,
              noteText: e.payload.noteText === undefined
                ? `来自子代理 ${who}`
                : `来自子代理 ${who} · ${e.payload.noteText}`,
            }, forwardCtx(e)))
            break
          }
          case "confirmation.resolved":
            deps.bus.emit(makeEvent("confirmation.resolved", { ...e.payload }, forwardCtx(e)))
            break
          case "question.requested": {
            // Same forwarding rule as confirmation cards (issue #21): the
            // card lands on the parent channel labeled with the subagent;
            // resolution stays global by id on the shared broker.
            deps.bus.emit(makeEvent("question.requested", {
              ...e.payload,
              noteText: e.payload.noteText === undefined
                ? `来自子代理 ${who}`
                : `来自子代理 ${who} · ${e.payload.noteText}`,
            }, forwardCtx(e)))
            break
          }
          case "question.resolved":
            deps.bus.emit(makeEvent("question.resolved", { ...e.payload }, forwardCtx(e)))
            break
          default:
            break
        }
      },
    }
    deps.bus.subscribe(child.id, subscriber)

    const teardown = (): void => {
      deps.bus.unsubscribe(child.id, subscriber)
      live.delete(child.id)
    }

    // Parent-stop-child-stop is a BLOCKING-mode contract: aborting the parent
    // run cancels the child run. A background child deliberately has no such
    // listener — its lifecycle belongs to the parent SESSION.

    if (background) {
      // Fire and forget: the submit decides synchronously (a throw here is a
      // dispatch failure the tool result reports immediately); the outcome is
      // consumed by the completion notice, not by a waiting tool call.
      try {
        const submitted = deps.getRun().submit(child.id, {
          userText: req.task,
          trigger: "agent",
          disposition: "wait",
          ...(parent.model !== undefined && parent.model !== "" ? { model: parent.model } : {}),
        })
        void submitted.outcome
          .then((outcome) => deliverCompletion(req.parentSessionId, child.id, who, req.task, outcome))
          .catch((err: unknown) => {
            deps.sessions.meta(req.parentSessionId) !== undefined &&
              console.error(`kclaw subagent background (${who}) outcome lost:`, err)
          })
          .finally(teardown)
      } catch (err) {
        teardown()
        return {
          status: "error",
          output: `subagent dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          childSessionId: child.id,
        }
      }
      return {
        status: "ok",
        output: `已在后台派出子代理「${who}」（会话 ${child.id}）。它会独立运行，不受本次对话结束影响；完成后结题报告会自动投递回本会话并触发新一轮分析，届时可用 subagent_collect（childSessionId: ${child.id}）按需取完整答复。`,
        childSessionId: child.id,
      }
    }

    // Parent-stop-child-stop: aborting the parent run cancels the child run;
    // the child's outcome then settles (quickly) below.
    const onAbort = (): void => {
      try {
        deps.getRun().cancel(child.id)
      } catch {
        // the daemon is tearing down — the in-memory run dies with it
      }
    }
    req.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const outcome = await deps.getRun().submit(child.id, {
        userText: req.task,
        trigger: "agent",
        disposition: "wait",
        // The parent's session-level model override rides along (resolved the
        // same way a mainline run resolves it).
        ...(parent.model !== undefined && parent.model !== "" ? { model: parent.model } : {}),
      }).outcome
      return shapeResult(outcome, child.id, who)
    } catch (err) {
      return {
        status: "error",
        output: `subagent dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        childSessionId: child.id,
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort)
      teardown()
    }
  }

  /**
   * The completion delivery (#44): the report enters the parent through the
   * ordinary submit door (trigger "agent", forced wait) as a NEW run —
   * queueing/audit/compaction/permissions all apply with zero special-casing.
   * The report template: status line, the original task, then the full
   * (head+tail truncated) answer; the machine-originated identity rides the
   * kind:"subagent" note, not the body. On refusal (queue full / wake budget
   * exhausted) the delivery degrades to the legacy notice with the reason —
   * a completion is never silently lost.
   */
  const deliverCompletion = (parentId: string, childId: string, who: string, task: string, outcome: RunOutcome): void => {
    // The parent may have been deleted while the child ran — nothing to deliver.
    const meta = deps.sessions.meta(parentId)
    if (meta === undefined || meta.deleted) return
    const ok = outcome.stopReason === "end_turn"
    const answer = truncateAnswer(answerOf(outcome))
    const statusLine = ok
      ? `后台子代理「${who}」已完成（会话 ${childId}）。`
      : `后台子代理「${who}」未正常完成（${outcome.stopReason}，会话 ${childId}）。`
    const report = [
      statusLine,
      `任务:${task}`,
      ...(answer === "" ? [] : [ok ? answer : `已有产出:\n${answer}`]),
    ].join("\n")
    try {
      deps.getRun().submit(parentId, {
        userText: report,
        trigger: "agent",
        note: { kind: "subagent", text: "本消息为后台子代理完成回投，非用户发言" },
      })
    } catch (err) {
      legacyNotice(parentId, childId, who, outcome, err)
    }
    deps.onBackgroundSettled?.({ parentId, childId, who, ok, excerpt: answer })
  }

  /**
   * The legacy notice: one system-note assistant message on the parent
   * session, no run. Only reached as the delivery's fallback (queue full /
   * wake budget exhausted) — the refusal reason is recorded in the note.
   */
  const legacyNotice = (parentId: string, childId: string, who: string, outcome: RunOutcome, err: unknown): void => {
    const meta = deps.sessions.meta(parentId)
    if (meta === undefined || meta.deleted) return
    const reason = err instanceof Error ? err.message : String(err)
    const answer = answerOf(outcome)
    const summary = answer === "" ? "" : excerptLong(answer)
    const text = outcome.stopReason === "end_turn"
      ? `后台子代理「${who}」已完成（会话 ${childId}）。结果摘要：${summary === "" ? "（未给出结题答复）" : summary}。完整答复可用 subagent_collect 工具获取（childSessionId: ${childId}）。`
      : `后台子代理「${who}」未正常完成（${outcome.stopReason}，会话 ${childId}）${summary === "" ? "" : `。已有产出：${summary}`}。可用 subagent_collect 查看它已产出的内容（childSessionId: ${childId}）。`
    const message = newMessage(parentId, "assistant", [
      { id: newBlockId(), type: "note", kind: "system", text: `${text}（自动投递被拒：${reason}；回退为通知）` },
    ])
    deps.sessions.appendMessage(parentId, message)
    // Announce on the parent channel so open views refresh; no run is started.
    deps.bus.emit(makeEvent("message.created", { message }, { sessionId: parentId }))
    deps.bus.emit(makeEvent("message.completed", { message }, { sessionId: parentId }))
  }

  const cancelBackgroundForParent = (parentSessionId: string): number => {
    let count = 0
    for (const [childId, rec] of live) {
      if (rec.parentId !== parentSessionId || rec.mode !== "background") continue
      count++
      try {
        deps.getRun().cancel(childId)
      } catch {
        // daemon teardown — nothing left to cancel
      }
    }
    return count
  }

  const collector: SubagentCollector = async (req) => {
    const childMeta = deps.sessions.meta(req.childSessionId)
    if (childMeta === undefined) {
      return { status: "error", output: `subagent_collect: 子代理会话不存在（${req.childSessionId}）` }
    }
    // A session may only collect its OWN children — no cross-session reads.
    if (childMeta.parentSessionId !== req.parentSessionId) {
      return { status: "error", output: "subagent_collect: 该会话不是当前会话派出的子代理" }
    }
    const msgs = deps.sessions.readMessages(req.childSessionId)
    const last = [...msgs].reverse().find((m) => m.role === "assistant")
    const answer = last === undefined
      ? ""
      : last.blocks
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n")
          .trim()
    if (answer === "") {
      return {
        status: "ok",
        output: `子代理（${req.childSessionId}）还没有可收集的答复（可能仍在运行）；完成通知出现后再收集。`,
        childSessionId: req.childSessionId,
      }
    }
    return { status: "ok", output: truncateAnswer(answer), childSessionId: req.childSessionId }
  }

  return { spawner, collector, cancelBackgroundForParent }
}

/** Long-form excerpt for completion notices (head only, single line). */
function excerptLong(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > NOTICE_EXCERPT_CHARS ? `${collapsed.slice(0, NOTICE_EXCERPT_CHARS)}…` : collapsed
}
/** The child's final assistant text (its whole visible work product), truncated head+tail. */
function answerOf(outcome: RunOutcome): string {
  const last = [...outcome.messages].reverse().find((m) => m.role === "assistant")
  if (last === undefined) return ""
  return last.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim()
}

/** Map the child run's outcome onto the tool result the parent model sees. */
function shapeResult(outcome: RunOutcome, childSessionId: string, who: string): SubagentSpawnResult {
  const answer = answerOf(outcome)
  if (outcome.stopReason === "end_turn") {
    return {
      status: "ok",
      output: answer === "" ? `子代理（${who}）已结束，但未给出结题答复` : truncateAnswer(answer),
      childSessionId,
    }
  }
  if (outcome.stopReason === "aborted") {
    return {
      status: "error",
      output: `子代理（${who}）随主任务中止而停止${answer === "" ? "" : `；中止前产出：\n${truncateAnswer(answer)}`}`,
      childSessionId,
    }
  }
  // error / max_iterations / provider death: whatever text exists is the best
  // report the parent can get — retrying is the parent model's call.
  return {
    status: "error",
    output: `子代理（${who}）未正常结束（${outcome.stopReason}）${answer === "" ? "" : `；已有产出：\n${truncateAnswer(answer)}`}`,
    childSessionId,
  }
}

/** First non-empty, whitespace-collapsed excerpt of a growing text. */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed === "") return "…"
  return collapsed.length > STATUS_EXCERPT_CHARS ? `${collapsed.slice(0, STATUS_EXCERPT_CHARS)}…` : collapsed
}
