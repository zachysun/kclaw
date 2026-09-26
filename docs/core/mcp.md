# mcp — MCP 客户端管理器

## 职责

`packages/core/src/mcp/` 的 `McpManager` 把外部 MCP server 的工具接入 kclaw。MCP（Model Context Protocol，模型上下文协议）是模型调用外部工具的事实标准；一个 MCP server 可以是本地子进程，也可以是一个 HTTP 服务，它对外声明自己提供哪些工具。`McpManager` 维护"全局 + 每个项目"的分组配置（见下文"配置"），把这些 server 声明的工具包装成 kclaw 自己的工具接口（`ToolExecutor`/`ToolDefinition`，见 [tools](./tools.md)）交给 agent 循环使用；连接是惰性的——daemon 平时一条不连，项目的会话开始干活时才建立，空闲一段时间自动回收。

kclaw 在这个过程中只扮演 MCP **客户端**：它去调用别人的 server，不把自己的工具通过 MCP 暴露出去。

---

## 设计决策

- **配置驱动，零代码接入**：在配置文件里写几行就能接入一个 server，不需要写任何代码。daemon 恒定构建管理器（一个空的管理器没有任何连接，开销为零）——这样"从 WebUI 添加第一个 server"的管理入口永远可用。
- **每个项目（工作目录）各有自己的 MCP 层**：组（group）是条目归属与连接归属的统一键——`"global"`（全局组，跨项目共享）或一个工作目录路径（项目组，文件为该目录下的 `.kclaw/mcp.json`）。不同项目可以有同名的 server，互不干扰；与侧栏分组、记忆、权限规则同一个领域身份（原始工作目录，不做 git 根归一化）。
- **取用视图按项目合并**：某项目一轮 run 看到的工具 = 全局组条目 + 该项目组条目的并集，同名时**项目组整体覆盖**（whole-entry override，字段级不合并）。遮蔽只发生在取用视图——两层各连各的连接，被遮蔽的全局条目在其他项目照常可用；项目组里一个 `enabled: false` 的同名条目会在该项目屏蔽全局条目（既不用项目配置，也不用全局的）。
- **连接惰性**：daemon 启动时一条不连。每轮 run 装配时求值 `toolsFor(workdir)`：视图里缺失的连接在后台建立（工具从下一轮 run 起可用），已连接的直接贡献工具；同一个项目连续干活复用同一条连接，没有重复握手。从未被任何项目取用的条目保持 `"disconnected"` 状态。
- **空闲回收**：每条连接记最近使用时间（取用与每次工具调用都会刷新），后台周期扫描（60 秒）断开空闲超过 TTL（10 分钟）的连接——不干活时不留活进程。回收后的条目回到 `"disconnected"`，下次取用自动重连。
- **有界重试**：连接失败后按指数退避自动重试（默认 1 秒起步、封顶 60 秒），最多 10 次，耗尽停在 `"failed"` 等人处理；一次取用或一次手动连接会把计数归零重来。手动连接（管理方法 `connect`）本身是一次性尝试，背后不排退避循环。
- **活连接有总量上限**（64）：新建连接前活连接数（connecting + connected）已达上限时，后台路径把失败记到条目状态上（`"failed"` + 提示），手动连接直接报冲突——不自动踢掉旧连接。
- **配置管理独立于手写的配置文件**：WebUI 增删改的配置写进 daemon 主目录的 `mcp.json`（JSON 格式，与常见 MCP 客户端的习惯一致），不动 `config.json`。项目组配置写进对应目录的 `.kclaw/mcp.json`。持久化按组分发：全局组整层写 `mcp.json`，项目组整层写该项目文件（persist 回调携带组 id 与该组完整条目集；抛错只记日志，不回传——内存里的变更已经生效）。
- **项目文件 git 跟踪即忽略，首次写入自动 gitignore**：克隆下来的仓库不能自带一份会去连接本地进程的 MCP 配置（与 decided-rules 的防御同动机）。项目文件在 git 里被跟踪时整体忽略并在 daemon 日志告警；首次写入项目文件前自动创建该目录的 `.kclaw` 目录、把 `.kclaw/mcp.json` 追加进工作区 `.gitignore`（幂等）。
- **项目发现不靠清单**：daemon 管理的项目 = 会话记录（含回收站软删会话）里出现过的全部工作目录 + daemon 自己的工作区。启动时对会话记录现算并集、逐目录挂文件监听；新会话落在新目录时（`session.created` 事件携带 workdir）立即挂载；会话被永久清理且项目再无会话时项目组自然退出（文件保留，目录再来会话自动回来）。不扫描文件系统、不持久化任何清单（`packages/server/src/mcp-projects.ts`）。
- **热方法换新状态对象**：增删改启停与换组（`addServer`/`updateServer`/`removeServer`/`setEnabled`）都会为该条目造一个全新的状态对象、把旧对象整体废弃（旧对象上的进行中的连接回调、重连定时器全部短路），保证旧配置的回调永远不会落到新配置的状态上。两个例外：`connect` 只是对同一个状态对象取消挂着的退避定时器后发起一次连接，不换对象；`updateServer` 同组且配置一字未改时是无操作（活连接原样保留，与对账跳过 deep-equal 条目同一语义）。
- **每个 run 开始时重新求值工具视图**：daemon 交给 RunManager 的是一个函数（`extraTools: (workdir) => mcpManager.toolsFor(workdir)`），每轮 run 开始时才求值，且入参是该会话的工作目录。某个 server 在两轮 run 之间上线或掉线（或被热方法改了配置），下一轮请求立刻反映最新情况，不用重启 daemon。
- **工具名加前缀，避免冲突**：来自 MCP 的工具统一命名为 `mcp__<server>__<tool>`（例如 `mcp__filesystem__read_file`）。同一项目的视图内名字唯一（同名已被遮蔽规则消解）；不同项目可以有同名 server——它们出现在不同项目的工具面里，互不见面。与内置工具撞名时，适配器的实现覆盖内置的那个，并打一行日志说明。经 API 新增的 server 名字限定为字母、数字、下划线和连字符（名字会进模型可见的工具名）。
- **权限与调度一律按最保守处理**：kclaw 看不到外部工具内部做了什么，所以把它们的每个工具都标记为 `"sensitive"`（每次调用都经过权限网关，默认要人工确认）和 `"serial"`（不与其他工具并发执行）——宁可多打扰用户，也不放开。

