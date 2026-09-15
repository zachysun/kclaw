# kclaw

[English](./README.md) | 中文

本地常驻的个人 agent：一个 daemon 掌管全部状态，CLI 与 WebUI 都只是它的客户端。

```
                    127.0.0.1（HTTP + WebSocket，Bearer token 鉴权）
   ┌────────────────────────────────────────────────────────────┐
   │                                                            │
   │  kclaw CLI ──────┐          ┌── WebUI（dist 静态托管）      │
   │                  ▼          ▼                               │
   │           @kclaw/server（daemon，唯一状态权威）              │
   │           ├─ HTTP + WS 路由 · Bearer 鉴权 · 审计            │
   │           ├─ RunManager：send_message → 会话串行队列        │
   │           └─ 调度器 tick：cron job 到点开新会话 + 记忆调度   │
   │                          │                                 │
   │                          ▼                                 │
   │           @kclaw/core（纯库 agent 引擎）                    │
   │           ├─ run 装配：agent 循环、工具、权限               │
   │           ├─ 确认网关：高危工具先确认再执行                 │
   │           ├─ 事件总线：37 种 AgentEvent                    │
   │           └─ 记忆 · 上下文压缩                             │
   │                          │                                 │
   └──────────────────────────┼─────────────────────────────────┘
                              ▼
   ~/.kclaw/  config.json · AGENTS.md · token · daemon.json
              sessions/<id>/events.jsonl（对话真相，唯一权威）
              memory/（markdown 主题线 + 派生 FTS5/向量索引）
              jobs.db · attachments/ · logs/
```

---

## 安装

要求：Node >= 22（CLI 启动时会检查，不满足直接退出）。

kclaw 尚未发布 npm 包，需要从源码构建安装（本地部署）：

```bash
# 1. 克隆仓库
git clone https://github.com/zachysun/kclaw
cd kclaw

# 2. 安装依赖并构建（需要 pnpm）
pnpm install
pnpm build

# 3. 把聚合包从本地目录安装为全局命令
npm i -g ./packages/kclaw

kclaw chat    # 首次运行进入配置向导：选 provider → 粘贴 key → 自动测连通
kclaw web     # 浏览器打开 WebUI（带 token，自动登录）
```

向导内置 DeepSeek / OpenAI / Ollama / 自定义模板，key 输入不回显，测试通过后写入 `~/.kclaw/config.json`（权限 0600）。不走向导时，也可以手动修改配置或使用环境变量，见「配置要点」。

> [!TIP]
> 第一次使用 kclaw？可跟随 [完整上手教程](./docs/tutorial.md)，从安装一直覆盖到定时任务与 WebUI。

> [!NOTE]
> daemon 无需单独启动：`kclaw chat` / `kclaw web` 发现它不在时会自动启动。

---

## 功能一览

- **流式对话**：CLI REPL 与 WebUI 体验一致，回复流式渲染，支持多轮与新建会话（示例：询问「`~/Downloads` 里最大的文件是哪个」会触发 exec 工具）。
- **确认卡片**：高危工具（exec、fs_edit 等）执行前弹确认——四选（仅本次 / 总是·本项目 / 总是·全局 / 拒绝），"总是"两档沉淀为规则文件、可随时在 WebUI「权限」页收回，决策全部写入审计日志。
- **权限模式**：每个会话独立切换只读 / 默认 / 自动编辑 / 信任 / 自动学习五档（CLI Shift+Tab 或 `/mode`、WebUI 常驻选择器）。只读拒绝一切写入；自动编辑免确认工作区内文件写入；信任在沙箱/工作区边界内免确认、边界外一律拒绝；自动学习把反复以「仅本次」放行的操作沉淀为持久规则。
- **会话**：对话以事件流写入 `sessions/<id>/events.jsonl`（会话真相），可随时恢复历史会话。
- **记忆**：每轮结束后自动把新消息提取、按主题沉淀为 markdown 情节线（FTS5 索引为派生物）；之后相关提问命中情节，以 note 形式注入上下文。
- **任务**：cron 定时任务（如 `0 9 * * *` 每日早报），到点 daemon 自动创建新会话执行，结果写入审计。
- **审计**：权限决策全程留痕，WebUI「审计」页可查。

