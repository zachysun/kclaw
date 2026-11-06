# @kclaw/cli

终端客户端：commander 命令（chat/run/web/daemon/status/cron/mcp/session，`src/index.ts`）、交互 REPL（`src/chat.ts`）、供脚本调用的一次性 `kclaw run`（`src/run-cmd.ts`）、slash 命令表（`src/slash.ts`）、daemon 检测与自动启动（`src/daemon-ctl.ts`）。依赖 `@kclaw/core` 与 daemon 的 HTTP+WS API。

首次运行时，daemon 报告尚未配置 provider，`chat` 入口进入配置流程（`src/wizard.ts`：选模板 → key/模型 → 经 daemon 连通测试 → 经 daemon 保存为默认 provider）。
