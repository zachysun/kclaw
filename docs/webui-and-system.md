# kclaw 核心原理：WebUI 与全系统收束（P4）

> 最后一篇：本文阐述 WebUI 的设计与 kclaw v1 全系统的收束视图。前序：`docs/core-internals.md`（引擎）、`docs/persistence-and-tools.md`（持久化与工具）、`docs/daemon-and-cli.md`（daemon 与 CLI）。

## 1. WebUI 的架构决定

### 1.1 零框架依赖的 SPA

Web 包只有 react/react-dom 两个运行时依赖——没有 UI 库、状态库、路由库。三个原因：

1. **事件流本来就是"单向数据流"**：WS 帧 → reducer（纯函数）→ React 渲染，天然契合 `useReducer` 语义，引入状态库是重复劳动；
2. **视图层由协议驱动**：28 种 `AgentEvent` 是唯一的"状态来源"，reducer 只是它的投影；
3. 依赖面越小，构建产物越简单（vite 打包 ~200KB 级），冒烟测试越好写。

### 1.2 事件→视图 reducer：唯一值得单测的"大脑"

`src/chat/model.ts` 是纯函数 `(messages, event) → view`，规则对照 spec §5：

- **delta 键控追加**：text/thinking 按 `blockId`、tool_result 按 `callId` 追加；**未知 blockId 的 delta 直接丢弃**——不缓存不猜测，`message.completed` 会带着全量来校准。这条"丢弃+校准"闭环是流式 UI 不发疯的关键。
- **completed 全量替换**：块级 completed upsert、消息级 completed 整体替换——delta 攒了半天的内容，以 completed 的权威快照为准。
- **confirmation 生命周期**：requested 推入卡片、resolved 按 confirmationId 移除——卡片是"挂起的确认"，事件流是唯一真相。
- **run 终态**：run.completed/failed → 状态复位 + 错误展示；llm.failed{willRetry} → "重试中"提示（provider 降级不再是无声等待）。

### 1.3 鉴权：壳豁免 + 一次性引导

浏览器发不了自定义 `Authorization` 头，所以静态壳（`/`、`/assets/*`）豁免 Bearer——但**壳本身没有数据价值**：一切 API/WS 仍需鉴权。token 的进入路径：

```
首次访问 http://127.0.0.1:port/?token=<来自 ~/.kclaw/token>
  → shell JS 提取 → localStorage 存储 → history.replaceState 剥离 URL
  → 之后全部请求带 Bearer；401 时清 token 回到输入页
```

token 不进 URL（剥了）、不进日志（logger 关闭）、不进事件。

## 2. 全系统收束：一页视图

```
┌─ kclaw CLI ─────────┐   ┌─ WebUI（Vite+React，daemon 静态托管）──┐
│ REPL/流式/确认弹框   │   │ 流式对话/确认卡片/会话/任务/审计        │
└──────┬──────────────┘   └──────────────┬───────────────────────┘
       │  HTTP(会话/任务/配置/审计) + WS(订阅/命令/事件)  Bearer/首帧auth
       ▼                                  ▼
┌─ @kclaw/server（daemon，唯一状态权威）────────────────────────────┐
│ RunManager（会话串行、记忆注入、审计适配、确认竞速镜像）            │
│ ConfirmationBroker（只做桥：不发事件、不管超时）                   │
│ Scheduler tick（due→新会话→job run→markRun，in-flight 防重入）     │
│ EventBus（sessionId 订阅 + 无 sessionId 广播，per-socket 守卫）    │
│ launchDaemon（token/pidfile/启动对账/有界 stop/超时链）            │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌─ @kclaw/core（纯库引擎）──────────────────────────────────────────┐
│ runAgent 循环（流式/工具调度/权限确认流/abort/error 终态不变量）   │
│ provider（SSE 解析/归一化/重试/超时）· 9 内置工具 · 记忆 · 调度     │
└──────────────────────────────────────────────────────────────────┘
```

**贯穿全链的三条不变量**（每个阶段评审都在验证它们）：

1. **事件零变形**：AgentEvent 信封从 loop 到浏览器 reducer 逐字节一致，daemon 不发明事件，ack/error 帧与事件流二分；
2. **run.started 必有终态**：provider 失败、用户消息失败、abort——任何路径都以 run.completed/run.failed 结束，客户端渲染永不挂起；
3. **事件反映已持久化状态**：onMessage（写 JSONL）先于 message.completed 发射——断线重连拉全量后，事件流与磁盘一致。

## 3. 工程史：四阶段怎么长出来的

| 阶段 | 交付 | 关键教训（来自评审修复） |
|------|------|--------------------------|
| P1 core-foundation | 协议/循环/provider | 字节 vs 码元偏移（UTF-8 截断）；run 终态不变量 |
| P2 persistence-tools | 存储/工具/记忆/权限/调度 | 配置引用共享污染；String.replace 模式注入；权限路径规范化 |
| P3 daemon+cli | 常驻服务+终端产品 | 确认竞速镜像审计；pid 0 进程组信号；ws 发送队列 |
| P4 webui | 浏览器产品 | CONNECTING 期 send 被吞；401 重输闭环；重连有界 |

每阶段的"终审修复波"抓到的都是真实的跨模块缺陷——这验证了 subagent-driven 流程里"独立评审席位"的价值：实现者看不见自己的盲区。

## 4. v1 边界与 v2 方向

**v1 已记录边界**（有意为之，非缺陷）：WebUI 无设置页（GET /config 已存在）；多会话并行无上限；auto_extract 提取器仅配置位；npm 打包未做；聊天渠道/系统级沙箱/长会话摘要/attachment 生成为 v2。

**v2 方向**（按价值排序）：渠道适配器（Telegram/微信——架构已预留，只是又一个客户端）；系统级沙箱（容器/sandbox-exec，替换软沙箱边界）；embedding 记忆检索（替代 bigram）；多会话并行上限与 WebUI 设置页；npm 发布（需先解决 bin 解析的 repo-checkout 假设）。
