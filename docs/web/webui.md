# WebUI — 视图、token 引导与 WS 客户端

## 职责

`packages/web` 是 daemon 的浏览器前端：React 单页应用（SPA：单个 HTML 页面内完成全部交互，按需向服务器请求数据），vite 构建、产物由 daemon 静态托管，并按 PWA（渐进 Web 应用：可安装到主屏、带离线外壳）方式布置了 Service Worker 与清单文件。`src/App.tsx` 是根组件与顶层状态（tab、会话列表、选中会话）；`src/token.ts` 负责 token 引导（`?token=` 握手 → localStorage → 地址栏清除）；`src/ws.ts` 是 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）客户端；`src/api.ts` 是 HTTP 客户端（含附件上传）。功能与 CLI 对等并多出图形化部分（同一套 HTTP + WS API）：流式对话、确认卡片、会话（按工作目录分组）、任务、审计、用量台账、回收站、记忆管理。

## 设计决策

- **仅依赖 core 的共享命令表**：`@kclaw/web` 除 react/react-dom 外只依赖 `@kclaw/core` 的 `commands` 共享表（纯数据：slash 命令的 name/usage 元数据，CLI 与 WebUI 同源，见 [extending](../extending.md)）；其余协议形状（`src/chat/model.ts` 里的 `Message`/`Block`/`AgentEvent`）是对 daemon 线上格式的手工镜像——只包含 UI 关心的子集，类型检查与运行不需要 core 的其余构建产物。
- **同源托管、同源请求**：daemon 自己服务这份产物，`api` 的 base 是空串（路径即相对路径），`wsUrlFor()` 从 `window.location` 推导 `ws(s)://<host>/ws`——不需要配置任何地址。
- **token 不落 URL**：`?token=` 只是 CLI → 浏览器的一次交接，`bootstrapToken` 存进 localStorage（浏览器提供的按站点隔离的本地键值存储）后立刻用 `history.replaceState` 把查询串从地址栏清除。
- **`?session=` 深链**：任务通知里的会话链接（`/?session=<id>`）在会话列表加载完成后一次性消费——命中列表则自动选中该会话（与点击列表项同一状态路径），未命中保持默认行为；无论命中与否都立即 `history.replaceState` 清掉参数，刷新不会重复跳转。
- **401 全局重入**：任何一次 API 401（挂载时的 `/status` 探测或之后的任何调用）都触发 `onUnauthorized` → 清除存储的 token → 返回 token 输入页；否则刷新页面会重新引导同一个过期 token，形成死循环。
- **连接由 App 创建、面板只消费**：`ws`（当前会话的客户端）与 `createWs`（重连时重建的工厂）都由 `MainShell` 用 `useMemo`/`useCallback` 保持引用稳定——`ChatPanel` 的两个 effect 以 `[sessionId, api, ws, createWs]` 和 `[sessionId, initialMessages]` 为依赖，引用不稳定会导致切换 tab/状态探测时重复订阅或重置实时视图。
- **对话面板跨 tab 保活**：`ChatPanel` 切到任务/审计/用量/回收站 tab 时只是 `hidden`，不卸载——直播流和输入框草稿在导航中存活。
- **选中会话时每次都重新拉取，缓存只追加不覆盖**：每次选中一个会话（包括重新选回刚才那个）都会 `GET /sessions/:id/messages` 拉一遍全量消息。拉到的结果用 `unionById` 按 id 合并进按会话缓存的列表：已见过的消息以缓存里的为准，新出现的 id 追加到尾部——因为缓存的快照可能落后于服务端（别的连接在往里写），但不会超前。合并进来的底稿再由 `ChatPanel` 用 `mergeMessages` 融进当前正在直播的视图，而不是整个重置视图，这样切走再切回不会丢掉正在流式输出的气泡。
- **reducer 是纯函数**：`model.ts` 的 `applyEvent(state, event) → 新 state`，每次转换返回新对象；单个畸形帧只记日志，不中断事件循环（否则表现为断线，诱发无谓的重连）。
- **响应式外壳**：桌面端侧栏常驻；窄屏侧栏收成抽屉，点顶栏 ☰ 打开、点背板或切换 tab 关闭。视觉设计集中在 CSS 变量里（design tokens）：整体是暖色近黑画布，唯一的强调色是琥珀色（amber），专门用来表示"agent 正在活动"——daemon 连接中的状态点、回复进行时的脉冲光标行、输入框提示符都是它。

