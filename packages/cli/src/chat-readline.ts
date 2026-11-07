/**
 * The readline surface: the line-mode chat for pipes and for terminals
 * missing a TTY on either end (spec B2). Output is plain lines on stdout,
 * cards and the session picker are @clack prompts with the readline
 * interface paused underneath, and the input loop reads lines until /exit or
 * EOF.
 *
 * Line input uses node:readline (NOT @clack text): deltas stream through
 * process.stdout.write while the interface idles between lines, a piped
 * stdin (tests, scripting) works line-by-line, and history/choreography stay
 * predictable. @clack/prompts only ever runs one prompt at a time, with the
 * readline interface paused while the prompt owns the terminal.
 *
 * SIGINT approach: on a TTY, readline consumes Ctrl+C in raw mode and emits
 * its own "SIGINT" event (any line state — node documents no empty-line
 * condition; without a listener it would merely emit "pause"); with a piped
 * stdin the process still receives the OS signal externally. The controller's
 * escalation is wired to both (the process signal by the orchestrator, the
 * readline event here), so piped runs escalate identically.
 */
import { isCancel, multiselect, select, text } from "@clack/prompts"
import type { ConfirmationDecision, PermissionMode } from "@kclaw/core"
import type { SlashCommandMeta } from "@kclaw/core/commands"
import { createInterface, type Interface as RlInterface } from "node:readline"
import type { ChatController, ChatUi } from "./chat-surface.js"
import { dim, red } from "./color.js"
import { confirmationLine, questionLine, toolCallLine, toolResultLine } from "./frame-view.js"
import { createSlashCompleter } from "./slash.js"
import { CONFIRM_OPTIONS } from "./surface-cards.js"

/** Prompt string per mode: default keeps the bare "> "; other modes badge it. */
function modePrompt(m: PermissionMode): string {
  return m === "default" ? "> " : `[${m}] > `
}

/** The readline interface over the process streams, with Tab completion of slash commands. */
export function openReadline(mode: PermissionMode, skillCommands: () => readonly SlashCommandMeta[]): RlInterface {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: modePrompt(mode),
    completer: createSlashCompleter(skillCommands),
  })
}

/** The pre-input greeting: session line plus the key hints (dim). */
function banner(sessionId: string): string {
  return `kclaw · session ${sessionId}\n${dim("输入消息，/ 命令可用（Tab 补全），/exit 退出，Ctrl+C 取消当前 run")}\n`
}

/** The part of a readline interface the surface pauses around a prompt. */
type Pausable = Pick<RlInterface, "pause" | "resume">

/**
 * Run an @clack prompt with the readline interface paused (@clack owns the
 * terminal while it runs); `paused` tracks the window for the Shift+Tab
 * listener. The interface resumes even when the prompt throws, so the
 * terminal never stays locked.
 */
export async function withPausedInput<T>(rl: Pausable, paused: { value: boolean }, fn: () => Promise<T>): Promise<T> {
  paused.value = true
  rl.pause()
  try {
    return await fn()
  } finally {
    paused.value = false
    rl.resume()
  }
}

