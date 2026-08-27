# 扩展指南：新增功能需要修改的位置

以"增加一个新能力"为例，同一功能在四个包里的落点（命名统一，见各包 README）：

1. **新增一个工具（模型可调用）**：`packages/core/src/tools/` 新建文件实现，在 `tools/index.ts` 的 `createBuiltinTools` 注册；权限规则在 `core/src/permissions`。
2. **接入外部 MCP server 的工具（不改代码）**：在 `config.yaml` 的 `mcp.servers` 配置即可——连接、重连与工具适配由 `packages/core/src/mcp/manager.ts` 完成，每个 run 经 RunManager 的 `extraTools` 注入（见 [mcp](./core/mcp.md)）。
3. **新增一个 HTTP API**：`packages/server/src/routes/` 新建 `registerXxxRoutes`，在 `server/src/app.ts` 注册。
4. **新增一个 WebUI 视图**：`packages/web/src/<name>/` 新建目录，在 `App.tsx` 视图切换处接入。
5. **新增一个 CLI 命令**：`packages/cli/src/index.ts` 用 commander 注册 action。
6. **新增一个 slash 命令**：`packages/cli/src/slash.ts` 命令表注册一条；提示词模板类的自定义命令则无需改代码，放 `~/.kclaw/commands/*.md` 即可。
7. **新增一种事件**：`packages/core/src/protocol` 事件类型定义，`server/src/bus.ts` 广播，客户端订阅处理。

> [!NOTE]
> 约定：core 是纯库，不得反向依赖 server/cli/web；工具与路由的测试分别镜像放在各包 `test/` 对应目录。
