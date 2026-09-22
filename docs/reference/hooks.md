# hooks — hook 位置与内置 hook 清单

> 权威来源：`packages/core/src/hooks/types.ts`（位置与契约）、`hooks/positions.ts`（运行时清单）、`hooks/builtin.ts`（内置 hook 唯一定义来源 `BUILTIN_HOOK_SPECS`，管理接口用的 `BUILTIN_HOOK_DEFINITIONS` 由它投影）。机制见 [hooks](../core/hooks.md)。

## HookPosition（14 个）

位置的封闭联合——run 时间线上全部命名挂载点：

```ts
export type HookPosition =
  | "run-before" | "run-after"
  | "llm-before" | "llm-after" | "llm-retry"
  | "tool-before" | "tool-after"
  | "turn-boundary"
  | "compaction-check" | "overflow-rescue" | "compaction-after"
  | "think-after"
  | "system-before" | "system-after"
```

| 位置 | ctx | 返回（改写生效） | 性质 |
|------|-----|------------------|------|
| `run-before` | `{ message }` | `Message` | 改写位：用户消息入场 |
| `run-after` | `{ outcome, model }` | — | 观察位：run 结束 |
| `llm-before` | `{ messages }` | `ProviderMessage[]` | 改写位：模型视图 |
| `llm-after` | `{ usage, stopReason, latencyMs }` | — | 观察位 |
| `llm-retry` | `{ attempt, error }` | — | 观察位：provider 重试 |
| `tool-before` | `{ toolCall }` | — | 观察 + 放行检查（deny 档失败 = 该工具被拒绝） |
| `tool-after` | `{ toolCall, result }` | — | 观察位 |
| `turn-boundary` | `{}` | `Message[]` | 注入位：迭代边界 |
| `compaction-check` | `{}` | `ActiveSummary \| null` | 内置独占决策位：中途压缩 |
| `overflow-rescue` | `{ error }` | `ActiveSummary \| null` | 内置独占决策位：溢出急救 |
| `compaction-after` | `{ phase, result }` | — | 观察位：压缩结果 |
| `think-after` | `{ block }` | — | 观察位：思考块完成 |
| `system-before` | `{ base }` | `string[]` | 追加位：提示词段落（多 hook 累积） |
| `system-after` | `{ system }` | `string` | 改写位：提示词终稿 |

## 内置 hook（15 个）

order = 同位置内的执行次序（升序）：

| name | position | order | failure | 一句话 |
|------|----------|-------|---------|--------|
| `memory-inject` | run-before | 10 | skip | 检索记忆库，收集相关经历 note（收集不落位） |
| `user-message-land` | run-before | 20 | fatal | 追加 job/记忆 note、持久化用户消息、逐块 note.emitted |
| `autoname` | run-before | 30 | skip | 新会话首条消息的后台自动命名 |
| `skill-wrap` | llm-before | 10 | skip | 技能与 @ 文件调用的隐式包装（只改模型视图） |
| `retry-notify` | llm-retry | 10 | skip | provider 重试转 llm.failed 事件 |
| `steering-drain` | turn-boundary | 10 | fatal | 取走队列引导缓冲并注入对话 |
| `background-precompact` | compaction-check | 5 | skip | 预压线触发后台压缩（不限时） |
| `mid-run-panic` | compaction-check | 10 | skip | 红线阈值的迭代边界压缩判定（不限时） |
| `overflow-emergency` | overflow-rescue | 10 | skip | 溢出急救压缩，换视图整次重发（不限时） |
| `usage-ledger` | run-after | 10 | skip | 记录本次 run 的 token 用量 |
| `manual-compact-flush` | run-after | 15 | skip | 冲刷运行忙时排队的 /compact（不限时） |
| `post-run-compaction` | run-after | 20 | skip | 黄线阈值的收尾压缩（不限时） |
| `follow-check` | run-after | 30 | skip | 排一个记忆空闲检查 |
| `skill-follow-check` | run-after | 40 | skip | 技能进化的零成本粗查：卷入技能才排提炼空闲检查（未启用即跳过） |
| `system-materials` | system-before | 10 | skip | 收集认知与技能清单两个提示词段（live 段） |

`compaction-after` 位置没有静态内置条目：压缩 hook 经 `compactionAfter` 回调把结果（applied→ok / failed / cancelled，declined 静默）转发到该位置的链上。

subagent run（`childRun`）的派生跳过：`memory-inject` 不检索、`autoname` 跳过、`follow-check` 不挂、`skill-follow-check` 不排、`system-materials` 返回空段。

## HookMeta 字段

用户 hook 文件与内置 hook 共用同一份元数据形状：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 内置 = 功能名；用户 = 文件基名（身份） |
| `position` | HookPosition | 挂载位置 |
| `description?` | string | 描述（管理页显示） |
| `enabled` | boolean | 是否启用 |
| `order` | number | 同位置内升序执行；用户 hook 默认 1000（落在内置 10–99 之后） |
| `failure` | `"fatal" \| "skip" \| "deny"` | 失败策略（见下） |
| `origin` | `"builtin" \| "user"` | 来源 |
| `timeoutMs?` | number | 条目级超时覆盖；默认 = 链默认（config `hooks.timeoutMs`，5000ms）；Infinity = 不限时 |
| `error?` | string | 装载失败原因（用户 hook；失败条目不运行） |

## failure（3 档）

| 值 | 含义 |
|----|------|
| `skip` | 失败即跳过，发一条 `hook.failed`，run 照常（用户 hook 默认） |
| `deny` | 失败否决所在环节（tool-before 上 = 该工具不执行，fail-closed 自选档） |
| `fatal` | 抛错穿透 run（仅内置可用；用户声明会被拒绝装载） |