## 构建与托管

- **构建**：vite（`packages/web/vite.config.ts`，`outDir: "dist"`）→ `packages/web/dist`。
- **路径解析**（`packages/server/src/daemon.ts`）：`resolveWebDist(opts.webDist)`——显式传入优先（测试注入临时目录）；缺省用 `defaultWebDistPath()`，即从模块 URL 推导的 `<repo>/packages/web/dist`（src/ 与 dist/ 都在 packages 下两层，`../../web/dist` 两者指向同一目录）。**路径不存在解析为 `undefined`**：新 clone 没构建过 web、或传了错误路径时，daemon 保持纯 API 模式（不注册半配置的静态服务），`GET /` 是 404。
- **静态服务**（`packages/server/src/app.ts`）：`webDist` 存在时 `app.register(fastifyStatic, { root: webDist })`，`index.html` 服务于 `GET /`。
- **鉴权豁免**（`isWebShellExempt`）：只有 GET 的 `/`、`/index.html`、`/assets/*` 与 PWA 静态文件（`/manifest.webmanifest`、`/sw.js`、`/icon-192.png`、`/icon-512.png`、`/favicon.ico`）免 Bearer——外壳与资源必须在浏览器获得 token 之前能加载；其余一切（sessions/jobs/config 等）照常受保护，`/ws` 则走连接级认证（升级路由本身豁免，见 [realtime](../server/realtime.md)）。判断使用去除查询串的原始路径（`@fastify/static` 使用 `/*` 通配路由，匹配到的路由 URL 不含路径信息）。

## PWA 与离线外壳（public/）

kclaw 的网页版按 PWA（Progressive Web App，渐进 Web 应用：浏览器里可以"安装到主屏"、离线也能打开外壳）方式布置，涉及三个文件和一个入口挂载。

- **manifest.webmanifest**：声明应用名、`standalone` 显示模式、主题色 `#111827` 和 192/512 两枚图标——满足浏览器"可安装"判定的最低要求。
- **sw.js**（Service Worker：浏览器在页面之外后台运行的一段脚本，可以拦截网络请求）：只为一个目标服务——断网时页面外壳打得开。
  - `install` 阶段把三个外壳文件 `SHELL = ["/", "/index.html", "/manifest.webmanifest"]` 预存进缓存（缓存名 `kclaw-shell-v1`）；`activate` 阶段清掉其他名字的旧缓存。
  - 拦截到 `fetch` 请求时走"缓存优先"：命中缓存直接返回；但 `/ws`、`/api` 开头的路径和一切非 GET 请求照常发往网络，不查缓存——对话数据永远以 daemon 为准。
  - 除预缓存外**没有任何运行时写入缓存**的代码（没有 `cache.put`）：消息和 API 响应一律不被 Service Worker 缓存。
- **offlineBanner.ts**：页面入口 `main.tsx` 调用 `registerServiceWorker()` 完成注册，并渲染 `<OfflineBanner />`；后者通过 `navigator.onLine` 与 online/offline 事件监测连接状态，断网时在页首显示横幅提示。

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

1. **`kclaw web`（推荐）**：CLI 构造 `http://127.0.0.1:<port>/?token=<token>` 用系统浏览器打开（见 [onboarding](../cli/onboarding.md)），SPA 启动即握手。
2. **页面输入**：不带 token 打开 `http://127.0.0.1:<port>/`，`TokenForm`（`App.tsx`）粘贴一次 token → `saveToken` + 刷新页面。
3. **401 重入**：token 过期（如 daemon 数据目录重置）→ `clearToken` → 回到 `TokenForm`。