---

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| `command not found: kclaw` | 本地安装那步没做，或 npm 全局 bin 目录不在 PATH——在仓库里执行 `npm i -g ./packages/kclaw`，再用 `npm config get prefix` 查看安装位置 |
| `no llm provider configured` | 模型未配置：执行一次 `kclaw chat` 进入配置向导，或按「配置要点」手动编写 config / 环境变量 |
| 页面打不开 / 401 | daemon 重启后端口可能变化（用 `kclaw daemon status` 查当前端口，或直接 `kclaw web`）；token 不变，无需重新获取 |
| 高危操作没有确认弹框 | 命令命中了 `permissions.allow` 白名单（配置要点见下） |
| 数据在哪 | 全部在 `~/.kclaw/`：config.json · token · daemon.json · sessions/ · memory/ · jobs.db · logs/ |

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `kclaw` / `kclaw chat` | 进入对话 REPL（默认动作） |
| `kclaw chat --session <id>` | 恢复指定会话 |
| `kclaw chat --think` | 显示 thinking 流（默认隐藏） |
| `kclaw web` | 浏览器打开 WebUI（自动带 token；daemon 不在时自动启动） |
| `kclaw daemon start \| stop \| status` | daemon 生命周期（start 幂等，写 `~/.kclaw/daemon.json`；stop 发 SIGTERM） |
| `kclaw status` | `daemon status` 别名 |
| `kclaw jobs list` | 列出定时任务（name/cron/enabled/nextRunAt/lastStatus） |

REPL 内：`/exit` 退出、`/sessions` 列会话、`/new <title>` 新建会话；Ctrl+C 取消当前 run。

---

## WebUI

`packages/web`（React + Vite）是 daemon 的官方前端，构建产物由 daemon 静态托管，功能与 CLI 对等（同一套 HTTP + WS API）：流式对话、确认卡片、会话、任务、审计、记忆、技能。

日常入口只需一条命令：

```bash
kclaw web    # 自动启动 daemon（如需要），带 token 打开浏览器
```

备选（手动 token）：端口见 daemon 启动输出或 `kclaw daemon status`，token 即 `~/.kclaw/token` 的内容。二选一：

1. **URL 带 token**：`http://127.0.0.1:<port>/?token=<token>`
2. **页面输入**：不带 token 打开 `http://127.0.0.1:<port>/`，在 token 输入框粘贴一次，存入 localStorage 后无需重复。

---

## 配置要点（`~/.kclaw/config.json`）

配置向导写入的就是这个文件，手写形式如下：

```json
{
  "providers": {
    "default": "my-provider",
    "entries": {
      "my-provider": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "sk-...",
        "model": "some-model"
      }
    }
  }
}
```

`baseUrl` 可为任意 OpenAI 兼容端点。旧版 `config.yaml`（`config.json` 出现前的配置格式）在 `config.json` 缺席时仍被兼容读取，已有旧配置照常运行；首次程序写入（向导或 WebUI 保存）落在 `config.json`，并把仍在的旧 `config.yaml` 改名为 `config.yaml.bak` 弃用，此后不再读取。

| 字段 | 说明 |
|------|------|
| `providers` | 如上；缺省时也可用 `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` 环境变量（config 优先于 env）。本地 Ollama 兼容：`baseUrl: http://127.0.0.1:11434/v1`、`apiKey: ollama`。 |
| `workspace` | 文件工具（fs_read/fs_edit 等）的沙箱根目录，越界即拒绝。 |
| `permissions.allow / deny` | 规则前缀匹配（如 `exec:git *`）：allow 免确认、deny 直接拒绝、其余弹确认。 |
| `exec.timeoutMs / maxOutputBytes` | exec 工具的超时与输出截断。 |
| `web.tavilyApiKey` | 可选，启用 web_search。 |
| `web.timeoutMs` | web 工具请求超时（默认 20000ms；`web_search`/`web_fetch` 均受约束，挂死的站点不再卡住整个 run）。 |
| `web.allowPrivateNetworks` | 默认 false：`web_fetch` 拒绝解析到私网/loopback 的地址（redirect 每一跳都会检查）；需要抓本机服务（如本机 Ollama）时设 true 放行。 |
| `~/.kclaw/AGENTS.md` | agent 人设，注入系统提示词。 |

