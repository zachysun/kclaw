# @kclaw/core

纯库 agent 引擎：agent 循环、协议类型（`src/protocol`）、provider、工具、权限、持久化、定时任务（`src/jobs`）、记忆。不依赖 server/cli/web，不监听端口、不起进程。被 `@kclaw/server` 与 `@kclaw/cli` 通过 workspace 依赖消费。