## 视图（App.tsx 布局）

顶栏（品牌 + ☰ 抽屉按钮〔窄屏〕+ 六个 tab：对话/任务/审计/用量/回收站/记忆 + daemon 状态点，挂载时 GET `/status` 探测，`connecting/connected/error` 三态）、左侧会话栏、右侧 tab 内容：

| 视图 | 组件 | 职责 |
|------|------|------|
| 会话列表（侧栏） | `sessions/SessionList.tsx` | 按 workdir 分组的会话列表：工作目录相同的会话排在同一个组头下面，组名默认就是目录路径，可以内联改名（改名存进 localStorage 键 `kclaw_workdir_names`，刷新页面后仍在）。每个组头带一个 ＋ 按钮，点击即在该目录新建会话；列表顶部的"＋ 选择工作目录新建会话"则打开 DirectoryPicker 浏览本机目录，选中哪个目录就在那里创建新会话——选中目录这个动作本身就是创建。单个会话的行内重命名与删除经 props 回调交上层处理。没有 workdir 的旧会话和任务会话归入"未指定工作目录"组 |
| 对话（tab） | `chat/ChatPanel.tsx` + `ChatView.tsx` | 订阅 + 事件循环 + reducer；ChatView 只做渲染（thinking/tool_result 用原生 `<details>` 折叠）；确认卡片在输入区上方逐张渲染；输入区上方有模型选择器，选项来自 `GET /config` 返回的 provider 条目名，切换时调 `POST /sessions/:id/model`；输入框正上方有一条通知条（命令结果、上传失败、重连状态等所有面板提示同用这一条，开始输入新消息时自动清除，见 [compaction](../core/compaction.md)）；文件可以直接拖进聊天区上传，上传后的附件列成一条待发条带，随下一条消息一起发出。**slash 命令**：`/` 开头的输入在发送路径最前面被拦截（`chat/commands.ts` 的 `runWebCommand`，与 CLI 同一拦截点），命中就不发给模型——`/new [标题]`、`/clear`（复用 App 的建会话流程，落在默认工作区）、`/sessions`（打开侧栏）、`/model [名字]`、`/readonly [on\|off]`、`/compact [重点说明]`，结果都落在通知条；`/help` 由 ChatView 自己渲染成命令面板；`/attach`、`/exit` 是终端专属。**命令联想**：输入 `/` 时输入框上方弹出候选（清单与文案读自 `@kclaw/core/commands` 共享表，与 CLI 同源），前缀过滤、↑↓ 选择、Tab、点击或回车补全（带尾随空格，回车在菜单开着时是"接受候选"而不是提交半截词）；输入框已是完整命令名时回车直接执行；Esc 关闭。**发送即时回显与排队呈现**：乐观回显按会话忙闲分路（Master 2026-08-30 第二轮）——忙会话（run 进行中或压缩中）发送必然排队，消息**从第一帧起就不进消息流**：乐观回显直接落到输入框上方的排队列表（`local-` 前缀的待确认行，发送时所选处置作标签），服务器 ack 带 `messageId` 时行原地改名转正、`message.queued` 到达刷新处置；轮到该消息执行时同 id 的 `message.created` 才把它作为正常气泡落进消息流。空闲直发保持原样：立即回显 `local-` 气泡，`message.created` 到达按文本替换本地副本，重连全量拉取同理去重。收养还有一条竞态缝：发送瞬间会话恰好由闲转忙（`run.started` 抢在发送处理前到场）时先渲染了气泡，`message.queued` 会收走该气泡转成列表行。跨客户端排队的消息（`message.queued` 载荷不带文本）在本端落地为空文本行，面板检测到空文本行会自动拉一次 `GET /sessions/:id/queue` 把文本补上。不再用本地启发式提示"已排队"。压缩进行时显示"正在压缩早期对话…"指示行，行内带**取消按钮**（`compaction.started`/`compaction.completed` 事件驱动，run 生命周期事件兜底清除；点取消发 `{type:"compaction.cancel"}`，`completed` 以任意 result——成功/失败/取消——到达时清掉 compacting 状态，按钮随行消失）。**手动发起的压缩（`/compact`）不渲染取消按钮**——服务端的 `cancelCompaction` 不作用于手动压缩（见 [compaction](../core/compaction.md)）。**压缩上下文块**：默认折叠条改由**压缩审计驱动**——ChatPanel 拉取 `GET /sessions/:id/compactions`，ChatView 的 `compactionBars` 从审计记录为每次压缩生成一条默认折叠的 `<details>` 条（"模型上下文：早期对话已压缩为 N 段"），按记录里的 `upto` 插到对应消息之后（贴近压缩实际发生的位置，且天然去重——每条审计记录只出一条）；展开后是摘要全文。旧会话里带结构化 meta（`compact: {segments, kept}`）的 compact note 仍走 `contextBarFor` 旧路径渲染成折叠条（"保留的原文"预览：该消息之前的 kept−1 条，每条一行：角色 + 截断到 120 字的正文），没有 meta 的旧格式 compact note 按普通 note 内联显示，不会凭空消失。拉取压缩审计失败静默（`compactions` 保持空就不渲染审计条，旧 note 路径不受影响） |
| 任务（tab） | `jobs/JobsView.tsx` | GET `/jobs` 表格（name/cron/enabled/nextRunAt/lastStatus/lastRunAt）；一张表单兼顾新建（POST）与编辑（PATCH），行内启用开关（PATCH `{enabled}`）、删除带原生 confirm；服务端 400 的 `{error}` 文案直接显示于错误提示条 |
| 审计（tab） | `audit/AuditView.tsx` | 会话下拉 + `GET /sessions/:id/messages`，把消息摊平成"每块一行"、按 createdAt **升序**排列（最新在底部，像日志），点击展开完整块内容；工具行按 callId 关联 tool 消息的 `grantedBy` 显示放行原因；选中会话后追加拉取 `GET /sessions/:id/compactions`，把每条压缩记录按发生时间（`record.at`）交错进同一条轨迹渲染成一个"压缩"行（时间、触发方式〔自动（收尾）/自动（运行中）/手动，手动附 focus；`emergency` 急救加"·超限急救"标注〕、被压范围 `from–upto`、条数，点击展开段摘要与总摘要全文）——每条记录贴在实际发生的位置、天然按时间排序；纯只读 |
| 用量（tab） | `usage/UsageView.tsx` | 并发拉 `GET /usage?by=day` 与 `?by=session` 两份聚合：顶部总计行（输入/输出 token 与费用）+ "导出 JSON" 按钮（再拉一份 by=session 存为 `kclaw-usage.json` 下载）；两张表分别按天、按会话列 token 与费用，未配置价格的模型费用显示"—" |
| 回收站（tab） | `sessions/TrashView.tsx` | `GET /sessions?deleted=true` 软删除列表，行内恢复（POST `/:id/restore`）与彻底删除（POST `/:id/purge`），操作后重新拉取 |
| 记忆（tab） | `memory/MemoryView.tsx` | 记忆管理页：左侧三个区块——**项目**（`GET /memory/projects`，每个项目一行 `id（N 线）`）、**主题线**（点项目后 `GET /memory/projects/:id`，每行 `一句话 · 状态 · 最近活动`）、**全局认知**（`GET /memory/global`，每行 `kind/name · 更新时间`）；点开一条主题线或一个认知文件，右侧出现**整文件编辑器**（textarea 全文，保存 = `PATCH /memory/threads/:project/:topic` 或 `PATCH /memory/global/:kind/:file`，删除 = 对应 `DELETE`；编辑与删除后的列表刷新见下）。项目与全局认知两个 GET 在挂载时并行拉取，任一失败（含 daemon 未装配记忆时的 503）走通知条提示；主题线在点开某个项目时才拉取。删除认知文件的 persona 会吃 400（persona 不可删除，见 [http-api](../server/http-api.md)）。编辑是"人即是真相"的整文件覆写，不校验 frontmatter |

