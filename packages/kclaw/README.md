# kclaw

本地常驻的个人 agent：一个 daemon 掌管全部状态，CLI 与 WebUI 都只是它的客户端。

## 安装

要求 Node >= 22（CLI 启动时会检查，不满足直接退出）。

```bash
npm i -g kclaw
```

## 快速上手

```bash
kclaw chat    # 第一次跑会进入配置向导：选 provider → 贴 key → 自动测连通
kclaw web     # 浏览器打开 WebUI（带 token，自动登录）
```

向导内置 DeepSeek / OpenAI / Ollama / 自定义模板，key 输入不回显，测通后写入 `~/.kclaw/config.yaml`（权限 0600）。daemon 不用单独起：`kclaw chat` / `kclaw web` 发现它不在会自动启动。

## 功能一览

- **对话**：CLI REPL 与 WebUI 同款体验，回复流式渲染，支持多轮与新建会话。
- **工具 + 确认**：agent 可调用 exec、fs_read 等工具；高危操作执行前弹确认（允许 / 拒绝），决策全部落审计日志。
- **会话**：对话逐条持久化，可随时恢复历史会话。
- **任务**：cron 定时任务（如 `0 9 * * *` 每日早报），到点 daemon 自动开新会话执行。
- **审计**：权限决策全程留痕，WebUI「审计」页可查。
- **记忆**：说「记住我住在上海」→ 存为 markdown 笔记（SQLite 全文索引）；再问「我住哪？」直接命中。
- **WebUI**：浏览器图形界面，功能与 CLI 对等（流式对话、确认卡片、会话、任务、审计）。

## 文档

配置、常用命令、常见问题与架构原理见 GitHub 仓库：<https://github.com/zachysun/kclaw>

## License

[MIT](./LICENSE)
