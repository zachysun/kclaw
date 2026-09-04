# mcp — MCP 客户端管理器

## 职责

`packages/core/src/mcp/manager.ts` 的 `McpManager` 把外部 MCP server 的工具接入 kclaw。MCP（Model Context Protocol，模型上下文协议）是模型调用外部工具的事实标准；一个 MCP server 可以是本地子进程，也可以是一个 HTTP 服务，它对外声明自己提供哪些工具。`McpManager` 按 config.yaml 里 `mcp.servers` 的配置去连接这些 server，把它们声明的工具包装成 kclaw 自己的工具接口（`ToolExecutor`/`ToolDefinition`，见 [tools](./tools.md)）交给 agent 循环使用，连接断开后按指数退避自动重连。

kclaw 在这个过程中只扮演 MCP **客户端**：它去调用别人的 server，不把自己的工具通过 MCP 暴露出去。

---

## 设计决策

- **配置驱动，零代码接入**：在 `config.yaml` 的 `mcp.servers` 里写几行配置就能接入一个 server，不需要写任何代码；反过来，`mcp.servers` 为空时 daemon 根本不构建管理器，没有额外开销。
- **一个 server 失败不影响其他部分**：`start()` 用 `Promise.allSettled` 并发连接所有 server，某个 server 连不上时只记录到它自己的状态和 `lastError` 字段，不会抛异常——所以一个配置坏了的 server 既不会阻断 daemon 启动，也不会影响其他 server。
- **从未连上过的 server 不自动重试**：重连循环只对"曾经连上过"的 server 生效（内部用 `hadSession` 标记）。启动时就失败的 server（比如命令拼错、进程起不来）会停在 `"failed"` 状态等人修配置，而不是永远在后台空转重试；只有连接成功过、之后传输中断的 server 才进入退避重连。
- **每个 run 开始时重新读一遍工具列表**：daemon 交给 RunManager 的不是一份静态工具表，而是一个函数（`extraTools: () => mcpManager.tools()`），每轮 run 开始时才求值。某个 server 在两轮 run 之间上线或掉线，下一轮请求立刻反映最新情况，不用重启 daemon。
- **工具名加前缀，避免冲突**：来自 MCP 的工具统一命名为 `mcp__<server>__<tool>`（例如 `mcp__filesystem__read_file`），不同 server 的同名工具、以及与内置工具之间靠前缀天然分开。万一仍与内置工具撞名，适配器的实现覆盖内置的那个，并打一行日志说明。
- **权限与调度一律按最保守处理**：kclaw 看不到外部工具内部做了什么，所以把它们的每个工具都标记为 `"sensitive"`（每次调用都经过权限网关，默认要人工确认）和 `"serial"`（不与其他工具并发执行）——宁可多打扰用户，也不放开。

---

## 配置（config.yaml 的 mcp.servers）

```yaml
mcp:
  servers:
    filesystem:                      # 名字任取，用于工具前缀 mcp__filesystem__* 和日志
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", /tmp]
      env: {FOO: bar}                # 可选；enabled: false 表示保留配置但不连接
    remote:
      type: http                     # streamable HTTP 传输
      url: https://example.com/mcp
      headers: {Authorization: "Bearer …"}
```

两种传输形态对应的字段：

| 形态 | 字段 | 说明 |
|------|------|------|
| `stdio` | `{type, command, args?, env?, enabled?}` | 在本地拉起一个子进程，通过标准输入输出与之通信 |
| `http` | `{type, url, headers?, enabled?}` | 连接一个 streamable HTTP 端点 |

`enabled === false` 的条目停留在 `"disabled"` 状态，永远不会发起连接。

---

## 接口

```ts
// packages/core/src/mcp/manager.ts
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  state: "connected" | "connecting" | "disabled" | "failed"
  tools: McpToolEntry[]     // { name: "mcp__<server>__<tool>", server, originalName, description }
  lastError?: string
}

export class McpManager {
  constructor(opts: {
    servers: Record<string, McpServerConfig>
    backoffBaseMs?: number        // 默认 1000
    backoffCapMs?: number         // 默认 60_000
    connectTimeoutMs?: number     // 默认 10_000，connect 与 listTools 共用
    onError?(name: string, error: string): void
  })
  start(): Promise<void>          // 并发连接全部启用项；失败仅记录、永不抛
  status(): McpServerStatus[]     // 状态快照（GET /mcp 与 kclaw mcp list 的数据源）
  tools(): { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  stop(): Promise<void>           // 幂等：清重连定时器、关全部客户端
}
```