会话数据流：挂载时 `GET /sessions`（服务端按 updatedAt 降序）；**每次**选中会话都 `GET /sessions/:id/messages` 全量拉取并经 `unionById` 按会话 id 并入缓存（`messagesCache`）——只追加未知 id，不覆盖已有条目；缓存保证传给 ChatPanel 的数组引用稳定。

### 自动命名的即时反馈

会话发出首条消息后，daemon 会自动生成标题并广播 `session.renamed {title}` 事件（发射方见 [run-manager](../server/run-manager.md) 的 autoname）。ChatPanel 在事件循环里把这个事件单独挑出来、不送进消息 reducer——它描述的是会话本身而不是某条消息，进 reducer 反而会污染对话状态。事件携带的标题经回调 `onSessionRenamed` 直接更新 App 里的会话列表，侧栏不用刷新页面就显示新名字。

### 发送三选与排队列表（message-queue spec §7.1）

- **三选（disposition trio）**：会话运行中时输入框上方出现"引导 / 等待 / 中断"三个按钮（`runState === "running"` 才渲染——空闲时任何处置等价于普通发送）。默认选中来源与会话级覆盖同源：会话 meta 的 `dispositionOverride` > 配置 `sessions.defaultDisposition` > steer（挂载时并行拉 `GET /sessions/:id` 与 `GET /config` 解析，daemon 不可达时静默维持 steer）。点选或方向键旋转（←→↑↓，radio 语义）即生效：本地立即改当前发送值，同时 `POST /sessions/:id/disposition` 写会话级覆盖（sticky，与 CLI `/steer`、`/wait` 同一存储，刷新/重进会话后仍生效）。每条 `send_message` 显式携带当前选择。**中断选择的粘性风险**：会话级覆盖对**所有客户端**生效（CLI、其他浏览器标签页读到的是同一份 meta）——把三选停在「中断」上，后续每条普通发送都会先掐掉当时的活动 run 再插队执行（spec §7.1 有意为之：覆盖是会话级 sticky 状态，不是一次性选择）。用完中断请切回「引导」或「等待」，否则会话会一直处于"来一条、断一条"的节奏。
- **排队列表（Master 2026-08-30 改版）**：排队中的消息**不以气泡形式进消息流**，显示在输入框正上方（通知条同一位置带）的排队列表里——一行一条、按发送序排列（先排队的在上面），每行是"处置标签（引导/等待/中断）+ 单行截断的消息文本（悬停可见全文）+ 取消按钮"。列表头部带计数"N 条排队中"与"全部取消"。**忙会话发送的消息从第一帧起就是列表行**（见上文"发送即时回显与排队呈现"的分路），不是先显示气泡再转入。单条取消与全部取消都发 `queue.cancel` 帧；interrupt 行不渲染取消按钮（入队即伴随中止、紧接着出队执行，没有可取消窗口，点了也只能换来 `not found`）。列表**不随输入清除**：它不是一次性提示，是会话状态；一次性 notice（"已重连"、命令结果等）开始输入才清除，列表要等排队真正消化（执行/取消）才消失。
- **排队消息何时进入消息流**：轮到它执行（wait/interrupt 的 run 开始）或注入（steer 被当前 run 消化）时，同 id 的 `message.created` 把它作为正常历史气泡落进消息流末尾，列表行随之消失；取消则列表行直接消失、消息不落盘。
- **重连/刷新纠偏**：重连成功时与全量消息并行拉 `GET /sessions/:id/queue`，`mergeQueue` 以服务端快照为准**整体重建**列表（服务端序 = 发送序）；快照里没有而本地还挂着的行（断线期间被取消/出队/注入）直接丢弃——出队/注入的消息经消息基线拉取已作为普通气泡到场，删除行不产生残留。队列拉取失败不阻塞消息合并（事件流继续纠偏），反之亦然。

