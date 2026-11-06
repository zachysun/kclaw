/**
 * The dynamic area between the history and the input box: the assistant's
 * in-flight text block, the thinking line (folded `✻ 思考 Ns`, unfolded by
 * --show-thinking), running tool rows (spinner + elapsed seconds), and the
 * run-gap spinner row (spec B3/B7). Everything here is re-rendered per
 * frame; completed content moves up into <Static>.
 */
import { Box, Text, useAnimation } from "ink"
import type { ChatState } from "./store.js"
import { AMBER, ICONS, SPINNER_FRAMES } from "./colors.js"

/** Spinner + elapsed-seconds pair shared by the thinking line and tool rows. */
function useTick(interval = 120): { glyph: string; seconds: number } {
  const { frame, time } = useAnimation({ interval })
  return { glyph: SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!, seconds: Math.floor(time / 1000) }
}

function ThinkingLine({ thinkingStartedAt, text }: { thinkingStartedAt: number; text: string | undefined }) {
  const { glyph, seconds } = useTick(500)
  return (
    <Text>
      <Text dimColor>
        {ICONS.thinking} 思考 {seconds}s {glyph}
      </Text>
      {text !== undefined && text !== "" ? "\n" + text : ""}
    </Text>
  )
}

function RunningToolRow({ name, argsSummary, startedAt }: { name: string; argsSummary: string; startedAt: number }) {
  const { glyph, seconds } = useTick()
  return (
    <Text color={AMBER}>
      {glyph} {name} {argsSummary} {seconds}s
    </Text>
  )
}

function BusyRow() {
  const { glyph, seconds } = useTick()
  return (
    <Text color={AMBER}>
      {ICONS.thinking} 处理中… {seconds}s {glyph}
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
      {showThinkingLine && <ThinkingLine thinkingStartedAt={dynamic.thinkingStartedAt!} text={dynamic.thinkingText} />}
      {dynamic.runningTools.map((tool) => (
        <RunningToolRow key={tool.callId} name={tool.name} argsSummary={tool.argsSummary} startedAt={tool.startedAt} />
      ))}
      {showBusyRow && <BusyRow />}
    </Box>
  )
}
