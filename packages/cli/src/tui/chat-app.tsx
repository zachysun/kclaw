/**
 * The ink app root (spec B3/B4): the column layout — <Static> history,
 * dynamic area, pending card, input box, status line — plus the global key
 * routing. Key ownership is exclusive per state: the editor owns the
 * keyboard when idle-ish (no overlay, no card), the card owns it while a
 * card shows, the overlay owns it while full-screen, and THIS component
 * owns exactly one key in the other states — Ctrl+C — so the escalation
 * (three stages, orchestrator-owned) fires exactly once everywhere.
 */
import { Box, useInput } from "ink"
import { useSyncExternalStore } from "react"
import type { ChatController } from "../chat-surface.js"
import { ConfirmCard, QuestionCard, ChoiceCard } from "./cards.js"
import { DynamicArea } from "./dynamic-area.js"
import { InputEditor } from "./input-editor.js"
import { HelpOverlay, TranscriptOverlay } from "./overlays.js"
import { StaticHistory } from "./static-history.js"
import { StatusLine } from "./status-line.js"
import type { ChatStore } from "./store.js"

export function ChatApp({ store, controller }: { store: ChatStore; controller: ChatController }) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const overlayOpen = state.overlays.transcript || state.overlays.help
  const editorActive = !state.exiting && !overlayOpen && state.pending.confirms.length === 0 && state.pending.questions.length === 0 && state.pending.choices.length === 0

  useInput((input, key) => {
    if (key.ctrl && input === "c") controller.interrupt()
  }, { isActive: !editorActive })

  if (state.overlays.help) return <HelpOverlay store={store} />
  if (state.overlays.transcript) return <TranscriptOverlay store={store} controller={controller} />

  const confirmHead = state.pending.confirms[0]
  const questionHead = state.pending.questions[0]
  const choiceHead = state.pending.choices[0]
  // ink 会把按键广播给所有激活的 useInput，因此同一时刻只能有一张卡激活
  // （优先级固定：确认 > 问题 > 单选），其余卡在队列里等前一张裁决完。
  const activeCard = confirmHead !== undefined ? "confirm" : questionHead !== undefined ? "question" : choiceHead !== undefined ? "choice" : undefined
  const cardActive = activeCard !== undefined

  return (
    <Box flexDirection="column">
      <StaticHistory store={store} />
      <DynamicArea state={state} />
      {confirmHead !== undefined && activeCard === "confirm" && (
        <ConfirmCard key={confirmHead.payload.confirmationId} payload={confirmHead.payload} isActive={cardActive} onResolve={(decision) => store.resolveConfirm(decision)} />
      )}
      {questionHead !== undefined && activeCard === "question" && (
        <QuestionCard key={questionHead.payload.questionId} payload={questionHead.payload} isActive={cardActive} onResolve={(answers) => store.resolveQuestion(answers)} />
      )}
      {choiceHead !== undefined && activeCard === "choice" && (
        <ChoiceCard
          key={`${choiceHead.message}:${choiceHead.options.map((o) => o.value).join(",")}`}
          message={choiceHead.message}
          options={choiceHead.options}
          isActive={cardActive}
          onResolve={(value) => store.resolveChoice(value)}
        />
      )}
      <InputEditor store={store} controller={controller} active={editorActive} />
      <StatusLine store={store} />
    </Box>
  )
}