### 事件 → 视图（chat/model.ts）

- **delta 只追加已知块**：`text.delta`/`thinking.delta`/`tool_call.delta` 按 blockId、`tool_result.delta` 按 callId 匹配已存在的块才追加，未知则丢弃——`*.completed` 事件携带完整块、`message.completed` 携带整条消息，下一次校准自然对齐（乱序容忍 = 丢未知 + 之后整体替换；单连接内事件有序，丢块只发生在重连间隙，重连会全量重新拉取）。
- `message.created` 插入骨架并标记 `pending`（无块时渲染 "…" 占位），`message.completed` 整体替换。若该 id 在排队列表里，这是出队/注入信号：行移出列表、消息本体作为正常气泡追加到消息流末尾（它就是当前最新的消息；排队期间没有气泡在场，也就没有"原地升级"一说——原地替换只服务于空闲直发消息的乐观孪生合并）。
- **排队三事件**：`message.queued {messageId, disposition, position?}` 的落地次序——先认领本地待确认的列表行（忙会话发送建的 `local-` 行，改名并保留文本）；没有行则收走待确认的乐观气泡（闲转忙竞态，文本带走建行）；都没有（跨客户端/重放边缘）落地空文本行，由面板的快照补全。已跟踪的 id 只刷新处置（恢复重播把 steer/interrupt 降级报为 wait），不重复收养。`message.steered {messageId}` 直接删除对应行（注入完成，消息本体随后/已经由 `message.created` 落进消息流）；`message.queue_cancelled` 按 `messageId` 或 `all:true` 删除对应/全部行（取消的消息从未落盘，无气泡残留）。
- `run.started/completed/failed` 驱动 `runState` 与 "running…" 指示；`llm.failed {willRetry:true}` 显示"重试中…"提示（`llm.completed` 或 run 终态清除）。
- `confirmation.requested`/`confirmation.resolved` 增删 `pendingConfirmations` 卡片。
- `memory.written`（记忆落盘反馈，spec 9.3）单独挑出来、不进 reducer：读 `payload.path` 在通知条显示 `已写入记忆: <path>`（与 CLI 同文案）；它描述的是记忆库而不是某条消息，进 reducer 反而会污染对话状态。事件本身不带记忆内容，要看内容切到「记忆」tab。

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
- **发送排队**：浏览器的 `WebSocket.send()` 在 CONNECTING 状态抛 InvalidStateError，所以 open 之前的发送进入 `pendingOut` 队列，open 时在 auth 帧**之后**按到达顺序冲刷——调用方创建客户端后可以立刻 subscribe。
- **4001 特殊处理**：服务端认证失败的关闭码，迭代器以 `WsAuthError` 拒绝；其余关闭只结束迭代器。非 JSON 帧丢弃。
- **重连刻意不在此层**：ws.ts 只管理一条连接；重连由 ChatPanel（App 层）负责。

