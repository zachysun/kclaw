# @kclaw/cli

终端客户端：commander 命令（chat/web/daemon/status/jobs，web 打开 WebUI；`src/index.ts`）、交互 REPL（`src/chat.ts`）、slash 命令表（`src/slash.ts`）、daemon 探测与自动启动（`src/daemon-ctl.ts`）。依赖 `@kclaw/core` 与 daemon 的 HTTP+WS API。

首次运行 provider 向导（`src/wizard.ts`，`src/provider-check.ts` 判定未配模型时在 `chat` 入口触发：选模板 → key/模型 → 连通探测 → 写 config.yaml）。
