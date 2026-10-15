/**
 * 聊天日志的跟随滚动（follow-tail）：贴底时新内容自动跟随，向上滚动即暂
 * 停（审计页 follow-tail 的非虚拟化简化版）；挂载与切换会话强制回到最新
 * 消息——打开有历史的会话落在最新一条，而不是从最早的开始翻。
 *
 * scroll 处理器只翻转一个布尔（React 对相同值 bail out，不产生高频重渲
 * 染），不逐帧把布局读写道 state（动效与性能契约）。内容增长的跟随写在
 * useLayoutEffect：渲染后、绘制前同步定位，不闪跳。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react"

/** 距底部多少像素内仍算"贴着底部"（流式渲染的高度抖动余量）。 */
const TAIL_PX = 48

export function useFollowTail(messages: readonly unknown[], sessionId: string): {
  logRef: React.RefObject<HTMLDivElement | null>
  onLogScroll: () => void
  /** 用户当前贴着底部（跟随中）。false = 已上滚暂停，界面给出"回到底部"。 */
  pinned: boolean
  jumpToBottom: () => void
} {
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  const onLogScroll = useCallback((): void => {
    const el = logRef.current
    if (el === null) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - TAIL_PX
    pinnedRef.current = atBottom
    setPinned(atBottom)
  }, [])

  // 内容增长且贴底 → 跟随；上滚暂停后不拉扯视口。
  useLayoutEffect(() => {
    const el = logRef.current
    if (el === null || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // 挂载与切换会话：恢复贴底（上一会话的上滚位置不延续）。
  useLayoutEffect(() => {
    pinnedRef.current = true
    setPinned(true)
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [sessionId])

  const jumpToBottom = useCallback((): void => {
    const el = logRef.current
    if (el === null) return
    pinnedRef.current = true
    setPinned(true)
    el.scrollTop = el.scrollHeight
  }, [])

  return { logRef, onLogScroll, pinned, jumpToBottom }
}
