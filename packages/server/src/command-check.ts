/**
 * The ws command protocol's single validation point: one pure function turns
 * a raw parsed frame into "authenticated / legal command / error frame /
 * reject", keeping every rule and error message byte-identical to the inline
 * checks it replaced in ws.ts (zero-behavior-change move — the frame shapes
 * it validates against are the typed canon in @kclaw/core/protocol).
 *
 * Ordering contract (mirrors the original switch exactly): availability
 * checks (run manager, session existence, attachments dir) run BEFORE the
 * per-field shape checks of their command, so the error a hostile or buggy
 * client sees never changes.
 */
import { join } from "node:path"
import { realpathWithin, type AttachmentRef } from "@kclaw/core"
import type { ClientCommand, SendMessageFrame } from "@kclaw/core"
import { tokenEquals } from "./auth.js"

/** A client→daemon command with its fields validated and narrowed (auth handled separately). */
export type ValidCommand = Exclude<ClientCommand, { type: "auth" }>

export type FrameCheck =
  /** Pre-auth auth frame with a matching token — the caller completes the handshake. */
  | { kind: "authenticated" }
  /** A legal command, ready to dispatch (no further validation needed). */
  | { kind: "command"; command: ValidCommand }
  /** Reply `{type:"error", message}` and keep the connection open. */
  | { kind: "error"; message: string }
  /** Pre-auth violation — error frame "unauthorized" + close 4001. */
  | { kind: "reject" }

export interface CheckDeps {
  /** Whether this connection has already authenticated. */
  authenticated: boolean
  /** The daemon's bearer token (compared timing-safely). */
  token: string
  /** Whether the RunManager (and its confirmation broker) is wired. */
  hasRun: boolean
  /** Session-existence probe for send_message ("session not found"). */
  sessionExists(sessionId: string): boolean
  /** The daemon's attachments dir; undefined disables send_message attachments. */
  attachmentsDir?: string
}

/**
 * Validate one parsed command frame. `frame` must already be a JSON object
 * (the JSON/object checks live in ws.ts — they precede auth handling).
 */
