# goal — 目标循环（/goal）

> 权威来源：`packages/core/src/goal/`（领域模块：类型/上限/提示词/判定器/验收门）+ `packages/server/src/goal-loop.ts`（daemon 侧驱动主机 `GoalLoopHost`）。HTTP 路由族见 [http-api](../server/http-api.md)，持久化事件见 [session-events](../reference/session-events.md)。

## 它是什么

给会话设一个**可验证的目标**，daemon 自主多轮推进：每轮 run 结束后先跑验收命令、再由一个独立的判定器 LLM 裁决目标是否达成，没达成就把判定意见注入下一轮继续干，直到达成、被判不可能、或触碰机械上限才停。会话的普通对话（打字发消息）在任何时刻都可用——goal 循环只是队列里的一种 run 来源，用户输入照常 steer/wait/interrupt。

四态状态机（`GoalState`）：

| 状态 | 含义 | 离开方式 |
|------|------|----------|
| `active` | 循环在跑：每轮 run 结束后自动检查并续跑 | 达成/不可能 → `complete`；各种停止 → `paused`/`blocked` |
| `paused` | 停摆（用户暂停/停止，或机械原因停止） | 用户 resume 或改写目标 |
| `blocked` | 被人工裁决卡住（连续确认超时）——需要人来 | 用户裁决后 resume |
| `complete` | 终态：`met`（达成）或 `impossible`（判不可达） | 只能 clear 或改写（改写=新循环） |

十种停止原因（`GoalStopReason`，快照的 `stoppedReason` 字段）：`met`、`impossible`、`user-stop`、`run-error`、`permission`（→blocked）、`no-progress`、`gate-exhausted`、`budget-limit`、`round-limit`、`judge-failed`。除 `met`/`impossible` 外全部落在 `paused` 或 `blocked`，用户 resume 即可重试（`met`/`impossible` 之后只能 clear 或改写目标）。

## 一轮的生命周期

```
用户设目标（POST /sessions/:id/goal 或 /goal 命令）
  → goal.set(create) 事件 + armed + 第一轮入队（trigger:"goal"，固定 wait）
  → run 正常执行（工具循环、权限判定、沙箱，与普通 run 完全同一套）
  → 队列排空（RunManager 的空闲边缘 onSessionIdle，与 team host 同一接缝）
  → GoalLoopHost 一轮检查（#check，互斥）：
      ① 上一轮 run 出错        → paused(run-error)，不自动重试
      ② 连续 2 轮确认超时       → blocked(permission)，等人来
      ③ 验收门（有命令才跑）    → 失败短路判定器，直接进分支
      ④ 判定器（独立 LLM）      → met/impossible → complete；
                                  not_met → 无进展检查 → 预算/轮数 → 续跑
      ⑤ 判定器失败/门失败       → 连败熔断或 fail-open 续跑
  → 续跑 = 再入队一轮 goal run（用户文本带判定意见/验收输出）
```

检查在判定器 await 之后会重新校验 armed 与快照状态：用户在判定进行中 stop/pause/clear，审计事件（goal.checked）照常写入，状态机只在仍 active 时推进。中途打字发消息就是普通的用户 run（trigger:"user"），它会把"连续自续轮数"清零重新数，循环本身不断。

## 判定器（judge）

- **模型解析链**：`config.goals.judge` 命中的 provider 条目优先（Model 页改名/改配置热生效），未配置时回退会话模型线（会话级 `model` → 默认条目 → daemon 启动模型串）。
- **调用形态**：温度 0、无工具、`maxTokens` 2048、严格 JSON 输出契约 `{"verdict":"not_met|met|impossible","reason":"…","progress":"…"}`（progress 无进展写「无」）。证据是目标原文 + 本轮验收输出 + 对话尾部窗口（最近约 24 条消息、单条 2000 字符、整窗 24000 字符封顶，超出部分头部省略）。
- **解析与失败分类**：输出非法 JSON 时把错误喂回去重试一次（两次调用用量合并计入）；仍失败或调用本身失败（网络/供应商错误）按 `parse` / `transport` 两类分别计数，连续 3 次解析失败或 5 次传输失败熔断（`judge-failed` 停摆）。未到熔断阈值时 fail-open：循环继续，下一轮注入"判定器不可用、请自行验收"的说明。
- **判定纪律**在 system 提示词里写死：只看证据不听自述（说做完了而验收命令失败就是 not_met）、不预测不乐观、impossible 慎用。

判定器用量逐次记入用量库（`goal-judge-<轮>-<时间>` 的 runId）并计入目标生命周期 token。

## 验收门（acceptance gates）

`/goal 目标描述 verify: <命令>`（可多条 `verify:`）登记验收命令，每轮检查先在 **exec 沙箱**里逐条执行（60 秒超时、输出尾部 2000 字符入事件）。语义：