`exec:` 规则按归一化命令匹配——空白折叠为单空格、命令取 basename（`/bin/rm` ≡ `rm`）；接续符拆分感知引号（`echo "a;b"` 是一段），deny 匹配在此基础上再加 token 集合覆盖——旗标换序与聚合旗标（`rm -r -f` ≡ `rm -rf`）同样命中黑名单；含接续符（`;` `&&` `||` `|`、换行、命令替换 `$(...)`/反引号）的命令不会命中 allow/会话授权（回退确认）。exec 规则是尽力而为的防线，不是沙箱。

> [!NOTE]
> 数据目录可用 `KCLAW_HOME` 或 `--home <dir>` 重定向（测试友好）。

---

## 开发

上面的「安装」一节已是源码构建（目前唯一的安装路径）；本节面向想直接跑测试或改代码的人。平台：macOS 与 Linux；Windows 未承诺支持。

monorepo（pnpm workspace）：

| 包 | 作用 |
|----|------|
| `packages/core` | agent 引擎，纯库（run 装配 / 循环 / 工具 / 权限 / 记忆） |
| `packages/server` | daemon（HTTP + WS + run 排队 + 调度 + 审计） |
| `packages/cli` | CLI 客户端（源码形态） |
| `packages/web` | WebUI 前端（React + Vite） |
| `packages/kclaw` | 聚合包（打包各包产物，「安装」一节本地安装的就是该包） |

```bash
pnpm install
pnpm build
pnpm typecheck   # 全部包 tsc --noEmit
pnpm test        # 全部包 vitest（cli/server 快速验证需先 pnpm build）
```

文档：

- [architecture — 全局总纲](docs/architecture.md)：模块地图、进程模型、数据流，其余各篇的入口
- core/（agent 引擎，纯库）
  - [agent-loop](docs/core/agent-loop.md) — run 的运行循环
  - [client-http](docs/core/client-http.md) — 共享 HTTP 请求基座（Bearer 鉴权、JSON、错误信封）
  - [compaction](docs/core/compaction.md) — 上下文压缩
  - [hooks](docs/core/hooks.md) — 用户钩子系统
  - [jobs](docs/core/jobs.md) — 定时任务调度
  - [mcp](docs/core/mcp.md) — MCP 客户端接入
  - [memory](docs/core/memory.md) — 记忆系统（markdown 主题线 + FTS5 索引）
  - [permissions](docs/core/permissions.md) — 权限网关
  - [protocol](docs/core/protocol.md) — 消息 / 内容块 / 事件三层协议
  - [provider](docs/core/provider.md) — OpenAI 兼容的 LLM 接入层
  - [sandbox](docs/core/sandbox.md) — exec 的 OS 沙箱（Seatbelt / bubblewrap）
  - [skills](docs/core/skills.md) — 技能机制（渐进披露）
  - [storage](docs/core/storage.md) — 路径、配置与会话持久化
  - [subagents](docs/core/subagents.md) — 子代理委派（子会话、单层委派）
  - [tools](docs/core/tools.md) — 内置工具体系与注册
- server/（daemon）
  - [daemon](docs/server/daemon.md) — 生命周期与鉴权
  - [http-api](docs/server/http-api.md) — HTTP 路由
  - [realtime](docs/server/realtime.md) — WS 协议与事件总线
  - [run-manager](docs/server/run-manager.md) — 会话串行 run、消息队列与确认网关
- cli/（终端客户端）
  - [cli](docs/cli/cli.md) — 命令、REPL 与 slash 命令
  - [onboarding](docs/cli/onboarding.md) — 首次运行体验（provider 判定 / 向导 / web 命令）
- web/（浏览器客户端）
  - [webui](docs/web/webui.md) — 视图、token 引导、WS 客户端
- [extending — 扩展指南](docs/extending.md)：增加新功能时需要修改的位置
- [上手教程](docs/tutorial.md)：新用户从安装到定时任务的完整演练（中文）