export function checkCommandFrame(frame: object, deps: CheckDeps): FrameCheck {
  const msg = frame as {
    type?: unknown
    token?: unknown
    sessionId?: unknown
    confirmationId?: unknown
    questionId?: unknown
    answers?: unknown
    decision?: unknown
    client?: unknown
    text?: unknown
    attachments?: unknown
    disposition?: unknown
    target?: unknown
    messageId?: unknown
    fromMessageId?: unknown
  }

  if (!deps.authenticated) {
    if (msg.type !== "auth") return { kind: "reject" }
    if (typeof msg.token !== "string" || !tokenEquals(msg.token, deps.token)) return { kind: "reject" }
    return { kind: "authenticated" }
  }

  switch (msg.type) {
    case "auth":
      return { kind: "error", message: "already authenticated" }
    case "subscribe":
    case "unsubscribe": {
      const { sessionId } = msg
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { kind: "error", message: `${msg.type} requires a non-empty string sessionId` }
      }
      return { kind: "command", command: { type: msg.type, sessionId } }
    }
    case "confirmation.resolve": {
      if (!deps.hasRun) {
        return { kind: "error", message: "confirmation gateway unavailable" }
      }
      const { confirmationId, decision, client } = msg
      if (typeof confirmationId !== "string" || confirmationId.length === 0
        || (decision !== "once" && decision !== "project" && decision !== "global" && decision !== "reject")) {
        return {
          kind: "error",
          message: 'confirmation.resolve requires a non-empty string confirmationId and decision "once" | "project" | "global" | "reject"',
        }
      }
      if (client !== undefined && client !== "cli" && client !== "web") {
        return { kind: "error", message: 'confirmation.resolve client must be "cli" or "web"' }
      }
      return {
        kind: "command",
        command: {
          type: "confirmation.resolve",
          confirmationId,
          decision,
          ...(client !== undefined ? { client } : {}),
        },
      }
    }
    case "question.resolve": {
      if (!deps.hasRun) {
        return { kind: "error", message: "question gateway unavailable" }
      }
      const { questionId, answers, client } = msg
      const answersOk = Array.isArray(answers)
        && answers.every((perQ) => Array.isArray(perQ) && perQ.every((a) => typeof a === "string"))
      if (typeof questionId !== "string" || questionId.length === 0 || !answersOk) {
        return {
          kind: "error",
          message: "question.resolve requires a non-empty string questionId and answers as string[][] (one array per question)",
        }
      }
      if (client !== undefined && client !== "cli" && client !== "web") {
        return { kind: "error", message: 'question.resolve client must be "cli" or "web"' }
      }
      return {
        kind: "command",
        command: {
          type: "question.resolve",
          questionId,
          answers: answers as string[][],
          ...(client !== undefined ? { client } : {}),
        },
      }
    }
    case "send_message": {
      if (!deps.hasRun) {
        return { kind: "error", message: "run manager not available" }
      }
      const { sessionId, text, attachments, disposition, target } = msg
      if (typeof sessionId !== "string" || sessionId.length === 0
        || typeof text !== "string" || text.length === 0) {
        return { kind: "error", message: "send_message requires a non-empty string sessionId and a non-empty string text" }
      }
      if (disposition !== undefined && disposition !== "steer" && disposition !== "wait" && disposition !== "interrupt") {
        return { kind: "error", message: 'send_message disposition must be "steer", "wait" or "interrupt"' }
      }
      // `target` aims the message at one team member (agent-team): the session
      // must be the team lead. Validation of the name itself is the host's.
      if (target !== undefined && (typeof target !== "string" || target.length === 0)) {
        return { kind: "error", message: "send_message target must be a non-empty string (a member name)" }
      }
      if (!deps.sessionExists(sessionId)) {
        return { kind: "error", message: "session not found" }
      }
      // Attachment refs are the one client-controlled path that reaches disk
      // reads: the realpath check below confines every ref to the session's
      // own attachments dir, so a token holder cannot read arbitrary files on
      // this machine through the daemon (run.ts re-checks as defense in
      // depth; this gate keeps hostile refs out of the queue entirely).
      const refs = parseAttachmentRefs(attachments, deps.attachmentsDir, sessionId)
      if (refs === undefined) {
        return { kind: "error", message: "send_message attachments are invalid" }
      }
      const command: SendMessageFrame = {
        type: "send_message",
        sessionId,
        text,
        ...(disposition !== undefined ? { disposition } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(refs.length > 0 ? { attachments: refs } : {}),
      }
      return { kind: "command", command }
    }
    case "message.retry": {
      if (!deps.hasRun) {
        return { kind: "error", message: "run manager not available" }
      }
      const { sessionId, fromMessageId, text, attachments } = msg
      // text may be empty: a pure-attachment question is re-run with empty
      // text; "no text AND no attachments" is rejected by the run manager,
      // the only place that knows whether the redone turn carries attachments.
      if (typeof sessionId !== "string" || sessionId.length === 0
        || typeof fromMessageId !== "string" || fromMessageId.length === 0
        || typeof text !== "string") {
        return { kind: "error", message: "message.retry requires a non-empty string sessionId, a non-empty string fromMessageId and a string text" }
      }
      if (!deps.sessionExists(sessionId)) {
        return { kind: "error", message: "session not found" }
      }
      // Same disk-read confinement as send_message: refs must live inside the
      // session's own attachments dir.
      const refs = parseAttachmentRefs(attachments, deps.attachmentsDir, sessionId)
      if (refs === undefined) {
        return { kind: "error", message: "message.retry attachments are invalid" }
      }
      return {
        kind: "command",
        command: {
          type: "message.retry",
          sessionId,
          fromMessageId,
          text,
          ...(refs.length > 0 ? { attachments: refs } : {}),
        },
      }
    }
    case "queue.cancel": {
      if (!deps.hasRun) {
        return { kind: "error", message: "run manager not available" }
      }
      const { sessionId, messageId } = msg
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { kind: "error", message: "queue.cancel requires a non-empty string sessionId" }
      }
      if (messageId !== undefined && typeof messageId !== "string") {
        return { kind: "error", message: "queue.cancel messageId must be a string" }
      }
      return {
        kind: "command",
        command: { type: "queue.cancel", sessionId, ...(messageId !== undefined ? { messageId } : {}) },
      }
    }
    case "run.cancel": {
      if (!deps.hasRun) {
        return { kind: "error", message: "run manager not available" }
      }
      const { sessionId } = msg
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { kind: "error", message: "run.cancel requires a non-empty string sessionId" }
      }
      return { kind: "command", command: { type: "run.cancel", sessionId } }
    }
    case "compaction.cancel": {
      if (!deps.hasRun) {
        return { kind: "error", message: "run manager not available" }
      }
      const { sessionId } = msg
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { kind: "error", message: "compaction.cancel requires a non-empty string sessionId" }
      }
      return { kind: "command", command: { type: "compaction.cancel", sessionId } }
    }
    default:
      return {
        kind: "error",
        message: `unknown command: ${typeof msg.type === "string" ? msg.type : JSON.stringify(msg.type)}`,
      }
  }
}

/**
 * Validate and normalize `send_message` attachments. Returns undefined when
 * the array (or any entry) is malformed, or when a path escapes the session's
 * attachments dir — undefined means "reject the whole message".
 */
function parseAttachmentRefs(
  attachments: unknown,
  attachmentsDir: string | undefined,
  sessionId: string,
): AttachmentRef[] | undefined {
  if (attachments === undefined) return []
  if (!Array.isArray(attachments)) return undefined
  if (attachmentsDir === undefined) return undefined // no uploads configured
  const refs: AttachmentRef[] = []
  for (const raw of attachments) {
    if (typeof raw !== "object" || raw === null) return undefined
    const { path, name, size, mimeType } = raw as Record<string, unknown>
    if (typeof path !== "string" || typeof name !== "string" || name.length === 0
      || typeof size !== "number" || typeof mimeType !== "string") {
      return undefined
    }
    const root = realpathWithin(join(attachmentsDir, sessionId))
    const resolved = realpathWithin(path)
    if (resolved !== root && !resolved.startsWith(root + "/")) return undefined
    refs.push({ path: resolved, name, size, mimeType })
  }
  return refs
}