---

## 配置（全局组 mcp.json + 每项目 .kclaw/mcp.json）

**全局组**的配置文件是 daemon 主目录下的 `mcp.json`（权限 0600，原子写）：

```json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": { "FOO": "bar" },
      "enabled": true
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

**项目组**的文件是各项目根目录下的 `.kclaw/mcp.json`（同样是 `{servers: {...}}` 形状、0600 原子写），只对该项目的会话生效：

```json
{
  "servers": {
    "fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  }
}
```

项目文件的读写规则：文件缺失或形状不对读作 `{}`（与全局 `mcp.json` 同一个永不抛错的契约）；被 git 跟踪时整体忽略并告警；首次写入前自动建 `.kclaw` 目录、把 `.kclaw/mcp.json` 追加进工作区 `.gitignore`。项目文件的手工编辑会热生效（daemon 监视着这个文件，见"项目文件热生效"）。

两种传输形态对应的字段：

| 形态 | 字段 | 说明 |
|------|------|------|
| `stdio` | `{type, command, args?, env?, enabled?}` | 在本地拉起一个子进程，通过标准输入输出与之通信 |
| `http` | `{type, url, headers?, enabled?}` | 连接一个 streamable HTTP 端点 |

`enabled === false` 的条目停留在 `"disabled"` 状态，永远不会发起连接（但仍会按遮蔽规则挡住全局同名条目）。读写函数收在 core 的 `storage/mcp-config.ts`：`loadMcpJson` / `saveMcpJson`（全局组 `mcp.json` 的读与写）、`loadProjectMcpServers` / `saveProjectMcpJson`（项目组的读与写，按目录复用，含 git 跟踪检测与 gitignore 防御）。

---

## 接口

```ts
// packages/core/src/mcp/types.ts
export const GLOBAL_GROUP = "global"
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  group: string             // 归属组："global" 或项目工作目录
  state: "connected" | "connecting" | "disconnected" | "disabled" | "failed"
  tools: McpToolEntry[]     // { name: "mcp__<server>__<tool>", server, originalName, description }
  lastError?: string
}

