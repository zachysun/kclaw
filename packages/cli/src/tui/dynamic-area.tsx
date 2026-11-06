/**
 * The dynamic area between the history and the input box: the assistant's
 * in-flight text block, the queued-messages row, the thinking line (folded
 * `✻ 思考 Ns`, unfolded by --show-thinking), running tool rows (spinner +
 * elapsed seconds), and the run-gap spinner row (spec B3/B7). Everything
 * here is re-rendered per frame; completed content moves up into <Static>.
 */
import { Box, Text, useAnimation } from "ink"
import type { ChatState } from "./store.js"
import { AMBER, ICONS, SPINNER_FRAMES } from "./colors.js"

/**
 * The animation tick: the glyph spins and the component re-renders every
 * `interval` ms. Elapsed seconds are NOT taken from the tick — the overlay
 * swap unmounts this subtree and a mount-relative counter would restart at
 * zero on close — so each row derives seconds from its own wall-clock start.
 */
function useTick(interval = 120): string {
  const { frame } = useAnimation({ interval })
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!
}

function secondsSince(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
}

function ThinkingLine({ thinkingStartedAt, text }: { thinkingStartedAt: number; text: string | undefined }) {
  const glyph = useTick(500)
  return (
    <Text>
      <Text dimColor>
        {ICONS.thinking} 思考 {secondsSince(thinkingStartedAt)}s {glyph}
      </Text>
      {text !== undefined && text !== "" ? "\n" + text : ""}
    </Text>
  )
}

function RunningToolRow({ name, argsSummary, startedAt }: { name: string; argsSummary: string; startedAt: number }) {
  const glyph = useTick()
  return (
    <Text color={AMBER}>
      {glyph} {name} {argsSummary} {secondsSince(startedAt)}s
    </Text>
  )
}

function BusyRow({ busySince }: { busySince: number }) {
  const glyph = useTick()
  return (
    <Text color={AMBER}>
      {ICONS.thinking} 处理中… {secondsSince(busySince)}s {glyph}
    </Text>
  )
}

export function DynamicArea({ state }: { state: ChatState }) {
  const { dynamic } = state
  const showThinkingLine = dynamic.thinkingStartedAt !== undefined
  const showBusyRow = dynamic.busy && dynamic.streamingText === "" && !showThinkingLine && dynamic.runningTools.length === 0
  return (
    <Box flexDirection="column">
      {dynamic.streamingText !== "" && <Text>{dynamic.streamingText}</Text>}
      {dynamic.queuedIds.length > 0 && <Text dimColor>· 已排队 {dynamic.queuedIds.length} 条</Text>}
      {showThinkingLine && <ThinkingLine thinkingStartedAt={dynamic.thinkingStartedAt!} text={dynamic.thinkingText} />}
      {dynamic.runningTools.map((tool) => (
        <RunningToolRow key={tool.callId} name={tool.name} argsSummary={tool.argsSummary} startedAt={tool.startedAt} />
      ))}
      {showBusyRow && dynamic.busySince !== undefined && <BusyRow busySince={dynamic.busySince} />}
    </Box>
  )
}
