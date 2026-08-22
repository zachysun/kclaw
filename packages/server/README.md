# @kclaw/server

daemon：唯一状态权威。HTTP API + WebSocket（`src/app.ts` 注册路由：sessions/jobs/config/ws），静态托管 WebUI（`webDist`），调度器 tick、事件总线。依赖 `@kclaw/core`；被 CLI 以子进程方式启动（`bin/kclaw-server.mjs`）。