MCP 协议要求客户端报告自己的名字和版本，这里固定为 `{name: "kclaw", version: <core package.json 版本>}`。

---

## 核心流程

### 连接与重连

1. 构造时每个 server 记为 `"connecting"` 状态（配了 `enabled: false` 则直接记 `"disabled"`）；`start()` 对启用的 server 并发发起连接。
2. 单次连接有超时限制（默认 10 秒）：建立连接（`client.connect(transport)`）和随后拉取工具清单（`listTools()`）都受同一个计时器约束，超时报 `MCP connect timeout after <n>ms`。
3. 成功后：记下工具清单（每个工具的原名和参数 schema），状态改为 `"connected"`，清空 `lastError`，重连计数归零，并把 `hadSession` 标记为 true。
4. 失败后：关闭还没建立完全的客户端，状态记 `"failed"`、写入 `lastError`、清空工具表。此时**不会**安排自动重试（理由见设计决策第三条）。
5. 如果一个已经连上的 server 后来断开了（传输意外 close 且 `hadSession` 为 true）：状态回到 `"connecting"`，安排指数退避重连——等待时长为 `min(backoffBaseMs · 2^attempts, backoffCapMs)`，默认从 1 秒起步、封顶 60 秒，每失败一次翻倍；一旦重连成功，计数归零。
6. `stop()` 负责收尾且可重复调用：清除重连定时器、解绑回调、关闭全部客户端。

### 工具适配（tools()）

- 每个**已连接** server 声明的每个工具都会产出一条适配结果：名字改成带前缀的 `mcp__<server>__<tool>`；参数 schema 直接沿用 server 声明的 `inputSchema`（server 没给就用空对象 schema）；描述缺失时补一句默认的 `MCP tool <tool> from server <server>`。
- 每个工具配一个执行器，风险与并发档位固定为 `"sensitive"` + `"serial"`。执行器内部调用 `client.callTool({name: 原名, arguments})`（传入本次 run 的 abort 信号），把返回内容里的全部 text 片段拼接成输出文本；如果 server 返回 `isError: true` 或调用本身抛出异常，就转成一个普通的错误结果（`{status:"error", output}`）交回给循环——异常不会从执行器里抛出去打断这轮对话。

### daemon 与 CLI 在哪里用到它

- daemon（`packages/server/src/daemon.ts`）：`mcp.servers` 非空才构建管理器；启动监听之后用 `void mcpManager.start()` 触发连接、不等它完成就开始对外服务，晚连上的 server 从下一轮 run 起可用；停止序列中有一站负责关闭管理器。RunManager 把上面提到的 `extraTools` 函数作为依赖传给 core `executeRun`，由后者在每个 run 求值并注入这些工具（见 [run-manager](../server/run-manager.md)）。
- HTTP 接口 `GET /mcp` 返回 `{servers: status()}`（没装配管理器时是空列表）；CLI 命令 `kclaw mcp [list]` 把快照逐行打印成 `<名字> <状态> <N> 个工具[ 错误: …]`（见 [cli](../cli/cli.md)）。

---

## 边界与出错

- **掉线的工具从模型面前消失**：`tools()` 只收集处于 `"connected"` 状态的 server。某 server 断线期间，它的工具不会出现在下一轮的工具清单里——模型看不到，也就不会去调一个必然失败的调用；重连成功后这些工具自动回来。
- **工具执行失败是普通错误结果**：MCP 调用抛错或返回 `isError` 都会变成一段错误文本交回给模型，对话照常继续，模型可以据此换一条路走。
- **没有结果缓存或补偿机制**：断线期间不会补拉任何东西；模型此前引用过的工具结果仍是会话历史里的普通文本，不受断线影响。
- **安全边界与内置工具一致，但多一层信任问题**：外部工具一律按 sensitive 处理，有副作用的调用同样要人工确认；不过 kclaw 无法审计远端 server 自身的行为——接入了什么 server，就等于信任了什么 server。

---

## 关联

- [tools](./tools.md)：`ToolExecutor`/`ToolDefinition` 契约的定义方
- [permissions](./permissions.md)：sensitive 工具如何走向 confirm
- [run-manager](../server/run-manager.md)：`extraTools` 的每 run 注入现场
- [http-api](../server/http-api.md)：`GET /mcp` 路由
