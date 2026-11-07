/**
 * The ink cards (spec B6): confirmation (four verdict options, Esc =
 * reject), question (per-question select/multiselect/free-text, Esc skips
 * the current question), and choice (the surface-level single picker, e.g.
 * the /sessions list). One card renders at a time — the first of the
 * store's pending queue, passed in as props so every hook runs
 * unconditionally — and owns the keyboard while visible (the editor stands
 * down; Ctrl+C stays with the root app). Option labels and copy come from
 * surface-cards.ts — the same source the readline surface renders from.
 * Cards are keyed by payload id at the call site, so a queued follow-up
 * card remounts fresh.
 */
import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { ConfirmationDecision, ConfirmationRequestedPayload, QuestionRequestedPayload, QuestionSpec } from "@kclaw/core"
import type { ChoiceOption } from "../chat-surface.js"
import { confirmationLine } from "../frame-view.js"
import { CONFIRM_OPTIONS } from "../surface-cards.js"
import { AMBER, ICONS } from "./colors.js"

function CardFrame({ children, footer }: { children: React.ReactNode; footer: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingLeft={1}>
      {children}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}

function OptionList({ options, selected, marks }: { options: readonly string[]; selected: number; marks?: readonly boolean[] }) {
  return (
    <Box flexDirection="column">
      {options.map((label, idx) => (
        // 选项是静态列表（不重排不增删），按下标取 key——重复文案的选项
        // （如"其他"出现两次）不会触发重复 key。
        <Text key={String(idx)} color={idx === selected ? AMBER : undefined} dimColor={idx !== selected}>
          {idx === selected ? "❯ " : "  "}
          {marks !== undefined ? `[${marks[idx] ? "x" : " "}] ` : ""}
          {label}
        </Text>
      ))}
    </Box>
  )
}

export function ConfirmCard({ payload, isActive, onResolve }: {
  payload: ConfirmationRequestedPayload
  isActive: boolean
  onResolve: (decision: ConfirmationDecision) => void
}) {
  const [selected, setSelected] = useState(0)
  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(CONFIRM_OPTIONS.length - 1, s + 1))
    else if (key.return) onResolve(CONFIRM_OPTIONS[selected]!.value)
    else if (key.escape) onResolve("reject")
  }, { isActive })
  const safe = Math.min(selected, CONFIRM_OPTIONS.length - 1)
  return (
    <CardFrame footer="Enter 确认，Esc 拒绝">
      <Text color={AMBER}>{confirmationLine(payload)}</Text>
      {payload.noteText !== undefined && <Text dimColor>{payload.noteText}</Text>}
      <OptionList options={CONFIRM_OPTIONS.map((o) => o.label)} selected={safe} />
    </CardFrame>
  )
}

export function QuestionCard({ payload, isActive, onResolve }: {
  payload: QuestionRequestedPayload
  isActive: boolean
  onResolve: (answers: string[][]) => void
}) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<string[][]>([])
  const total = payload.questions.length
  const question = payload.questions[Math.min(index, total - 1)]
  if (question === undefined) return null // 空问题表：无事可问（正常载荷不会到这里）

  const finishOne = (answer: string[]): void => {
    const collected = [...answers, answer]
    if (index + 1 >= total) {
      setIndex(0)
      setAnswers([])
      onResolve(collected)
    } else {
      setIndex(index + 1)
      setAnswers(collected)
    }
  }

  // key 随题号变化：连续两题同文也强制重挂，自由文本的本地草稿不会串题
  return <SingleQuestion key={String(index)} isActive={isActive} finishOne={finishOne} question={question} progress={{ index, total }} noteText={payload.noteText} />
}

function SingleQuestion({ isActive, finishOne, question, progress, noteText }: {
  isActive: boolean
  finishOne: (answer: string[]) => void
  question: QuestionSpec
  progress: { index: number; total: number }
  noteText?: string
}) {
  const options = question.options ?? []
  const multi = question.multiSelect === true
  const hasOptions = options.length > 0
  const [selected, setSelected] = useState(0)
  const [picked, setPicked] = useState<number[]>([])
  const [text, setText] = useState("")

  useInput((input, key) => {
    if (key.escape) {
      finishOne([])
      return
    }
    if (hasOptions) {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
      else if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1))
      else if (input === " " && !key.ctrl && !key.meta && multi) {
        setPicked((cur) => (cur.includes(selected) ? cur.filter((i) => i !== selected) : [...cur, selected]))
      } else if (key.return) {
        if (multi) {
          // 零勾选直接提交空答案：与 readline 表面的 multiselect 语义一致
          // （空数组 = 未回答，服务端按"该题未答"收下）。
          finishOne(picked.map((i) => options[i]!))
        } else {
          finishOne([options[selected]!])
        }
      }
      return
    }
    // 自由文本题
    if (key.return) {
      finishOne(text.trim() === "" ? [] : [text.trim()])
      setText("")
      return
    }
    if (key.backspace) setText((v) => v.slice(0, -1))
    else if (input.length > 0 && !key.ctrl && !key.meta && input >= " ") setText((v) => v + input)
  }, { isActive })

  const safe = Math.min(selected, Math.max(0, options.length - 1))
  return (
    <CardFrame
      footer={
        hasOptions
          ? multi
            ? "空格勾选，Enter 确认，Esc 跳过"
            : "Enter 选择，Esc 跳过"
          : "Enter 提交（空回车跳过），Esc 跳过"
      }
    >
      <Text color={AMBER}>
        {ICONS.warn} 问题 {progress.index + 1}/{progress.total}：{question.text}
      </Text>
      {noteText !== undefined && <Text dimColor>{noteText}</Text>}
      {hasOptions ? (
        <OptionList
          options={options}
          selected={safe}
          marks={multi ? options.map((_, idx) => picked.includes(idx)) : undefined}
        />
      ) : (
        <Text>
          {"> "}
          {text === "" ? <Text dimColor>自由回答</Text> : text}
        </Text>
      )}
    </CardFrame>
  )
}

export function ChoiceCard({ message, options, isActive, onResolve }: {
  message: string
  options: readonly ChoiceOption[]
  isActive: boolean
  onResolve: (value: string | undefined) => void
}) {
  const [selected, setSelected] = useState(0)
  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1))
    else if (key.return) onResolve(options[selected]?.value)
    else if (key.escape) onResolve(undefined)
  }, { isActive })
  const safe = Math.min(selected, options.length - 1)
  return (
    <CardFrame footer="Enter 选择，Esc 取消">
      <Text color={AMBER}>{message}</Text>
      <OptionList options={options.map((o) => o.label)} selected={safe} />
    </CardFrame>
  )
}
