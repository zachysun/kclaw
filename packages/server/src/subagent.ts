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
 *   and confirmation.requested/resolved are FORWARDED to the parent channel
 *   with a "来自子代理" note — the parent's subscribers (web/CLI) then show
 *   the card where the user is looking, and verdicts settle through the same
 *   global broker by confirmationId.
 * - Parent abort → run.cancel(child): the child stops at its next checkpoint
 *   (parent-stop-child-stop), and the outcome settles the dispatch.
 *
 * Everything child-specific in the ENGINE (lean prompt, surface, memory
 * isolation, usage attribution) keys off the session meta's parentSessionId —
 * this module only supplies that fact plus the lifecycle.
 */
import {
  makeEvent,
  subagentTitle,
  truncateAnswer,
  type AgentEvent as CoreAgentEvent,
  type EventType,
  type KclawConfig,
  type EventBus,
  type RunOutcome,
  type SessionStore,
  type SubagentSpawnRequest,
  type SubagentSpawnResult,
  type SubagentSpawner,
} from "@kclaw/core"
import type { RunManager } from "./run.js"

/** The event catalog as a discriminated union (switch narrows payload per case). */
type AnyAgentEvent = { [T in EventType]: CoreAgentEvent<T> }[EventType]

/** Minimum gap between two status lines (the "每隔一段时间更新" contract). */
const STATUS_INTERVAL_MS = 2_000

/** Chars of a text-delta excerpt shown in a status line. */
const STATUS_EXCERPT_CHARS = 80

export interface SubagentHostDeps {
  config: KclawConfig
  sessions: SessionStore
  bus: EventBus
  /** Late-bound: the spawner is wired into RunManager's deps before the manager exists. */
  getRun: () => RunManager
}

/** Build the daemon's spawner (one per daemon; per-parent live counts live here). */
export function createSubagentSpawner(deps: SubagentHostDeps): SubagentSpawner {
  const maxConcurrent = deps.config.subagents?.maxConcurrent ?? 4
  /** Live child session ids per parent session (the per-run concurrency cap). */
  const live = new Map<string, Set<string>>()

  return async (req: SubagentSpawnRequest): Promise<SubagentSpawnResult> => {
    const parent = deps.sessions.meta(req.parentSessionId)
    if (parent === undefined) {
      return { status: "error", output: `subagent dispatch failed: parent session not found (${req.parentSessionId})` }
    }
    // Cap first: an over-cap dispatch must not even create a session.
    const children = live.get(req.parentSessionId) ?? new Set<string>()
    if (children.size >= maxConcurrent) {
      return { status: "error", output: `已达子代理并发上限（${maxConcurrent} 个同时运行）；等现有子代理结束后再派` }
    }
    // A parent aborted before the dispatch started: nothing to run.
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
    children.add(child.id)
    live.set(req.parentSessionId, children)

    // Status + confirmation forwarding: one bus subscriber on the child channel.
    let lastStatusAt = 0
    let latestText = ""
    const status = (line: string, force = false): void => {
      const now = Date.now()
      if (!force && now - lastStatusAt < STATUS_INTERVAL_MS) return
      lastStatusAt = now
      req.onStatus(`${line}\n`)
    }
    const who = label ?? child.id
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
        switch (e.type) {
          case "message.created":
            if (e.payload?.message?.role === "assistant") status(`▸ 生成中`)
            break
          case "tool_call.completed": {
            const block = e.payload.block
            if (block.type !== "tool_call") break
            latestText = ""
            status(`▸ 调用工具 ${block.name}`, true)
            break
          }
          case "text.delta":
            latestText += e.payload.delta
            status(`▸ 生成：${excerpt(latestText)}`)
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
          default:
            break
        }
      },
    }
    deps.bus.subscribe(child.id, subscriber)

    let settled = false
    const teardown = (): void => {
      if (settled) return
      settled = true
      deps.bus.unsubscribe(child.id, subscriber)
      children.delete(child.id)
      if (children.size === 0) live.delete(req.parentSessionId)
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
