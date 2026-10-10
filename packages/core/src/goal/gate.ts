/**
 * /goal 质量门（issue #47）：验收命令的沙箱执行器。用户在设定目标时
 * 声明一次，此后每轮判定前自动执行——所以必须沙箱化（免审自执行的
 * 前提是可沙箱化），不可回退到裸跑。全部通过才进判定器；任一失败
 * 短路判定器，输出成为下一轮的修正指引。进程组杀灭与输出截断沿 exec
 * 工具的既有纪律（detached spawn + kill(-pid)、尾部保留）。
 */
import type { ExecSandbox } from "../sandbox/provider.js"
import { GOAL_GATE_OUTPUT_TAIL_CHARS, GOAL_GATE_TIMEOUT_MS } from "./limits.js"
import type { GoalGateOutcome } from "./types.js"

/** 单条命令的采集上限（字节）：整段输出只留尾部，防失控输出吃内存。 */
const MAX_CAPTURE_BYTES = 64 * 1024

/** 沙箱内跑一条命令：超时杀进程组，输出取尾部。 */
async function runOne(
  sandbox: ExecSandbox,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number | null; outputTail: string }> {
  const child = sandbox.spawn(command, { cwd })
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
    } catch {
      // 进程已退出——超时定时器与退出事件的竞态，无需处理。
    }
  }, timeoutMs)
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-MAX_CAPTURE_BYTES)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_CAPTURE_BYTES)
  })
  const code: number | null = await new Promise((resolve) => {
    child.once("error", () => resolve(null))
    child.once("close", (exitCode) => resolve(exitCode))
  })
  clearTimeout(timer)
  const tail = `${stdout}${stderr === "" ? "" : `\n[stderr]\n${stderr}`}`.trim().slice(-GOAL_GATE_OUTPUT_TAIL_CHARS)
  return {
    ok: !killed && code === 0,
    exitCode: killed ? null : code,
    outputTail:
      tail !== ""
        ? tail
        : killed
          ? `（超时 ${timeoutMs / 1000}s 被杀，无输出）`
          : code === null
            ? "（启动失败，无输出）"
            : "（无输出）",
  }
}

/**
 * 跑完整组验收命令（按声明顺序串行）。sandbox 不可用时不裸跑：每条
 * 记为失败并注明原因（fail-closed——验证不可用与验证失败同待遇，连败
 * 达上限即停，stoppedNote 会说明）。cwd = 会话工作区。`timeoutMs` 默认
 * GOAL_GATE_TIMEOUT_MS（测试可收紧）。
 */
export async function runAcceptanceGates(
  sandbox: ExecSandbox,
  acceptance: string[],
  cwd: string,
  timeoutMs: number = GOAL_GATE_TIMEOUT_MS,
): Promise<GoalGateOutcome[]> {
  const outcomes: GoalGateOutcome[] = []
  for (const command of acceptance) {
    if (!sandbox.available) {
      outcomes.push({
        command,
        ok: false,
        exitCode: null,
        outputTail: `验收命令未执行：沙箱不可用（${sandbox.unavailableReason ?? "未知原因"}）`,
      })
      continue
    }
    const r = await runOne(sandbox, command, cwd, timeoutMs)
    outcomes.push({ command, ...r })
  }
  return outcomes
}
