import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCommandFrame, type CheckDeps } from "../src/command-check.js"

const TOKEN = "t1"
const SESSION = "ses_1"

/** Deps with a real temp attachments dir so attachment realpath checks run. */
function deps(over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    authenticated: true,
    token: TOKEN,
    hasRun: true,
    sessionExists: (id) => id === SESSION,
    ...over,
  }
}

/** A send_message frame builder (the field-heaviest command). */
function sendFrame(over: Record<string, unknown> = {}): object {
  return { type: "send_message", sessionId: SESSION, text: "hi", ...over }
}

describe("checkCommandFrame — auth", () => {
  it("rejects any non-auth frame before authentication", () => {
    expect(checkCommandFrame({ type: "subscribe", sessionId: "s" }, deps({ authenticated: false }))).toEqual({ kind: "reject" })
  })

  it("rejects a wrong or non-string token", () => {
    expect(checkCommandFrame({ type: "auth", token: "nope" }, deps({ authenticated: false }))).toEqual({ kind: "reject" })
    expect(checkCommandFrame({ type: "auth", token: 42 }, deps({ authenticated: false }))).toEqual({ kind: "reject" })
  })

  it("accepts a matching auth frame", () => {
    expect(checkCommandFrame({ type: "auth", token: TOKEN }, deps({ authenticated: false }))).toEqual({ kind: "authenticated" })
  })

  it("errors on a repeated auth after authentication", () => {
    expect(checkCommandFrame({ type: "auth", token: TOKEN }, deps())).toEqual({
      kind: "error",
      message: "already authenticated",
    })
  })
})

describe("checkCommandFrame — subscribe / unsubscribe", () => {
  it.each(["subscribe", "unsubscribe"])("%s requires a non-empty string sessionId", (type) => {
    expect(checkCommandFrame({ type }, deps())).toEqual({
      kind: "error",
      message: `${type} requires a non-empty string sessionId`,
    })
  })

  it("narrows a legal subscribe into a typed command", () => {
    expect(checkCommandFrame({ type: "subscribe", sessionId: SESSION }, deps())).toEqual({
      kind: "command",
      command: { type: "subscribe", sessionId: SESSION },
    })
  })
})

describe("checkCommandFrame — confirmation.resolve", () => {
  it("answers the gateway error before field checks when no run is wired", () => {
    expect(checkCommandFrame({ type: "confirmation.resolve", confirmationId: "" }, deps({ hasRun: false }))).toEqual({
      kind: "error",
      message: "confirmation gateway unavailable",
    })
  })

  it("requires a non-empty confirmationId and a boolean approved", () => {
    expect(checkCommandFrame({ type: "confirmation.resolve", confirmationId: "", approved: true }, deps())).toEqual({
      kind: "error",
      message: "confirmation.resolve requires a non-empty string confirmationId and a boolean approved",
    })
  })

  it("restricts client to cli|web", () => {
    expect(checkCommandFrame({ type: "confirmation.resolve", confirmationId: "c1", approved: true, client: "api" }, deps())).toEqual({
      kind: "error",
      message: 'confirmation.resolve client must be "cli" or "web"',
    })
  })

  it("keeps a legal client verdict and drops an absent one", () => {
    expect(checkCommandFrame({ type: "confirmation.resolve", confirmationId: "c1", approved: false, client: "web" }, deps())).toEqual({
      kind: "command",
      command: { type: "confirmation.resolve", confirmationId: "c1", approved: false, client: "web" },
    })
    expect(checkCommandFrame({ type: "confirmation.resolve", confirmationId: "c1", approved: true }, deps())).toEqual({
      kind: "command",
      command: { type: "confirmation.resolve", confirmationId: "c1", approved: true },
    })
  })
})

