# WebUI — 视图、token 引导与 WS 客户端

## 职责

`packages/web` 是 daemon 的浏览器前端：React 单页应用（SPA：单个 HTML 页面内完成全部交互，按需向服务器请求数据），vite 构建、产物由 daemon 静态托管。`src/App.tsx` 是根组件与顶层状态（tab、会话列表、选中会话）；`src/token.ts` 负责 token 引导（`?token=` 握手 → localStorage → 地址栏清除）；`src/ws.ts` 是 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）客户端；`src/api.ts` 是 HTTP 客户端。功能与 CLI 对等（同一套 HTTP + WS API）：流式对话、确认卡片、会话、任务、审计。

## 设计决策

- **零 workspace 依赖**：`@kclaw/web` 不依赖 core/server/cli，协议形状（`src/chat/model.ts` 里的 `Message`/`Block`/`AgentEvent`）是对 daemon 线上格式的手工镜像——只建 UI 关心的子集，类型检查与运行不需要 core 的构建产物。
- **同源托管、同源请求**：daemon 自己服务这份产物，`api` 的 base 是空串（路径即相对路径），`wsUrlFor()` 从 `window.location` 推导 `ws(s)://<host>/ws`——不需要配置任何地址。
- **token 不落 URL**：`?token=` 只是 CLI → 浏览器的一次交接，`bootstrapToken` 存进 localStorage（浏览器提供的按站点隔离的本地键值存储）后立刻用 `history.replaceState` 把查询串从地址栏清掉。
- **401 全局重入**：任何一次 API 401（挂载时的 `/status` 探测或之后的任何调用）都触发 `onUnauthorized` → 清掉存储的 token → 回到 token 输入页；否则刷新页面会重新引导同一个过期 token，死循环。
- **连接由 App 创建、面板只消费**：`ws`（当前会话的客户端）与 `createWs`（重连时重建的工厂）都由 `MainShell` 用 `useMemo`/`useCallback` 保持引用稳定——`ChatPanel` 的两个 effect 以 `[sessionId, api, ws, createWs]` 和 `[sessionId, initialMessages]` 为依赖，引用不稳会导致切 tab/状态探测就重复订阅或重置直播视图。
- **对话面板跨 tab 保活**：`ChatPanel` 切到任务/审计/回收站 tab 时只是 `hidden`，不卸载——直播流和输入框草稿在导航中存活。
- **reducer 是纯函数**：`model.ts` 的 `applyEvent(state, event) → 新 state`，每次转换返回新对象；单个畸形帧只记日志不杀事件循环（否则看起来像断线，诱发无谓的重连）。

## 构建与托管

- **构建**：vite（`packages/web/vite.config.ts`，`outDir: "dist"`）→ `packages/web/dist`。
- **路径解析**（`packages/server/src/daemon.ts`）：`resolveWebDist(opts.webDist)`——显式传入优先（测试注入临时目录）；缺省用 `defaultWebDistPath()`，即从模块 URL 推导的 `<repo>/packages/web/dist`（src/ 与 dist/ 都在 packages 下两层，`../../web/dist` 两边命中同一目录）。**路径不存在解析为 `undefined`**：新 clone 没构建过 web、或传了错误路径时，daemon 保持纯 API 模式（不注册半配置的静态服务），`GET /` 是 404。
- **静态服务**（`packages/server/src/app.ts`）：`webDist` 存在时 `app.register(fastifyStatic, { root: webDist })`，`index.html` 服务于 `GET /`。
- **鉴权豁免**（`isWebShellExempt`）：只有 GET 的 `/`、`/index.html`、`/assets/*` 免 Bearer——外壳与资源必须在浏览器拿到 token 之前能加载；其余一切（sessions/jobs/config/ws）照常受保护。判断用剥掉查询串的原始路径（`@fastify/static` 走 `/*` 通配路由，匹配到的路由 URL 不含路径信息）。