### ChatPanel 的重连（chat/ChatPanel.tsx）

- 事件循环结束（意外关闭/迭代器抛错）→ 重连：`createWs()` 建新客户端 → subscribe → `refreshMessages()` 并行全量拉取消息与排队快照（`GET /sessions/:id/messages` + `GET /sessions/:id/queue`）并分别合并：消息经 `mergeMessages` 合并（新拉取列表是权威：已持久化的覆盖本地流式版本；本地有而新拉取列表没有的——仍在执行、未持久化的消息——原样保留），队列经 `mergeQueue` 以服务端快照为准整体重建排队列表行（方向性细节见上文"发送三选与排队列表"的重连纠偏条）。
- **重连上限**：连续失败 `MAX_RECONNECT_ATTEMPTS = 3` 次后放弃，提示"重连失败，请刷新页面"；成功一次即清零预算。上限防止 daemon 已终止时无限循环重建连接。
- **auth 结局不重连**：4001 关闭或刷新时 API 401 → 提示"认证已失效，请刷新页面重新输入 token"并停止（ws 路径没有刷新 token 的流程，交给 401 重入输入页）。
- **确认卡片交互**：`confirmation.requested` 事件加入卡片（工具名/args/risk/过期时间），用户点允许/拒绝 → `send({type:"confirmation.resolve", confirmationId, approved, client:"web"})`——`client:"web"` 标记来源，daemon 在决策与审计里记录 web 出处（CLI 不带此字段 → 记 "cli"）。

