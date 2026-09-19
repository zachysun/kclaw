# kclaw

[English](./README.md) | 中文

个人AI助手，基于其他Harness Agent的使用体验及本人使用需求持续迭代。

---

## 安装

环境需求：Node >= 22

本地部署方案：

```bash
# 1. 克隆仓库
git clone https://github.com/zachysun/kclaw
cd kclaw

# 2. 安装依赖并构建
pnpm install
pnpm build

# 3. 把聚合包从本地目录安装为全局命令
npm i -g ./packages/kclaw

# web ui（推荐）
kclaw web  
# cli（待完善）
kclaw chat       
```

> [!TIP]
> [完整上手教程](./docs/tutorial.md)

> [!NOTE]
> daemon无需单独启动：`kclaw chat` / `kclaw web` 发现它不在时会自动启动。

---

## 特性

- **流式输出**：LLM 通过 SSE 流式返回，Text delta 经 WebSocket 实时转发至前端逐字渲染，CLI 同理打印。
- **事件持久化与全程审计**：工具调用及参数、权限判定、上下文注入、检索到的记忆等全部作为事件追加持久化，审计页即为事件流的时间线视图。
- **上下文压缩**：根据上下文占用比例设置4个阈值：超过70%把旧工具输出替换为省略占位，超过75%时后台提前压缩摘要备用，超过80%，则在一次 run 结束时压缩，超过90%，在一次 run 执行过程中，llm 一次 step 调用后的间隙强制压缩。压缩由 LLM 把旧消息汇总成一条摘要置于开头，最近的消息原样保留。
- **三层记忆**：L0 为原始对话，留在会话事件流；L1 为项目情节，主要由 LLM 在每次 run 结束后从新消息提取，按主题归档进该项目的 topic 文件；L2 为全局认知，主要在 topic 不再活跃后由 LLM 归纳成 `persona` / `wiki` / `rule`. L2 常驻上下文，L1 按需检索。
- **技能与工具**：内置 22 个工具，覆盖读写编辑文件（`fs_read` / `fs_write` / `fs_edit`）、Bash执行命令（`exec`）、联网搜索与抓取（`web_search` / `web_fetch`）、记忆与团队调度等；技能支持直接复用 Claude Code 等现有 agent 已装的 skill.
- **权限与沙箱**：共5种权限模式：readonly（写与命令全拒）、default（逐次审批）、acceptEdits（允许在工作区内写文件）、trusted（沙箱与工作区内无须确认）、auto（根据用户的多次审批行为判断，当前基于规则）。审批可选“仅此一次” / “本项目” / “全局”通过，下次同类操作自动放行。
- **Subagent**：两种类型：(1) 阻塞式挂起，lead agent 需等待；(2) 后台执行，期间 lead agent 可以执行其他任务，当subagent 完成任务后会通知lead agent. Subagent是独立会话，继承 lead agent 的工作目录，使用精简的系统提示词，只拿任务描述、不带 lead agent 的消息历史。
- **Agent Team**：lead 与 teammates 各自是独立会话，通过 mailbox 进行点对点通信，支持任务看板。
- **IM Channel**：当前支持接入飞书Bot.

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `kclaw` / `kclaw chat` | 进入对话 |
| `kclaw chat --session <id>` | 恢复指定会话 |
| `kclaw chat --think` | 显示 thinking 流（默认隐藏） |
| `kclaw web` | 浏览器打开 WebUI |
| `kclaw daemon start \| stop \| status` | daemon 生命周期 |
| `kclaw status` | `daemon status` 别名 |
| `kclaw jobs list` | 列出定时任务 |

CLI 内：`/exit` 退出、`/sessions` 列会话、`/new <title>` 新建会话；Ctrl+C 取消当前 run。

---

## 开发

monorepo（pnpm workspace）：

| 包 | 作用 |
|----|------|
| `packages/core` | agent 引擎，核心库（ Loop / 工具 / 权限 / 记忆） |
| `packages/server` | daemon（HTTP + WS + 队列 + 调度 + 审计） |
| `packages/cli` | CLI 客户端 |
| `packages/web` | WebUI 前端（React + Vite） |
| `packages/kclaw` | 聚合包 |

```bash
pnpm install
pnpm build
pnpm typecheck   # 全部包 tsc --noEmit
pnpm test        # 全部包 vitest（cli/server 快速验证需先 pnpm build）
```

## 文档

- [architecture](docs/architecture.md)：整体架构
- core/
  - [agent-loop](docs/core/agent-loop.md)：Agent Loop
  - [agent-team](docs/core/agent-team.md)：Agent Team（Lead + Teammates、Mailbox、Task Board）
  - [client-http](docs/core/client-http.md)：共享 HTTP 请求底座
  - [compaction](docs/core/compaction.md)：上下文压缩
  - [hooks](docs/core/hooks.md)：Hooks
  - [jobs](docs/core/jobs.md)：定时任务调度
  - [mcp](docs/core/mcp.md)：MCP 接入
  - [memory](docs/core/memory.md)：三层记忆机制
  - [permissions](docs/core/permissions.md)：权限、用户审批
  - [protocol](docs/core/protocol.md)：消息 / 内容块 / 事件三层内部协议（数据模型）
  - [provider](docs/core/provider.md)：OpenAI 兼容的 LLM 接入层
  - [sandbox](docs/core/sandbox.md)：沙箱
  - [skills](docs/core/skills.md)：Skills
  - [storage](docs/core/storage.md)：持久化机制
  - [subagents](docs/core/subagents.md)：Subagent机制
  - [tools](docs/core/tools.md)：内置工具与注册方案
- server/（daemon）
  - [daemon](docs/server/daemon.md)：生命周期与鉴权
  - [http-api](docs/server/http-api.md)：HTTP 路由
  - [realtime](docs/server/realtime.md)：WS 协议与事件总线
  - [run-manager](docs/server/run-manager.md)：会话串行、消息队列与确认网关
- cli/（终端客户端）
  - [cli](docs/cli/cli.md)：命令、REPL 与 slash 命令
  - [onboarding](docs/cli/onboarding.md)：首次运行体验
- web/（浏览器客户端）
  - [webui](docs/web/webui.md)：Web UI
- [extending](docs/extending.md)：新功能扩展指南
- [tutorial](docs/tutorial.md)：详细上手教程
