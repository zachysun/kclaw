# mcp — MCP 客户端管理器

## 职责

`packages/core/src/mcp/manager.ts` 的 `McpManager` 把外部 MCP server 的工具接入 kclaw。MCP（Model Context Protocol，模型上下文协议）是模型调用外部工具的事实标准；一个 MCP server 可以是本地子进程，也可以是一个 HTTP 服务，它对外声明自己提供哪些工具。`McpManager` 按合并读到的 server 配置（两层：全局层与项目层，见下文"配置"）去连接这些 server，把它们声明的工具包装成 kclaw 自己的工具接口（`ToolExecutor`/`ToolDefinition`，见 [tools](./tools.md)）交给 agent 循环使用，连接断开后按指数退避自动重连；配置的增删改和启停也可以在 daemon 运行中通过管理方法热生效。

kclaw 在这个过程中只扮演 MCP **客户端**：它去调用别人的 server，不把自己的工具通过 MCP 暴露出去。

---

## 设计决策

- **配置驱动，零代码接入**：在配置文件里写几行就能接入一个 server，不需要写任何代码。daemon 恒定构建管理器（一个空的管理器没有任何连接，开销为零）——这样"从 WebUI 添加第一个 server"的管理面永远可用。
- **配置管理面独立于手写的配置文件，分全局与项目两层**：WebUI 增删改的配置写进 daemon 主目录的 `mcp.json`（JSON 格式，与常见 MCP 客户端的习惯一致），不动 `config.json` 里的其他内容。配置文件里遗留的 `mcp.servers` 节继续生效（在 `config.json` 里，或在 `config.json` 出现前仍被兼容读取的旧 `config.yaml` 里），并入**全局层**；任何一次对全局层的保存都会把全部 server 归拢进 `mcp.json`，并把该节从磁盘上实际使用的那种布局里移除（yaml 布局做行级编辑，其余内容（包括注释）逐字节保留；json 布局整文件重写）。从不用 WebUI 的用户不受任何影响。项目层配置写进工作区的 `.kclaw/mcp.json`（见下"项目层"），与全局层按名字合并。
- **项目层是"这个工作区专属"的一层**：项目文件里的 server 属于 daemon 的工作区（`config.workspace`，见 [storage](./storage.md)），只对这个工作区生效。两层按名字合并（展开顺序 global < project），同名条目**整体覆盖**（whole-entry override，不做字段级合并）；被覆盖的全局条目仍然保留在全局文件里——persist 是按层整层写入的，丢掉的遮蔽条目会从盘上消失、再也回不来。新增 server 时名字在**两层合并后**必须唯一（占用任一层的名字都拒绝，错误信息会指明占用层）。
- **项目文件 git 跟踪即忽略，首次写入自动 gitignore**：克隆下来的仓库不能自带一份会去连接本地进程的 MCP 配置（与 decided-rules 的防御同动机）。项目文件在 git 里被跟踪时整体忽略并在 daemon 日志告警；首次写入项目文件前自动创建工作区 `.kclaw` 目录、把 `.kclaw/mcp.json` 追加进工作区 `.gitignore`（幂等）。
- **一个 server 失败不影响其他部分**：`start()` 用 `Promise.allSettled` 并发连接所有 server，某个 server 连不上时只记录到它自己的状态和 `lastError` 字段，不会抛异常——所以一个配置坏了的 server 既不会阻断 daemon 启动，也不会影响其他 server。
- **从未连上过的 server 不自动重试**：自动重连循环只对"曾经连上过"的 server 生效（内部用 `hadSession` 标记）。启动时就失败的 server（比如命令拼错、进程起不来）会停在 `"failed"` 状态等人处理，而不是永远在后台空转重试；WebUI 的 MCP 栏提供手动重连按钮（管理方法 `reconnect`），一次点击就是一次连接尝试，不会在背后排进退避循环。
- **热方法换新状态对象**：增删改启停（`addServer`/`updateServer`/`removeServer`/`setEnabled`）都会为该 server 造一个全新的状态对象、把旧对象整体废弃（旧对象上的进行中的连接回调、重连定时器全部短路），保证旧配置的回调永远不会落到新配置的状态上。`reconnect` 是例外——它只是对同一个状态对象取消挂着的退避定时器后发起一次连接，不换对象。
- **每个 run 开始时重新读一遍工具列表**：daemon 交给 RunManager 的是一个函数（`extraTools: () => mcpManager.tools()`），每轮 run 开始时才求值。某个 server 在两轮 run 之间上线或掉线（或被热方法改了配置），下一轮请求立刻反映最新情况，不用重启 daemon。
- **工具名加前缀，避免冲突**：来自 MCP 的工具统一命名为 `mcp__<server>__<tool>`（例如 `mcp__filesystem__read_file`），不同 server 的同名工具、以及与内置工具之间靠前缀天然分开。万一仍与内置工具撞名，适配器的实现覆盖内置的那个，并打一行日志说明。经 API 新增的 server 名字限定为字母、数字、下划线和连字符（名字会进模型可见的工具名）；配置文件里手写的存量名字不做追溯校验。
- **权限与调度一律按最保守处理**：kclaw 看不到外部工具内部做了什么，所以把它们的每个工具都标记为 `"sensitive"`（每次调用都经过权限网关，默认要人工确认）和 `"serial"`（不与其他工具并发执行）——宁可多打扰用户，也不放开。