## token 引导（packages/web/src/token.ts）

```ts
export const TOKEN_KEY = "kclaw_token"   // localStorage 键名
export function extractTokenFromUrl(): string | null   // 读 ?token=，URL 解码；缺失/空 → null
export function saveToken(token: string): void
export function loadToken(): string | null
export function clearToken(): void                       // 401 时清掉，配合重入输入页
export function bootstrapToken(): string | null
// 启动引导：URL 有 ?token= → 存 localStorage → history.replaceState 清掉
// 地址栏查询串 → 返回该 token；否则回退 loadToken()；都没有 → null（App 显示输入页）
```

三条进入路径：

1. **`kclaw web`（推荐）**：CLI 拼 `http://127.0.0.1:<port>/?token=<token>` 用系统浏览器打开（见 [onboarding](../cli/onboarding.md)），SPA 启动即握手。
2. **页面输入**：不带 token 打开 `http://127.0.0.1:<port>/`，`TokenForm`（`App.tsx`）粘贴一次 token → `saveToken` + 刷新页面。
3. **401 重入**：token 过期（如 daemon 数据目录重置）→ `clearToken` → 回到 `TokenForm`。

## 视图（App.tsx 布局）

顶栏（品牌 + tab + daemon 状态点，挂载时 GET `/status` 探测，`connecting/connected/error` 三态）、左侧会话栏、右侧 tab 内容：

| 视图 | 组件 | 职责 |
|------|------|------|
| 会话列表（侧栏） | `sessions/SessionList.tsx` | 纯展示组件：列表/选中/新建（workdir 输入）/行内重命名/软删除都经 props 回调逃逸，HTTP 全在 App 层 |
| 对话（tab） | `chat/ChatPanel.tsx` + `ChatView.tsx` | 订阅 + 事件循环 + reducer；ChatView 纯渲染（thinking/tool_result 用原生 `<details>` 折叠）；确认卡片在输入区上方逐张渲染 |
| 任务（tab） | `jobs/JobsView.tsx` | GET `/jobs` 表格（name/cron/enabled/nextRunAt/lastStatus/lastRunAt）；一张表单兼顾新建（POST）与编辑（PATCH），行内启用开关（PATCH `{enabled}`）、删除带原生 confirm；服务端 400 的 `{error}` 文案直接进错误条 |
| 审计（tab） | `audit/AuditView.tsx` | 会话下拉 + `GET /sessions/:id/messages`，把消息摊平成"每块一行"（createdAt 降序），点击展开完整块内容；工具行按 callId 关联 tool 消息的 `grantedBy` 显示放行原因；纯只读 |
| 回收站（tab） | `sessions/TrashView.tsx` | `GET /sessions?deleted=true` 软删除列表，行内恢复（POST `/:id/restore`）与彻底删除（POST `/:id/purge`），操作后重拉 |

会话数据流：挂载时 `GET /sessions`（服务端按 updatedAt 降序）；选中会话后 `GET /sessions/:id/messages` 全量拉取并按会话 id 缓存（`messagesCache`）——缓存保证交给 ChatPanel 的数组引用在整个会话生命周期内稳定。

### 事件 → 视图（chat/model.ts）

- **delta 只追加已知块**：`text.delta`/`thinking.delta`/`tool_call.delta` 按 blockId、`tool_result.delta` 按 callId 匹配已存在的块才追加，未知则丢弃——`*.completed` 事件携带完整块、`message.completed` 携带整条消息，下一次校准自然对齐（乱序容忍 = 丢未知 + 之后整体替换；单连接内事件有序，丢块只发生在重连间隙，重连会全量重拉）。
- `message.created` 插入骨架并标记 `pending`（无块时渲染 "…" 占位），`message.completed` 整体替换。
- `run.started/completed/failed` 驱动 `runState` 与 "running…" 指示；`llm.failed {willRetry:true}` 显示"重试中…"提示（`llm.completed` 或 run 终态清除）。
- `confirmation.requested`/`confirmation.resolved` 增删 `pendingConfirmations` 卡片。