export function createReadlineUi(opts: { sessionId: string; mode: PermissionMode; showThinking: boolean; skillCommands: () => readonly SlashCommandMeta[] }): ChatUi {
  // The interface is built here, not by the orchestrator: surface construction
  // details (prompt shape, completer wiring) stay behind the seam.
  const rl = openReadline(opts.mode, opts.skillCommands)
  /** Whether stdout sits at column 0, so line-oriented output can newline first. */
  let atLineStart = true
  /** True while an @clack prompt owns the terminal (Shift+Tab stands down). */
  const paused = { value: false }

  const write = (chunk: string): void => {
    process.stdout.write(chunk)
    atLineStart = chunk.endsWith("\n")
  }
  const ensureLineStart = (): void => {
    if (!atLineStart) write("\n")
  }
  const line = (chunk: string): void => {
    ensureLineStart()
    write(`${chunk}\n`)
  }

  return {
    show(view) {
      switch (view.kind) {
        case "text":
          write(view.delta)
          return
        case "text-end":
          ensureLineStart()
          return
        case "thinking":
          if (opts.showThinking) write(dim(`· ${view.delta}`))
          return
        case "tool-call":
          line(toolCallLine(view))
          return
        case "tool-result":
          line(toolResultLine(view))
          return
        case "system":
          line(dim(view.text))
          return
        case "run-failed":
          line(red(`✖ 运行失败: ${view.message}`))
          return
        case "run-completed":
          ensureLineStart() // the "prompt newline": end the streamed line
          return
        case "command-error":
          line(red(`错误: ${view.message}`))
          return
        // The line chat has no folded thinking line and no queue display:
        // the orchestrator's own hint lines report this client's queue state.
        case "thinking-end":
        case "queued":
        case "left-queue":
          return
      }
    },

    notice(textLine, tone) {
      line(tone === "dim" ? dim(textLine) : tone === "error" ? red(textLine) : textLine)
    },

    async confirm(p) {
      line(confirmationLine(p))
      if (p.noteText !== undefined) line(dim(p.noteText))
      let answer: ConfirmationDecision | symbol
      try {
        answer = await withPausedInput(rl, paused, () =>
          select<ConfirmationDecision>({
            message: "如何处置?",
            options: CONFIRM_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          }))
      } catch {
        answer = "reject"
      }
      if (isCancel(answer)) {
        line(dim("已取消，默认拒绝"))
        return "reject"
      }
      return answer
    },

    async ask(p) {
      line(`${questionLine(p)}${p.noteText === undefined ? "" : dim(` · ${p.noteText}`)}`)
      return withPausedInput(rl, paused, async () => {
        const collected: string[][] = []
        try {
          for (const q of p.questions) {
            if (Array.isArray(q.options) && q.options.length > 0) {
              if (q.multiSelect === true) {
                const picked = await multiselect<string>({
                  message: q.text,
                  options: q.options.map((o) => ({ value: o, label: o })),
                  required: false,
                })
                collected.push(isCancel(picked) ? [] : [...picked])
              } else {
                const picked = await select<string>({
                  message: q.text,
                  options: q.options.map((o) => ({ value: o, label: o })),
                })
                collected.push(isCancel(picked) ? [] : [picked])
              }
            } else {
              const typed = await text({ message: q.text, placeholder: "回车跳过" })
              collected.push(isCancel(typed) || typeof typed !== "string" ? [] : typed.trim() === "" ? [] : [typed])
            }
          }
        } catch {
          collected.push(...p.questions.slice(collected.length).map(() => []))
        }
        return collected
      })
    },

    async choose(message, options) {
      const chosen = await withPausedInput(rl, paused, () =>
        select<string>({ message, options: options.map((o) => ({ value: o.value, label: o.label })) }))
      return isCancel(chosen) ? undefined : chosen
    },

    modeChanged(mode, redraw) {
      rl.setPrompt(modePrompt(mode))
      if (redraw) {
        process.stdout.write("\n") // break off the drawn prompt line, then redraw
        atLineStart = true
        rl.prompt(true) // re-display the (new) prompt, preserving typed input
      }
    },

    busyChanged() {},
    sessionChanged() {},

    async run(controller: ChatController) {
      write(banner(opts.sessionId))
      rl.on("SIGINT", () => controller.interrupt())
      // Shift+Tab cycles the session's permission mode (readonly → default →
      // acceptEdits, Claude Code style). Stands down while an @clack prompt
      // owns stdin; mid-run presses apply from the NEXT run (the daemon gates
      // per run).
      if (process.stdin.isTTY) {
        process.stdin.on("keypress", (_str, key: { name?: string; shift?: boolean } | undefined) => {
          if (key?.name === "tab" && key.shift === true && !paused.value) void controller.cycleMode()
        })
      }
      // A piped stdin reaches EOF (and closes the interface) while the FIRST
      // line's run is still rendering — track it so late prompt() calls no-op
      // instead of throwing "readline was closed" (buffered lines still arrive
      // through the async iterator afterwards).
      let rlClosed = false
      rl.on("close", () => {
        rlClosed = true
      })
      const prompt = (): void => {
        if (!rlClosed) rl.prompt()
      }
      prompt()
      for await (const raw of rl) {
        if ((await controller.submit(raw)) === "exit") return
        prompt()
      }
      // stdin hit EOF: let in-flight renders finish before the socket closes,
      // so buffered lines never cut a run's output short.
      await controller.drain()
    },

    close() {
      rl.close()
    },
  }
}
