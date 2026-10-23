/**
 * create_goal / get_goal / update_goal: the model-facing goal tools,
 * mirroring the industry set (create/get/update — both surveyed harnesses
 * with goal tools ship exactly these three). All three are projections onto
 * the existing goal loop host paths — the goal engine itself does not
 * change, and the independent judge at the run boundary remains the only
 * writer of terminal states.
 *
 * Risk tiers (the standing discipline made mechanical: the model never
 * arms or steers a spending loop without the user's say-so):
 * - create_goal, update_goal: SENSITIVE — the approval card shows the
 *   objective and acceptance commands; approving IS the say-so.
 * - get_goal: SAFE.
 *
 * `complete` does NOT close the goal: it requests an immediate judge pass
 * (the same check the run boundary runs); not_met continues the loop with
 * the verdict injected. pause/resume/stop map straight onto the host
 * methods. Root sessions only (subagent runs never carry these tools —
 * delegation cannot spin up autonomous loops); a second goal while one is
 * live is refused (no nesting).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { GoalSnapshot } from "../goal/types.js"
import type { GoalView } from "../protocol/goal.js"
import { def, makeTool, optString, requireString, str, type ToolEntry } from "./shared.js"

/** The host surface the tools consume — GoalLoopHost satisfies this structurally. */
export interface GoalToolHost {
  set(sessionId: string, input: { text: string; acceptance: string[] }): GoalSnapshot
  pause(sessionId: string): GoalSnapshot
  resume(sessionId: string): GoalSnapshot
  userStop(sessionId: string): { goal: GoalSnapshot; aborted: boolean; dropped: number }
  view(sessionId: string): GoalView | undefined
  /** Fire an immediate judge pass; false = nothing to check (not armed / not active / judging). */
  requestCheck(sessionId: string): boolean
}