---

## 配置（全局层 mcp.json + 项目层 .kclaw/mcp.json）

**全局层**的管理面文件是 daemon 主目录下的 `mcp.json`（权限 0600，原子写）：

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

配置文件里的遗留写法继续有效（`config.json` 中的 `mcp.servers` 节，或 `config.json` 出现前旧 `config.yaml` 里的同一节——兼容读取；并入全局层，两处按名字合并，`mcp.json` 里的同名条目优先）：

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem"],
        "env": { "FOO": "bar" }
      }
    }
  }
}
```

**项目层**的文件是工作区根目录下的 `.kclaw/mcp.json`（同样是 `{servers: {...}}` 形状、0600 原子写），只对所在工作区生效：

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

项目文件的读写规则：文件缺失或形状不对读作 `{}`（与全局 `mcp.json` 同一个永不抛错的契约）；被 git 跟踪时整体忽略并告警；首次写入前自动建 `.kclaw` 目录、把 `.kclaw/mcp.json` 追加进工作区 `.gitignore`。项目层的手工编辑会热生效（daemon 监视着这个文件，见"项目层文件热生效"）。

两层合并规则：**展开顺序 global < project**——同名条目项目层整体覆盖全局层（字段级不合并），每个条目在状态快照里带一个 `scope` 字段（`"global"` 或 `"project"`）标明它的生效来源。

两种传输形态对应的字段：

| 形态 | 字段 | 说明 |
|------|------|------|
| `stdio` | `{type, command, args?, env?, enabled?}` | 在本地拉起一个子进程，通过标准输入输出与之通信 |
| `http` | `{type, url, headers?, enabled?}` | 连接一个 streamable HTTP 端点 |

`enabled === false` 的条目停留在 `"disabled"` 状态，永远不会发起连接。读写函数收在 core 的 `storage/mcp-config.ts`：`loadMcpServers`（全局层合并读）、`consolidateMcpConfig`（全局归拢写 + 从磁盘上实际使用的布局移除旧节）、`loadProjectMcpServers` / `saveProjectMcpJson`（项目层的读与写，含 git 跟踪检测与 gitignore 防御）。

---

## 接口

```ts
// packages/core/src/mcp/manager.ts
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

export type McpScope = "global" | "project"

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  scope: McpScope            // 该 server 的生效条目来自哪一层
  state: "connected" | "connecting" | "disabled" | "failed"
  tools: McpToolEntry[]     // { name: "mcp__<server>__<tool>", server, originalName, description }
  lastError?: string
}

