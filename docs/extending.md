# 扩展指南：新增功能需要修改的位置

新增一类功能时，各自要动哪个包的哪个位置（各包内部命名统一，见各包 README）：

1. **新增一个工具（模型可调用）**：`packages/core/src/tools/` 新建文件实现，在 `tools/index.ts` 的 `createBuiltinTools` 注册；权限规则在 `core/src/permissions`。
2. **接入外部 MCP server 的工具（不改代码）**：在全局 `~/.kclaw/mcp.json` 或某个项目的 `<项目>/.kclaw/mcp.json` 配置即可——连接（run 用到才按需连）与工具适配由 `packages/core/src/mcp/manager.ts` 完成，每个 run 经 RunManager 的 `extraTools(workdir)` 注入该会话工作目录所在项目组的工具面（见 [mcp](./core/mcp.md)）。
3. **新增一个 HTTP API**：`packages/server/src/routes/` 新建 `registerXxxRoutes`，在 `server/src/app.ts` 注册。
4. **新增一个 WebUI 视图**：`packages/web/src/<name>/` 新建目录，在 `App.tsx` 视图切换处接入。
5. **新增一个 CLI 命令**：`packages/cli/src/index.ts` 用 commander 注册 action。
6. **新增一个 slash 命令**：先在 `packages/core/src/commands.ts` 的 `SLASH_COMMANDS` 共享清单里登记元数据（name/usage/description——CLI 与 WebUI 读同一份，保证两端显示的文案一致，见 [webui](./web/webui.md) 与 [cli](./cli/cli.md)），再在 `packages/cli/src/slash.ts` 的 `createRegistry` 注册 run 实现；提示词模板类的自定义命令则无需改代码，放 `~/.kclaw/commands/*.md` 即可。
7. **新增一个技能（不改代码）**：一个技能是一个目录，里面放一份 `SKILL.md`（YAML 头部 + Markdown 正文）。放进 `~/.kclaw/skills/<目录名>/`（全局）或工作区 `.kclaw/skills/<目录名>/`（项目级，覆盖同名全局技能），下一个 run 即生效，每个 run 重新扫描目录，模型经 `skill_read` 工具按名加载正文（机制与五个可解释字段见 [skills](./core/skills.md)）。想从模型可见列表里藏起来就加 `disable-model-invocation: true`，想彻底从用户界面消失（斜杠命令/技能页都不可见）就加 `user-invocable: false`。也可以不搬文件：在 WebUI 技能页把其他 coding agent（Claude Code、Codex、DeepSeek harness、zCode）已有的技能一键复用成软链接，可见档位在页面上配置（见 [skills](./core/skills.md) 的技能复用一节）。
8. **新增一个 hook（不改代码）**：一个 hook 是一个 js/mjs/ts 文件，`export const hook = { position, failure? }` 声明挂载点与失败时的行为（`skip` 默认，失败即跳过；`deny` 失败时否决所在环节，如 `tool-before` 上该工具不执行）、default 导出处理函数，放进 `~/.kclaw/hooks/`，下一轮 run 即生效，每 run 重新扫描，14 个固定挂载位置对应一次 run 时间线上可以插入行为的地方（改写用户消息/模型视图/系统提示词、观察工具与压缩、注入引导……）；`fatal` 仅内置 hook 可用，用户声明会被拒绝装载（位置网格、文件契约与内置 hook 清单见 [hooks](./core/hooks.md)）。
9. **新增一种事件**：`packages/core/src/protocol` 事件类型定义，`@kclaw/core` 的 EventBus（`core/src/bus.ts`）广播，客户端订阅处理。

> [!NOTE]
> 约定：core 是纯库，不得反向依赖 server/cli/web；工具与路由的测试分别镜像放在各包 `test/` 对应目录。