export function createGoalTools(opts: {
  host: GoalToolHost
  sessionId: string
}): {
  "create_goal": ToolExecutor & { name: "create_goal" }
  "get_goal": ToolExecutor & { name: "get_goal" }
  "update_goal": ToolExecutor & { name: "update_goal" }
} {
  const { host, sessionId } = opts

  const stateLabel: Record<GoalSnapshot["state"], string> = {
    active: "进行中",
    paused: "已暂停",
    blocked: "待裁决",
    complete: "已终态",
  }

  const render = (view: GoalView): string =>
    [
      `目标：${view.goal.text}`,
      `状态：${stateLabel[view.goal.state]}（第 ${view.goal.rounds}/${view.goal.totalRounds} 轮 · ${view.goal.tokensUsed} token）`,
      view.goal.acceptance.length > 0 ? `验收命令：${view.goal.acceptance.join(" ; ")}` : "验收命令：（无，判定器只看对话）",
      view.goal.lastJudgeVerdict !== undefined
        ? `最近判定：${view.goal.lastJudgeVerdict}${view.goal.lastJudgeReason !== undefined ? `（${view.goal.lastJudgeReason}）` : ""}`
        : "最近判定：（尚未判定）",
      `自续开关：${view.armed ? "armed（判定通过即自动续轮）" : "未 armed（重启后需 resume）"}`,
    ].join("\n")

  const create_goal = makeTool("create_goal", "sensitive", "serial", (args) => {
    const text = requireString(args, "text")
    const acceptanceRaw = (args as { acceptance?: unknown }).acceptance
    if (acceptanceRaw !== undefined && !Array.isArray(acceptanceRaw)) {
      return { status: "error", output: "create_goal: args.acceptance must be an array of strings" }
    }
    if (Array.isArray(acceptanceRaw) && acceptanceRaw.some((a) => typeof a !== "string" || a.trim() === "")) {
      return { status: "error", output: "create_goal: args.acceptance must be non-empty strings" }
    }
    const current = host.view(sessionId)
    if (current !== undefined && current.goal.state !== "complete") {
      return {
        status: "error",
        output: `本会话已有目标（${stateLabel[current.goal.state]}），先 /goal stop 或 update_goal action=stop 处理后再开新目标`,
      }
    }
    try {
      const goal = host.set(sessionId, {
        text,
        acceptance: (acceptanceRaw as string[] | undefined) ?? [],
      })
      return {
        status: "ok",
        output: `目标已设定并起跑（armed + 首轮入队）：\n目标：${goal.text}\n轮数上限 ${goal.totalRounds}、token 预算 ${goal.tokensUsed} 起。`,
        data: goal,
      }
    } catch (e) {
      return { status: "error", output: `create_goal: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  const get_goal = makeTool("get_goal", "safe", "parallel", () => {
    const view = host.view(sessionId)
    if (view === undefined) return { status: "ok", output: "(本会话没有目标)" }
    return { status: "ok", output: render(view), data: view }
  })

  const update_goal = makeTool("update_goal", "sensitive", "serial", (args) => {
    const action = requireString(args, "action")
    const note = optString(args, "note")
    try {
      switch (action) {
        case "complete": {
          // Requests a judge pass NOW; the verdict (not the model) closes the goal.
          const view = host.view(sessionId)
          if (view === undefined) return { status: "error", output: "update_goal: 本会话没有目标" }
          if (view.goal.state === "complete") {
            return { status: "error", output: `update_goal: 目标已终态（${view.goal.stoppedReason ?? ""}），无需再判定` }
          }
          const kicked = host.requestCheck(sessionId)
          return {
            status: "ok",
            output: kicked
              ? "已请求立即判定：判定器将对照验收命令裁决；未达标会带着判定意见继续循环（完成与否由判定器决定，不是本工具）。"
              : "当前不可立即判定（未 armed 或判定进行中）；判定会在 run 边界自动进行。",
            data: { kicked },
          }
        }
        case "pause": {
          const goal = host.pause(sessionId)
          return { status: "ok", output: `目标已暂停（armed 关闭）：${goal.text}`, data: goal }
        }
        case "resume": {
          const goal = host.resume(sessionId)
          return { status: "ok", output: `目标已恢复（armed + 立即检查）：${goal.text}`, data: goal }
        }
        case "stop": {
          const { goal, aborted, dropped } = host.userStop(sessionId)
          return {
            status: "ok",
            output: `目标已停止${aborted ? "（活跃 run 已中断" : ""}${aborted && dropped > 0 ? `，清掉 ${dropped} 条排队` : ""}${aborted ? "）" : ""}：${goal.text}`,
            data: goal,
          }
        }
        default:
          return { status: "error", output: "update_goal: action 必须是 complete / pause / resume / stop 之一" }
      }
    } catch (e) {
      return { status: "error", output: `update_goal: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  return { "create_goal": create_goal, "get_goal": get_goal, "update_goal": update_goal }
}

/** The registry-facing bundle: executors + schemas owned beside each other. */
export function createGoalToolEntries(opts: Parameters<typeof createGoalTools>[0]): ToolEntry[] {
  const tools = createGoalTools(opts)
  return [
    {
      name: "create_goal",
      tool: tools.create_goal,
      def: def(
        "create_goal",
        "Start a goal loop ONLY when the user explicitly asked for persistent autonomous work (e.g. keep iterating until tests pass). The loop self-continues with an independent judge at each run boundary; acceptance commands run sandboxed and unattended. One goal per session; a live goal must be stopped first.",
        {
          text: str("The objective, stated so an independent judge can evaluate it"),
          acceptance: { type: "array", items: { type: "string" }, description: "Optional acceptance commands (each must pass; run sandboxed). Absent = judged on the conversation alone" },
        },
        ["text"],
      ),
    },
    {
      name: "get_goal",
      tool: tools.get_goal,
      def: def("get_goal", "Read the current goal's view: state, round position, budget spent, latest verdict, acceptance commands.", {}, []),
    },
    {
      name: "update_goal",
      tool: tools.update_goal,
      def: def(
        "update_goal",
        "Act on the current goal. `complete` requests an immediate judge pass — the independent judge decides met/not_met/impossible, this tool never closes the goal itself. `pause` disarms (no self-continuation). `resume` re-arms and checks. `stop` aborts the active run and parks the goal (user-stop).",
        {
          action: { type: "string", enum: ["complete", "pause", "resume", "stop"], description: "complete / pause / resume / stop" },
          note: str("Optional context note (recorded, not used as judge evidence)"),
        },
        ["action"],
      ),
    },
  ]
}