export class McpManager {
  constructor(opts: {
    // 两层配置，已由调用方读好（storage 的防御在那里完成）：
    // global = 遗留 mcp.servers 与 ~/.kclaw/mcp.json 合并；project = <workspace>/.kclaw/mcp.json
    servers: { global: Record<string, McpServerConfig>; project?: Record<string, McpServerConfig> }
    transportFactory?(name, cfg): Transport   // 测试注入点：按名字/配置构造传输（默认按 type 用 stdio/http）
    backoffBaseMs?: number        // 默认 1000
    backoffCapMs?: number         // 默认 60_000
    connectTimeoutMs?: number     // 默认 10_000，connect 与 listTools 共用
    onError?(name: string, error: string): void
    persist?(scope: McpScope, servers: Record<string, McpServerConfig>): void
    // persist：热方法改配置后的持久化回调，携带变更的那一层 + 该层完整条目集
    //（含被另一层遮蔽的条目——全局归拢是整文件重写，丢一个遮蔽条目就再也回不来）。
    // daemon 把 global 接到 mcp.json 归拢、project 接到项目文件；manager 本身不管存储。
    // persist 抛错只记日志，不回传——内存里的变更已经生效。
  })
  start(): Promise<void>          // 并发连接全部启用项；失败仅记录、永不抛
  status(): McpServerStatus[]     // 状态快照（GET /mcp 与 kclaw mcp list 的数据源）
  tools(): { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  stop(): Promise<void>           // 幂等：清重连定时器、关全部客户端

  // 热配置方法（改配置立即作用于连接，不需要重启 daemon）：
  addServer(name: string, config: McpServerConfig, layer?: McpScope): void
  // 新增进指定层（缺省 global）；重名（两层中任一占用）/空名抛错，错误指明占用层；后台连接
  updateServer(name: string, config: McpServerConfig): void  // 关闭旧连接，按新配置重连；条目留在它自己的层
  removeServer(name: string): void
  // 断开、清定时器、遗忘；删除的是项目条目且全局层有同名条目时，全局条目立即恢复生效
  setEnabled(name: string, enabled: boolean): void           // 持久启停开关；同值调用不做任何事
  reconnect(name: string): void                              // 手动一次性连接；取消挂着的退避定时器
  reconcile(project: Record<string, McpServerConfig>): void  // 项目文件重读后重排生效集（watch 调用；永不持久化）
  flush(): Promise<void>                                     // 等待全部进行中的连接尝试结束（测试用；路由视图接口预留）
}
```

MCP 协议要求客户端报告自己的名字和版本，这里固定为 `{name: "kclaw", version: <core package.json 版本>}`。

---

## 核心流程

### 连接与重连

1. 构造时两层按名合并（global < project 整体覆盖），每个**生效** server 记为 `"connecting"` 状态（配了 `enabled: false` 则直接记 `"disabled"`），同时各层保留自己的条目副本（被覆盖的全局条目仍留在全局映射里，persist 时整层写回）；`start()` 对启用的 server 并发发起连接。
2. 单次连接有超时限制（默认 10 秒）：建立连接（`client.connect(transport)`）和随后拉取工具清单（`listTools()`）都受同一个计时器约束，超时报 `MCP connect timeout after <n>ms`。
3. 成功后：记下工具清单（每个工具的原名和参数 schema），状态改为 `"connected"`，清空 `lastError`，重连计数归零，并把 `hadSession` 标记为 true。
4. 失败后：关闭这次尝试持有的客户端（哪怕它还没来得及挂到状态对象上——超时的连接其实在后台继续跑，不主动关掉的话，stdio 传输下每个超时的尝试都会漏一个子进程），状态记 `"failed"`、写入 `lastError`、清空工具表。此时**不会**安排自动重试（理由见设计决策"从未连上过的 server 不自动重试"）。
5. 如果一个已经连上的 server 后来断开了（传输意外 close 且 `hadSession` 为 true）：状态回到 `"connecting"`，安排指数退避重连（等待时长为 `min(backoffBaseMs · 2^attempts, backoffCapMs)`，默认从 1 秒起步、封顶 60 秒，每失败一次翻倍；一旦重连成功，计数归零）。退避等待期内用户手动点重连（`reconnect`）会先取消挂着的定时器再发起一次连接，否则自动重试会在手动尝试之后跟着触发，两次并发连接互相踩踏。
6. `stop()` 负责收尾且可重复调用：清除重连定时器、解绑回调、关闭全部客户端。

### 项目层文件热生效（watch + reconcile）

daemon 用 `packages/server/src/project-mcp-watch.ts` 的 `createProjectMcpWatch` 监视工作区的 `.kclaw/mcp.json`，手工编辑不用重启就生效：

- **两阶段挂载**：先监视工作区顶层（非递归，事件量可忽略），等 `.kclaw` 目录出现后切到 `.kclaw` 目录的监视。不在启动时预建 `.kclaw` 目录——那样每个工作区都会被丢一个空目录；项目层第一次写入时 `saveProjectMcpJson` 会先建目录再调 `ensure()` 补挂监视。
- 变更事件防抖 250ms 后触发一次 `reconcile(loadProjectMcpServers(workspace))`；文件用原子写（先写 `.tmp` 再 rename），watcher 只认 `mcp.json` 这个文件名，临时文件不触发。
- **reconcile 以文件为真相，永不持久化**：新出现的项目条目 → 连接它（若全局层有同名条目，先退役旧状态再按项目条目重建，遮蔽生效）；配置变了的项目条目 → 退役重连；消失的项目条目 → 从全局层恢复（配置与全局相同则只翻转 `scope`、连接不动；不同则重连），全局层没有同名条目就直接移除。
- 监视起不来（目录不可监视、出错）只记一行日志并降级：手工编辑改为重启后生效，绝不致命。

### 工具适配（tools()）

- 每个**已连接** server 声明的每个工具都会产出一条适配结果：名字改成带前缀的 `mcp__<server>__<tool>`；参数 schema 直接沿用 server 声明的 `inputSchema`（server 没给就用空对象 schema）；描述缺失时补一句默认的 `MCP tool <tool> from server <server>`。
- 每个工具配一个执行器，风险与并发档位固定为 `"sensitive"` + `"serial"`。执行器内部调用 `client.callTool({name: 原名, arguments})`（传入本次 run 的 abort 信号），把返回内容里的全部 text 片段拼接成输出文本；如果 server 返回 `isError: true` 或调用本身抛出异常，就转成一个普通的错误结果（`{status:"error", output}`）交回给循环——异常不会从执行器里抛出去打断这轮对话。

### daemon、WebUI 与 CLI 在哪里用到它

- daemon（`packages/server/src/daemon.ts`）：恒定构建管理器（配置来自两层合并读，`persist` 回调按层分发——global 接到 `consolidateMcpConfig`（每次保存归拢并移除配置文件遗留节），project 接到 `saveProjectMcpJson`（并补挂项目 watch））；组装时挂上项目文件 watch、随后从内存配置里删掉遗留 `mcp` 节（防止后续 provider 保存把已删 server 写回去）；启动监听之后用 `void mcpManager.start()` 触发连接、不等它完成就开始对外服务，晚连上的 server 从下一轮 run 起可用；停止序列中先关 watch（不遗留挂着的防抖回调）再关管理器。RunManager 把上面提到的 `extraTools` 函数作为依赖传给 core `executeRun`，由后者在每个 run 求值并注入这些工具（见 [run-manager](../server/run-manager.md)）。
- HTTP 接口（见 [http-api](../server/http-api.md)）：`GET /mcp` 返回 `{servers: status()}`（没组装管理器时是空列表；每条带 `scope`）；`POST /mcp/servers`（新增，可选 `layer` 字段 `"global" | "project"`、缺省 global）、`PATCH|DELETE /mcp/servers/:name`（改/删，作用于生效条目、持久化进拥有它的那层文件）、`POST /mcp/servers/:name/enable`（启停）、`POST /mcp/servers/:name/reconnect`（重连）是 WebUI MCP 栏的管理面，任何保存动作都会触发一次对应层的持久化。
- WebUI 顶栏「MCP」页处理快照与管理接口：状态卡片（每条带来源层徽标"全局/项目"）、工具清单展开、启停开关、重连按钮和增删改表单（新建表单可选目标层，编辑不改层）；`/mcp` 斜杠命令显示一句话概况并可点击跳到该页。CLI 会话内 `/mcp` 打印状态一览（每条带来源层标签，`/mcp <名字>` 看某 server 的工具清单），进程级的 `kclaw mcp [list]` 子命令保持不变（同样带来源层标签），两者并存。

---

## 边界与出错

- **掉线的工具从模型面前消失**：`tools()` 只收集处于 `"connected"` 状态的 server。某 server 断线期间，它的工具不会出现在下一轮的工具清单里——模型看不到，也就不会去调一个必然失败的调用；重连成功后这些工具自动回来。
- **工具执行失败是普通错误结果**：MCP 调用抛错或返回 `isError` 都会变成一段错误文本交回给模型，对话照常继续，模型可以据此换一条路走。
- **没有结果缓存或补偿机制**：断线期间不会补拉任何东西；模型此前引用过的工具结果仍是会话历史里的普通文本，不受断线影响。
- **项目层被 git 跟踪的配置不生效**：克隆来的仓库若自带一份 `.kclaw/mcp.json`（在 git 里），这份配置被整体忽略并告警——它会去连接本地进程，仓库不能夹带这种副作用。
- **安全边界与内置工具一致，但多一层信任问题**：外部工具一律按 sensitive 处理，有副作用的调用同样要人工确认；不过 kclaw 无法审计远端 server 自身的行为——接入了什么 server，就等于信任了什么 server。

---

## 关联

- [tools](./tools.md)：`ToolExecutor`/`ToolDefinition` 契约的定义方
- [permissions](./permissions.md)：sensitive 工具如何走向 confirm；项目文件 git 跟踪即忽略的防御同源（decided-rules）
- [run-manager](../server/run-manager.md)：`extraTools` 的每 run 注入现场
- [http-api](../server/http-api.md)：`GET /mcp` 与 `/mcp/servers` 管理路由族
- [storage](./storage.md)：`mcp.json` 与 `.kclaw/mcp.json` 的读写、配置文件遗留节的移除