## WS 客户端（packages/web/src/ws.ts）

```ts
export interface WsClient {
  send(obj: Record<string, unknown>): void  // CONNECTING 时入出站队列，open 后按序冲刷
  close(): void
  frames: AsyncIterable<unknown>            // 正常关闭时迭代器结束；4001 关闭则抛 WsAuthError
  onClose(cb: (code?: number) => void): void
}
export function createWsClient(url: string, token: string, socketFactory?: WsSocketFactory): WsClient
export class WsAuthError extends Error { readonly code: number }  // 默认 4001
```

- **认证**：连接打开后第一帧 `{type:"auth", token}`（服务端的按连接认证）。
- **发送排队**：浏览器的 `WebSocket.send()` 在 CONNECTING 状态抛 InvalidStateError，所以 open 之前的发送进 `pendingOut` 队列，open 时在 auth 帧**之后**按到达顺序冲刷——调用方创建客户端后可以立刻 subscribe。
- **4001 特殊处理**：服务端认证失败的关闭码，迭代器以 `WsAuthError` 拒绝；其余关闭只结束迭代器。非 JSON 帧丢弃。
- **重连刻意不在这里**：ws.ts 只管一条连接；重连归 ChatPanel（App 层）。

### ChatPanel 的重连（chat/ChatPanel.tsx）

- 事件循环结束（意外关闭/迭代器抛错）→ 重连：`createWs()` 建新客户端 → subscribe → `refreshMessages()` 全量重拉并 `mergeMessages` 合并（新拉列表是权威：已持久化的覆盖本地流式版本；本地有而新拉没有的——仍在跑、未持久化的消息——原样保留）。
- **重连上限**：连续失败 `MAX_RECONNECT_ATTEMPTS = 3` 次后放弃，提示"重连失败，请刷新页面"；成功一次即清零预算。上限防止 daemon 已死时无限循环重建连接。
- **auth 结局不重连**：4001 关闭或刷新时 API 401 → 提示"认证已失效，请刷新页面重新输入 token"并停止（v1 的 ws 路径没有刷新 token 的流程，交给 401 重入输入页）。
- **确认卡片交互**：`confirmation.requested` 事件入卡片（工具名/args/risk/过期时间），用户点允许/拒绝 → `send({type:"confirmation.resolve", confirmationId, approved, client:"web"})`——`client:"web"` 标记来源，daemon 在决策与审计里记录 web 出处（CLI 不带此字段 → 记 "cli"）。

## 边界与出错

- **`GET /` 404 = 没构建 web**：`resolveWebDist` 找不到目录时 daemon 纯 API 模式；先 `pnpm build`（web 包）再启动 daemon。
- **ws 认证失败没有 token 刷新**：只能刷新页面重新走输入页；API 侧的 401 重入不覆盖 ws 路径。
- **错过的 confirmation.requested 不可恢复**：确认有时限（默认 120s），断线期间超时按拒绝处理；重连全量拉取只能看到结果（note 块），不能补答。
- **审计页无独立 /audit 路由**：轨迹的唯一事实来源是 `messages.jsonl`（经 sessions 路由读取），没有单独的审计接口。
- **无路由库**：tab 是普通 `useState`，刷新回到对话 tab；会话列表无分页、全量返回。

## 关联

- [realtime](../server/realtime.md)：/ws 帧协议、订阅语义、断线恢复规则（CLI 与 WebUI 的共同契约）
- [http-api](../server/http-api.md)：各视图消费的 REST 路由
- [daemon](../server/daemon.md)：webDist 解析与静态托管、鉴权豁免的服务端侧
- [onboarding](../cli/onboarding.md)：`kclaw web` 命令与 `?token=` 的发送侧
- [protocol](../core/protocol.md)：事件目录与持久化块结构（model.ts 镜像的源头）