## 边界与出错

- **`GET /` 404 = 没构建 web**：`resolveWebDist` 找不到目录时 daemon 纯 API 模式；先 `pnpm build`（web 包）再启动 daemon。
- **ws 认证失败没有 token 刷新**：只能刷新页面重新进入输入页；API 侧的 401 重入不覆盖 ws 路径。
- **错过的 confirmation.requested 不可恢复**：确认有时限（默认 120s），断线期间超时按拒绝处理；重连全量拉取只能看到结果（note 块），不能补答。
- **错过的排队事件由快照兜底**：断线期间的 `message.queued`/`message.queue_cancelled` 不重放（重连只订阅新事件，不回放），重连时的 `GET /queue` 全量纠偏负责重建排队视图；快照拉取失败（旧版本 daemon 无此路由等）不阻塞消息合并，排队视图退化为纯事件驱动。
- **消息轨迹没有独立 /audit 路由**：轨迹的唯一事实来源是 `messages.jsonl`（经 sessions 路由读取）；压缩记录有只读接口 `GET /sessions/:id/compactions`，在审计页选中会话后按发生时间交错进消息轨迹渲染（见上文审计 tab），无记录时不显示。
- **Service Worker 缓存只覆盖外壳三文件**：消息与 API 响应永远不经过 Service Worker 缓存。缓存名带构建指纹：`public/sw.js` 里的 `kclaw-shell-__BUILD_ID__` 占位符在每次构建时被 `scripts/inject-sw-hash.mjs` 替换为 `dist/index.html` 内容的 sha256 前 10 位——前端任何改动都会改变 index.html（它引用带内容 hash 的 bundle）→ 指纹变 → sw.js 字节变 → 浏览器重装 SW、换新缓存名并在 `activate` 阶段清掉旧缓存。因此**发布新版外壳后用户浏览器自动换新，无需手动清缓存**；同源码重复构建指纹稳定，缓存名不会无意义抖动。
- **无路由库**：tab 是普通 `useState`，刷新回到对话 tab；会话列表无分页、全量返回。

## 关联

- [realtime](../server/realtime.md)：/ws 帧协议、订阅语义、断线恢复规则（CLI 与 WebUI 的共同契约）
- [http-api](../server/http-api.md)：各视图消费的 REST 路由（含 /fs/browse、/usage、附件上传）
- [run-manager](../server/run-manager.md)：`session.renamed` 的发射方、附件随 send_message 的服务端挂载
- [compaction](../core/compaction.md)：`/compact` 命令与审计页"压缩记录"区块背后的机制
- [memory](../core/memory.md)：记忆管理页背后的记忆塔存储、`memory.written` 事件与 `/memory` 命令的语义（web 端 `/memory` 是提示跳转记忆页的占位，命令元数据在 `@kclaw/core/commands`）
- [daemon](../server/daemon.md)：webDist 解析与静态托管、鉴权豁免的服务端侧
- [onboarding](../cli/onboarding.md)：`kclaw web` 命令与 `?token=` 的发送侧
- [protocol](../core/protocol.md)：事件目录与持久化块结构（model.ts 镜像的源头）