export interface McpSnapshot {
  groups: Array<{ id: string; servers: McpServerStatus[] }>  // global 在前，项目按路径排序
}

// packages/core/src/mcp/manager.ts
export class McpManager {
  constructor(opts: {
    globalServers: Record<string, McpServerConfig>            // 全局组条目（调用方已读好，storage 防御在那里）
    projects?: Record<string, Record<string, McpServerConfig>> // 初始项目组：工作目录 → 条目
    transportFactory?(name, cfg): Transport   // 测试注入点：按名字/配置构造传输（默认按 type 用 stdio/http）
    backoffBaseMs?: number        // 默认 1000
    backoffCapMs?: number         // 默认 60_000
    connectTimeoutMs?: number     // 默认 10_000，connect 与 listTools 共用
    idleTtlMs?: number            // 默认 600_000，空闲回收阈值
    sweepIntervalMs?: number      // 默认 60_000，后台扫描周期
    maxConnections?: number       // 默认 64，活连接上限
    maxReconnectAttempts?: number // 默认 10，退避重试上限
    onError?(group: string, name: string, error: string): void
    persist?(group: string, servers: Record<string, McpServerConfig>): void
    // persist：热方法改配置后的持久化回调，携带变更的组 + 该组完整条目集。
    // daemon 把 "global" 接到全局 mcp.json、工作目录接到该项目文件；manager 本身不管存储。
  })
  start(): void                   // 只启动空闲回收扫描；惰性模型下不连任何 server
  sweep(now?): void               // 单次空闲回收（扫描定时器的函数体；测试可直接调）
  status(): McpSnapshot           // 分组状态快照（GET /mcp 与 kclaw mcp list 的数据源）
  toolsFor(workdir: string): { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  stop(): Promise<void>           // 幂等：停扫描、关全部客户端

  // 项目发现（daemon 驱动；manager 自己不扫描文件系统）：
  ensureProject(workdir, entries): void            // 挂载一个项目组（幂等）
  dropProject(workdir): Promise<void>              // 退出一个项目组：断开其连接、移除条目
  reconcileProject(workdir, entries): void         // 项目文件重读后对账（watch 调用；永不持久化）

  // 热配置方法（全部显式携带组；改配置立即生效，不需要重启 daemon）：
  addServer(group, name, config): void             // 新增进指定组；组内重名/空名抛错；后台连接
  updateServer(group, name, config, toGroup?): void
  // 原地更新；toGroup 与 group 不同即为原子换组：源组除名、目标组写入、
  // 目标同名拒绝（任何变更前先拒绝）、两个组的文件都持久化。配置有变化时
  // 后台重连，纯换组保持惰性（下轮取用按新组连接）。
  removeServer(group, name): void                  // 断开、清定时器、遗忘
  setEnabled(group, name, enabled): void           // 持久启停开关；同值调用不做任何事
  connect(group, name): void                       // 手动一次性连接（探测）；拒绝 disabled、
                                                   // 已连接/连接中幂等、触上限报冲突
  flush(): Promise<void>                           // 等待全部进行中的连接尝试结束（测试用）
}
```

MCP 协议要求客户端报告自己的名字和版本，这里固定为 `{name: "kclaw", version: <core package.json 版本>}`。

---

## 核心流程

### 惰性连接、重试与回收

1. 构造与 `start()` 都不建立连接；`start()` 只启动空闲回收扫描（默认 60 秒一次）。
2. 每轮 run 装配时 `toolsFor(workdir)` 对视图内每个条目：无状态对象或缺连接 → 后台建立（状态 `"connecting"`），已连接的直接贡献工具。首次取用当轮未必有工具——连接是后台的，工具从下一轮装配起可用。
3. 单次连接有超时限制（默认 10 秒）：建立连接（`client.connect(transport)`）和随后拉取工具清单（`listTools()`）都受同一个计时器约束，超时报 `MCP connect timeout after <n>ms`。
4. 成功后：记下工具清单（每个工具的原名和参数 schema），状态改为 `"connected"`，清空 `lastError`，重连计数归零，刷新最近使用时间。
5. 失败后：关闭这次尝试持有的客户端（哪怕它还没来得及挂到状态对象上——超时的连接其实在后台继续跑，不主动关掉的话，stdio 传输下每个超时的尝试都会漏一个子进程），状态记 `"failed"`、写入 `lastError`、清空工具表，并安排退避重试：等待时长 `min(backoffBaseMs · 2^attempts, backoffCapMs)`（默认 1 秒起步、封顶 60 秒），最多 `maxReconnectAttempts` 次（默认 10），耗尽停在 `"failed"`、错误信息标注已到上限；下一次取用或手动连接会归零计数重来。
6. 已连接的 server 意外断开（传输 close 且曾连上过）：状态回到 `"connecting"`，同样进入有界退避。从未连上过的 server 传输 close 只维持 `"failed"`（初次的连接失败已经记录过，重试只会永远空转）。
7. 退避等待期内手动连接（`connect`）先取消挂着的定时器再发起一次连接，否则自动重试会在手动尝试之后跟着触发，两次并发连接互相踩踏。
8. 空闲回收：扫描时把空闲 ≥ TTL（默认 10 分钟）的已连接条目断开、回到 `"disconnected"`；连接中的与 failed 的不动。最近使用时间由取用和每次工具调用刷新，干活中的连接不会被回收。
9. 活连接上限：新建连接前活连接数（connecting + connected）≥ `maxConnections`（默认 64）时，后台路径把条目记为 `"failed"`（错误信息说明触顶），手动连接抛冲突；不自动踢旧连接。
10. `stop()` 负责收尾且可重复调用：停扫描、清除重连定时器、解绑回调、关闭全部客户端。

### 项目发现与文件热生效（mcp-projects + watch + reconcile）

daemon 用 `packages/server/src/mcp-projects.ts` 的 `createMcpProjects` 管理项目集合：启动时对会话记录（含软删）的工作目录并集（外加 daemon 工作区）逐目录挂载；新会话的 `session.created` 事件带着新 workdir 时立即挂载；周期对账把没有任何会话的项目退出管理。每个项目各挂一个 `packages/server/src/project-mcp-watch.ts` 的两阶段文件监视：

- **两阶段挂载**：先监视项目顶层（非递归，事件量可忽略），等 `.kclaw` 目录出现后切到 `.kclaw` 目录的监视。不在启动时预建 `.kclaw` 目录——那样每个项目都会被丢一个空目录；项目文件第一次写入（`saveProjectMcpJson`）会先建目录，随后外层监视捕捉到 `.kclaw` 出现并切入内层。
- 变更事件防抖 250ms 后触发一次 `reconcileProject(workdir, loadProjectMcpServers(workdir))`；文件用原子写（先写 `.tmp` 再 rename），watcher 只认 `mcp.json` 这个文件名，临时文件不触发。
- **reconcile 以文件为准，永不持久化**，且符合惰性语义：新出现或配置变化的条目只更新映射，有活连接的先断开、下轮取用按新配置重连（不自动重连）；消失的条目移除映射并断开其连接。全局组不受文件对账影响。
- 监视起不来（目录不可监视、出错）只记一行日志并降级：手工编辑改为重启后生效，绝不致命。

### 工具适配（toolsFor）

- 取用视图 = 全局组条目 + 该项目组条目（同名项目组整体覆盖）。视图内每个**已连接**条目声明的每个工具产出一条适配结果：名字改成带前缀的 `mcp__<server>__<tool>`；参数 schema 直接沿用 server 声明的 `inputSchema`（server 没给就用空对象 schema）；描述缺失时补一句默认的 `MCP tool <tool> from server <server>`。
- 每个工具配一个执行器，风险与并发档位固定为 `"sensitive"` + `"serial"`。执行器在调用时**现取当前连接**（对账换组导致的状态对象替换不会把调用写进死客户端），并刷新该连接的最近使用时间；内部调用 `client.callTool({name: 原名, arguments})`（传入本次 run 的 abort 信号），把返回内容里的全部 text 片段拼接成输出文本。连接已不在时返回一条说明性的错误结果；server 返回 `isError: true` 或调用抛异常同样转成普通错误结果（`{status:"error", output}`）交回给循环——异常不会从执行器里抛出去打断这轮对话。

### daemon、WebUI 与 CLI 在哪里用到它

- daemon（`packages/server/src/daemon.ts`）：恒定构建管理器（初始项目组来自会话记录并集，`persist` 回调按组分发——`"global"` 接到 `saveMcpJson`，工作目录接到 `saveProjectMcpJson`）；`createMcpProjects` 负责发现与每目录文件监视；启动监听之后 `void mcpManager.start()` 只启动扫描（不连任何 server）。RunManager 把 `extraTools(workdir)` 函数作为依赖传给 core `executeRun`，由后者以会话工作目录求值并注入工具（见 [run-manager](../server/run-manager.md)）。停止序列中先关全部监视（不遗留挂着的防抖回调）再关管理器。
- HTTP 接口（见 [http-api](../server/http-api.md)）：`GET /mcp` 返回分组快照 `{groups: [...], mainWorkspace}`（没组装管理器时是空组列表）；`POST /mcp/servers`（新增，`group` 必填）、`PATCH /mcp/servers/:name`（改/换组，`group` 必填、可选 `toGroup` 即原子换组）、`DELETE /mcp/servers/:name?group=`、`POST /mcp/servers/:name/enable`、`POST /mcp/servers/:name/connect`（手动连接探测）是 WebUI MCP 页的管理动作，任何保存动作都会触发一次对应组的持久化。缺组/组形状不对是 400，未知组是 404。
- WebUI 顶栏「MCP」页按组渲染快照：全局组在前、每个项目组一节（可折叠），条目卡片带连接状态徽标与最近错误；`"未连接"`/`"failed"` 的条目提供手动连接按钮；添加表单的目标是"全局/目录"下拉（默认当前选中会话的工作目录，无选中退回 daemon 主工作区）；编辑表单可改目标组，变更即走原子换组。CLI 会话内 `/mcp` 按组打印状态一览（`/mcp <名字>` 看某 server 的工具清单，跨组同名会带项目路径区分），进程级的 `kclaw mcp [list]` 子命令同样按组输出，两者并存。

---

## 边界与出错

- **掉线的工具从模型面前消失**：`toolsFor` 只收集处于 `"connected"` 状态的连接。某 server 断线期间，它的工具不会出现在下一轮的工具清单里——模型看不到，也就不会去调一个必然失败的调用；重连成功后这些工具自动回来。
- **工具执行失败是普通错误结果**：MCP 调用抛错、返回 `isError`、或连接已被回收都会变成一段错误文本交回给模型，对话照常继续，模型可以据此换一条路走。
- **没有结果缓存或补偿机制**：断线期间不会补拉任何东西；模型此前引用过的工具结果仍是会话历史里的普通文本，不受断线影响。
- **项目的 .kclaw/mcp.json 被 git 跟踪时不生效**：克隆来的仓库若自带一份 `.kclaw/mcp.json`（在 git 里），这份配置被整体忽略并告警——它会去连接本地进程，仓库不能夹带这种副作用。
- **全局配置不进审计与总线**：MCP 配置与连接状态变化不广播事件流（与全局配置类管理面同判），前端靠 2 秒可见轮询拿到最新快照。
- **安全边界与内置工具一致，但多一层信任问题**：外部工具一律按 sensitive 处理，有副作用的调用同样要人工确认；不过 kclaw 无法审计远端 server 自身的行为——接入了什么 server，就等于信任了什么 server。跨项目共享的只有全局组的连接（同一 daemon、同一用户），项目条目各连各的，配置互不可见。

---

## 关联

- [tools](./tools.md)：`ToolExecutor`/`ToolDefinition` 契约的定义方
- [permissions](./permissions.md)：sensitive 工具如何走向 confirm；项目文件 git 跟踪即忽略的防御同源（decided-rules）
- [run-manager](../server/run-manager.md)：`extraTools` 的每 run 注入现场
- [http-api](../server/http-api.md)：`GET /mcp` 与 `/mcp/servers` 管理路由族
- [storage](./storage.md)：`mcp.json` 与 `.kclaw/mcp.json` 的读写
