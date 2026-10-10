/**
 * /goal 循环的硬性上限（issue #47）。全部是代码内常量（QUEUE_LIMIT/
 * WAKE_BUDGET 先例：不自续进 config）；唯一可配项是判定器用的 provider
 * 条目（config.goals.judge，走 Model 页热生效链）。调整这里的值 =
 * 改行为不是改契约，不需要配置面。
 */

/** 连续自续轮上限（user 触发的 run 清零；达上限停 round-limit）。 */
export const GOAL_MAX_ROUNDS = 10

/**
 * 目标生命周期 token 预算（运行 usage + 判定器 usage 累计）。超限后
 * 补一轮收尾（wind-down）再停 budget-limit，不在半途硬切。
 */
export const GOAL_TOKEN_BUDGET = 2_000_000

/** 判定器连续判"无进展"的容忍上限（progress 空或判 not_met 且 reason 明示无进展）。 */
export const GOAL_NO_PROGRESS_LIMIT = 3

/** 验收命令连续失败轮数上限（每轮内全部通过才算过；达上限停 gate-exhausted）。 */
export const GOAL_GATE_EXHAUSTED = 3

/** 连续出现确认超时的轮数上限（达上限转 blocked/permission，等用户裁决）。 */
export const GOAL_APPROVAL_TIMEOUT_ROUNDS = 2

/** 判定器解析失败熔断阈值（连续 parse 失败次数）。 */
export const GOAL_JUDGE_PARSE_BREAKER = 3

/** 判定器传输失败熔断阈值（连续 transport 失败次数）。 */
export const GOAL_JUDGE_TRANSPORT_BREAKER = 5

/** 判定器证据窗口：对话尾部最多消息条数。 */
export const GOAL_EVIDENCE_MAX_MESSAGES = 24

/** 判定器证据窗口：单条消息文本/工具输出保留的字符上限（其余截断加标记）。 */
export const GOAL_EVIDENCE_TEXT_CHARS = 2000

/** 判定器证据窗口：整窗字符上限（超出从窗口头部再裁，省略计数如实标注）。 */
export const GOAL_EVIDENCE_WINDOW_CHARS = 24_000

/** 验收命令单条输出进入证据的尾部字符上限。 */
export const GOAL_GATE_OUTPUT_TAIL_CHARS = 2000

/** 验收命令执行超时（毫秒）——沙箱内进程也要有超时上限。 */
export const GOAL_GATE_TIMEOUT_MS = 60_000

/** 判定器输出上限（token）：理由+进展的宽松额度。 */
export const GOAL_JUDGE_MAX_TOKENS = 2048