- **fail-closed**：设定带验收命令的目标时沙箱不可用就直接拒绝（错误 400）；检查时刻沙箱不可用按全部失败计。
- **短路判定器**：任一命令失败就不调判定器（省 token），失败输出直接作为下一轮的修正指引；连续 3 轮全不过 → `gate-exhausted` 停摆。
- 门通过与否只是判定器的**证据**，最终裁决权在判定器（防验收命令本身写错把循环锁死）。

## 机械上限（防失控）

| 上限 | 常量 | 触发后果 |
|------|------|----------|
| 连续自续轮数 | 10（`GOAL_MAX_ROUNDS`） | `round-limit` 停摆；用户发一条消息清零计数后 resume 可继续 |
| 生命周期 token | 2,000,000（`GOAL_TOKEN_BUDGET`，run 用量 + 判定器用量） | 超限后**多给一轮收尾**（`<goal-wrapup>` 注入"整理到可交接状态"），收尾轮照常判定（可能是 met），之后 `budget-limit` 停摆 |
| 判定器判无进展 | 连续 3 轮 progress 为空或「无」 | `no-progress` 停摆 |
| 验收门连败 | 连续 3 轮 | `gate-exhausted` 停摆 |
| 判定器连败 | 解析 3 次 / 传输 5 次 | `judge-failed` 熔断停摆 |
| run 出错 | 1 次 | `run-error` 停摆，不自动重试 |
| 确认超时 | 连续 2 轮含确认超时 | `blocked(permission)`，等人工裁决 |
| 队列入队失败 | 1 次 | 停摆并说明原因（如队列满） |

所有计数（轮数/token/各类连败）**不在进程里记**：每次检查从事件流一次性派生（见下节），进程内只留四个无法从事件恢复的运行时字段。

## 事件与派生（events.jsonl 唯一权威数据）

三种持久化事件（详见 [session-events](../reference/session-events.md)）：

| 事件 | 内容 |
|------|------|
| `goal.set` | `op`（create/edit/pause/resume/state）+ 全量 `GoalSnapshot`；投影写进 `meta.goal` |
| `goal.checked` | 每轮检查一条：轮位、各验收门结果、判定裁决（verdict/reason/progress）或判定器错误、判定器 token；不进 meta 投影、不推进 updatedAt，纯审计 |
| `goal.cleared` | 移除目标时一条，`hadState` 记移除前的状态 |

`GoalLoopHost.#derive` 从最近一次 `goal.set(op:create)` 起单次前向扫描：`run.started(trigger:"goal")` 计轮、`run.ended.usage` 与 `goal.checked.tokens` 累计 token、run 边界配对出确认超时、尾部 `goal.checked` 回溯出四类连败（同性质连续累积，任何不同性质的检查断开计数）。快照（`meta.goal`）里的 `rounds`/`totalRounds`/`tokensUsed` 是检查时刻同步进去的展示缓存，权威数据是事件流。

**armed 是进程内开关**（`GoalRuntime.armed`）：daemon 重启后目标快照还在（meta.goal），但循环**不自动续**——目标循环是"当时授权这台 daemon 自主花钱"的语义，重启即收回，用户显式 resume 才重新起跑。设计取舍见 [ADR-0002](../adr/0002-goal-armed-is-process-local.md)。

## 与相邻系统的交互

- **排队**：goal 轮的 trigger 是 `"goal"`（`run.started` 触发源第五种），处置固定 `wait`（与 job/agent 同款——无人值守的排队行为必须可预测），用户中途输入按自己的处置照常 steer 注入当前 run。
- **唤醒预算**（两次用户发言之间的机器唤醒上限）：goal 轮开跑时同样清零该预算——目标循环自身有九条独立停止条件，不再叠加这份预算，否则长目标里 subagent 投递会先被卡死。
- **subagent 会话**（`parentSessionId` 非空）不能设目标（只读会话）。
- **提示词注入**沿用 XML 标签约定：首轮 `<goal-start>`、续跑 `<goal-continue round=N>`、收尾 `<goal-wrapup>`（闭合标签逃逸防提示词注入）；goal 轮的用户消息带 `note(kind:"goal")` 出处行。
- **审计**：goal 事件在审计页渲染成 "goal" 行（设定/检查/移除各一句话摘要，点击展开完整快照与裁决）。

## 使用入口

- **CLI**：`/goal <目标描述> verify: <命令>…`（多条 `verify:` 各跟一条命令）；`/goal`（无参查看状态）、`/goal pause|resume|stop|clear`。`stop` 同时掐活跃 run 与清空队列。
- **WebUI**：对话页右上角目标悬浮面板（状态点、轮数 `第 N/10 轮`、token 用量、判定器最近意见、验收命令清单；暂停/恢复/停止/移除/编辑表单），active 且 armed 时 5 秒轮询刷新。
- **REST**：`GET/POST /sessions/:id/goal`、`POST …/goal/pause|resume|stop`、`DELETE …/goal`（清单见 [http-api](../server/http-api.md)）。
