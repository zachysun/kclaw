# 扩展指南：新增功能需要修改的位置

以"增加一个新能力"为例，同一功能在四个包里的落点（命名统一，见各包 README）：

1. **新增一个工具（模型可调用）**：`packages/core/src/tools/` 新建文件实现，在 `tools/index.ts` 的 `createBuiltinTools` 注册；权限规则在 `core/src/permissions`。
2. **接入外部 MCP server 的工具（不改代码）**：在 `config.yaml` 的 `mcp.servers` 配置即可——连接、重连与工具适配由 `packages/core/src/mcp/manager.ts` 完成，每个 run 经 RunManager 的 `extraTools` 注入（见 [mcp](./core/mcp.md)）。
3. **新增一个 HTTP API**：`packages/server/src/routes/` 新建 `registerXxxRoutes`，在 `server/src/app.ts` 注册。
4. **新增一个 WebUI 视图**：`packages/web/src/<name>/` 新建目录，在 `App.tsx` 视图切换处接入。
5. **新增一个 CLI 命令**：`packages/cli/src/index.ts` 用 commander 注册 action。
6. **新增一个 slash 命令**：先在 `packages/core/src/commands.ts` 的 `SLASH_COMMANDS` 共享清单里登记元数据（name/usage/description——CLI 与 WebUI 读同一份，保证两端文案不漂移，见 [webui](./web/webui.md) 与 [cli](./cli/cli.md)），再在 `packages/cli/src/slash.ts` 的 `createRegistry` 注册 run 实现；提示词模板类的自定义命令则无需改代码，放 `~/.kclaw/commands/*.md` 即可。
7. **新增一个技能包（不改代码）**：一个技能是一个目录，里面放一份 `SKILL.md`（YAML 头部 + Markdown 正文）。放进 `~/.kclaw/skills/<目录名>/`（全局）或工作区 `.kclaw/skills/<目录名>/`（项目级，覆盖同名全局技能），下一个会话轮次即生效——daemon 每 run 现扫、模型经 `skill_read` 按名加载正文（机制与五个可解释字段见 [skills](./core/skills.md)）。想从模型可见列表里藏起来就加 `disable-model-invocation: true`，想彻底从用户面消失（斜杠命令/技能页都不可见）就加 `user-invocable: false`。
8. **新增一个钩子（不改代码）**：一个钩子是一个 js/mjs/ts 文件，`export const hook = { position }` 声明挂载点、default 导出处理函数，放进 `~/.kclaw/hooks/`，下一轮 run 即生效——daemon 每 run 现扫，14 个封闭位置对应 run 时间线上的行为接缝（改写用户消息/模型视图/系统提示词、观察工具与压缩、注入引导……）；用户钩子一律 fail-open，抛错只发 `hook.failed` 事件不伤 run（位置网格、文件契约与内置钩子清单见 [hooks](./core/hooks.md)）。
9. **新增一种事件**：`packages/core/src/protocol` 事件类型定义，`@kclaw/core` 的 EventBus（`core/src/bus.ts`）广播，客户端订阅处理。

> [!NOTE]
> 约定：core 是纯库，不得反向依赖 server/cli/web；工具与路由的测试分别镜像放在各包 `test/` 对应目录。