describe("checkCommandFrame — send_message", () => {
  it("requires the run manager before field checks", () => {
    expect(checkCommandFrame(sendFrame(), deps({ hasRun: false }))).toEqual({
      kind: "error",
      message: "run manager not available",
    })
  })

  it("requires a non-empty sessionId and text", () => {
    expect(checkCommandFrame(sendFrame({ sessionId: "" }), deps())).toEqual({
      kind: "error",
      message: "send_message requires a non-empty string sessionId and a non-empty string text",
    })
    expect(checkCommandFrame(sendFrame({ text: "" }), deps())).toEqual({
      kind: "error",
      message: "send_message requires a non-empty string sessionId and a non-empty string text",
    })
  })

  it("restricts disposition to steer|wait|interrupt", () => {
    expect(checkCommandFrame(sendFrame({ disposition: "later" }), deps())).toEqual({
      kind: "error",
      message: 'send_message disposition must be "steer", "wait" or "interrupt"',
    })
    expect(checkCommandFrame(sendFrame({ disposition: "wait" }), deps())).toEqual({
      kind: "command",
      command: { type: "send_message", sessionId: SESSION, text: "hi", disposition: "wait" },
    })
  })

  it("answers session not found before attachment checks", () => {
    expect(checkCommandFrame(sendFrame({ sessionId: "ses_x" }), deps())).toEqual({
      kind: "error",
      message: "session not found",
    })
  })

  it("rejects attachments when no attachments dir is configured", () => {
    expect(checkCommandFrame(sendFrame({ attachments: [] }), deps({ attachmentsDir: undefined }))).toEqual({
      kind: "error",
      message: "send_message attachments are invalid",
    })
  })

  it("rejects non-array or malformed attachments", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-cmdcheck-"))
    try {
      expect(checkCommandFrame(sendFrame({ attachments: "x" }), deps({ attachmentsDir: dir }))).toEqual({
        kind: "error",
        message: "send_message attachments are invalid",
      })
      expect(
        checkCommandFrame(sendFrame({ attachments: [{ path: "/etc/passwd", name: "p", size: 1, mimeType: "text/plain" }] }), deps({ attachmentsDir: dir })),
      ).toEqual({ kind: "error", message: "send_message attachments are invalid" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts refs under the session's own attachments dir and drops an empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-cmdcheck-"))
    try {
      const sessionDir = join(dir, SESSION)
      mkdirSync(sessionDir)
      const file = join(sessionDir, "a.txt")
      writeFileSync(file, "hello")
      const ref = { path: file, name: "a.txt", size: 5, mimeType: "text/plain" }
      // The check normalizes the path through realpath (macOS tmp sits on a
      // /var → /private/var symlink), so the expected ref carries the resolved path.
      const normalized = { ...ref, path: realpathSync(file) }
      const got = checkCommandFrame(sendFrame({ attachments: [ref] }), deps({ attachmentsDir: dir }))
      expect(got).toEqual({
        kind: "command",
        command: { type: "send_message", sessionId: SESSION, text: "hi", attachments: [normalized] },
      })
      // An empty array is normalized away — the command carries no field.
      expect(checkCommandFrame(sendFrame({ attachments: [] }), deps({ attachmentsDir: dir }))).toEqual({
        kind: "command",
        command: { type: "send_message", sessionId: SESSION, text: "hi" },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a symlink that resolves outside the session dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-cmdcheck-"))
    const outside = mkdtempSync(join(tmpdir(), "kclaw-outside-"))
    try {
      const sessionDir = join(dir, SESSION)
      mkdirSync(sessionDir)
      const secret = join(outside, "secret.txt")
      writeFileSync(secret, "x")
      symlinkSync(secret, join(sessionDir, "link.txt"))
      const ref = { path: join(sessionDir, "link.txt"), name: "link.txt", size: 1, mimeType: "text/plain" }
      expect(checkCommandFrame(sendFrame({ attachments: [ref] }), deps({ attachmentsDir: dir }))).toEqual({
        kind: "error",
        message: "send_message attachments are invalid",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("checkCommandFrame — cancel commands", () => {
  it.each([
    ["queue.cancel", "queue.cancel requires a non-empty string sessionId"],
    ["run.cancel", "run.cancel requires a non-empty string sessionId"],
    ["compaction.cancel", "compaction.cancel requires a non-empty string sessionId"],
  ])("%s requires a non-empty string sessionId", (type, message) => {
    expect(checkCommandFrame({ type }, deps())).toEqual({ kind: "error", message })
  })

  it("requires the run manager for every cancel command", () => {
    for (const type of ["queue.cancel", "run.cancel", "compaction.cancel"] as const) {
      expect(checkCommandFrame({ type, sessionId: SESSION }, deps({ hasRun: false }))).toEqual({
        kind: "error",
        message: "run manager not available",
      })
    }
  })

  it("restricts queue.cancel messageId to a string", () => {
    expect(checkCommandFrame({ type: "queue.cancel", sessionId: SESSION, messageId: 7 }, deps())).toEqual({
      kind: "error",
      message: "queue.cancel messageId must be a string",
    })
    expect(checkCommandFrame({ type: "queue.cancel", sessionId: SESSION, messageId: "msg_1" }, deps())).toEqual({
      kind: "command",
      command: { type: "queue.cancel", sessionId: SESSION, messageId: "msg_1" },
    })
    expect(checkCommandFrame({ type: "queue.cancel", sessionId: SESSION }, deps())).toEqual({
      kind: "command",
      command: { type: "queue.cancel", sessionId: SESSION },
    })
  })

  it("narrows legal run.cancel / compaction.cancel", () => {
    expect(checkCommandFrame({ type: "run.cancel", sessionId: SESSION }, deps())).toEqual({
      kind: "command",
      command: { type: "run.cancel", sessionId: SESSION },
    })
    expect(checkCommandFrame({ type: "compaction.cancel", sessionId: SESSION }, deps())).toEqual({
      kind: "command",
      command: { type: "compaction.cancel", sessionId: SESSION },
    })
  })
})

describe("checkCommandFrame — unknown commands", () => {
  it("echoes a string type and JSON-stringifies anything else", () => {
    expect(checkCommandFrame({ type: "dance" }, deps())).toEqual({ kind: "error", message: "unknown command: dance" })
    expect(checkCommandFrame({ type: 42 }, deps())).toEqual({ kind: "error", message: "unknown command: 42" })
    expect(checkCommandFrame({}, deps())).toEqual({ kind: "error", message: "unknown command: undefined" })
  })
})
