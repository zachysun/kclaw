/**
 * The ink TUI entry (spec B2/B3/B13): `createTuiUi` builds the store,
 * implements ChatUi over it, and mounts <ChatApp> with ink when the
 * orchestrator calls run(). Ink's console patch keeps stray logs out of the
 * frame; Ctrl+C is owned by the app's key handlers (exitOnCtrlC off — the
 * three-stage escalation must win). The terminal title (B13) tracks the
 * busy state and session title, sanitized per tui/title.ts, and is cleared
 * on every close path (unmount, process exit hook).
 *
 * The whole module loads lazily (dynamic import from chat.ts): a piped chat
 * never pays for ink/react, and chalk settles colour AFTER the CLI's colour
 * module wrote its verdict into the environment.
 */
import type { PermissionMode } from "@kclaw/core"
import { render } from "ink"
import type { Instance } from "ink"
import { createElement } from "react"
import type { ChatController, ChatUi, ChoiceOption, DisplayView, NoticeTone } from "../chat-surface.js"
import { fetchMessages, fetchSessionMeta } from "./chat-data.js"
import { ChatApp } from "./chat-app.js"
import { ChatStore } from "./store.js"
import { clearTerminalTitle, writeTerminalTitle } from "./title.js"

export interface TuiOptions {
  sessionId: string
  mode: PermissionMode
  showThinking: boolean
}

export function createTuiUi(opts: TuiOptions): ChatUi {
  let exitResolve: (() => void) | undefined
  let instance: Instance | undefined
  let controllerRef: ChatController | undefined
  let sessionTitle = ""
  let busy = false

  const store = new ChatStore({
    showThinking: opts.showThinking,
    onExit: () => exitResolve?.(),
  })
  store.modeChanged(opts.mode)
  store.sessionChanged(opts.sessionId)

  /** One title refresh: `kclaw · <title>` idle, `kclaw ▶ 运行中 · <title>` busy. */
  const refreshTitle = (): void => {
    writeTerminalTitle(busy ? `kclaw ▶ 运行中 · ${sessionTitle || "chat"}` : `kclaw · ${sessionTitle || "chat"}`)
  }

  /**
   * Pull session meta (status line + title) and messages (input history)
   * for a session. Callers all run inside run() (controller set); without
   * one there is no client to ask — a wiring bug would loop forever here.
   */
  const resync = async (sessionId: string): Promise<void> => {
    if (controllerRef === undefined) return
    try {
      const meta = await fetchSessionMeta(controllerRef.client, sessionId)
      sessionTitle = meta.title ?? ""
      store.setStatusMeta({ model: meta.model, title: sessionTitle })
      refreshTitle()
    } catch {
      // daemon 不可达：状态行保持占位值，下一次会话切换或重连后再恢复
    }
    try {
      store.setInputHistory(await fetchMessages(controllerRef.client, sessionId))
    } catch {
      // 输入历史拉取失败：↑↓ 暂时只有本进程内提交过的行
    }
  }

  // 退出路径清标题：正常 close() 与进程退出（Ctrl+C 第三段）都覆盖
  const onProcessExit = (): void => {
    clearTerminalTitle()
  }
  process.on("exit", onProcessExit)

  const ui: ChatUi = {
    show(view: DisplayView): void {
      store.show(view)
    },
    notice(text: string, tone: NoticeTone): void {
      store.notice(text, tone)
    },
    confirm(p) {
      return store.confirm(p)
    },
    ask(p) {
      return store.ask(p)
    },
    choose(message: string, options: readonly ChoiceOption[]) {
      return store.choose(message, options)
    },
    modeChanged(mode: PermissionMode) {
      store.modeChanged(mode)
    },
    busyChanged(next: boolean) {
      busy = next
      store.busyChanged(next)
      refreshTitle()
    },
    sessionChanged(sessionId: string) {
      store.sessionChanged(sessionId)
      void resync(sessionId)
    },
    async run(controller: ChatController) {
      controllerRef = controller
      instance = render(createElement(ChatApp, { store, controller }), {
        exitOnCtrlC: false, // Ctrl+C 归三段升级（键盘处理 → controller.interrupt）
        patchConsole: true, // 应用内散落日志不再打穿画面（spec B3）
      })
      void resync(opts.sessionId)
      await new Promise<void>((resolve) => {
        exitResolve = resolve
      })
    },
    close() {
      process.off("exit", onProcessExit)
      instance?.unmount()
      instance = undefined
      clearTerminalTitle()
    },
  }
  return ui
}
