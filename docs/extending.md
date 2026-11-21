# 扩展指南：新增功能需要修改的位置

每条按四段写：修改位置、接入方法、测试位置、细节参考。各包内部命名统一，见各包 README。

**新增一个工具（模型可调用）**

- 修改位置：`packages/core/src/tools/` 下新建文件，模块自带 `createXxxToolEntries` 工厂，执行器与模型侧 JSON Schema 成对打包，参数校验也在这个模块里。
- 接入方法：`tools/index.ts` 的 `createBuiltinTools` 里一行展开；再补上依赖注入选项与 `tools/exposure.ts` 的披露分层。权限规则在 `core/src/permissions`。
- 测试位置：`packages/core/test/` 下按模块镜像。
- 细节参考：[tools](./core/tools.md)、[reference/tools](./reference/tools.md)。

**接入外部 MCP server 的工具（不改代码）**

- 修改位置：不改代码。在全局 `~/.kclaw/mcp.json` 或项目 `<项目>/.kclaw/mcp.json` 里配置。
- 接入方法：连接与工具适配由 `packages/core/src/mcp/manager.ts` 完成；每个 run 经 RunManager 的 `extraTools(workdir)` 注入该会话工作目录所在项目组的工具。
- 测试位置：不需要。
- 细节参考：[mcp](./core/mcp.md)。

**新增一个 HTTP API**

- 修改位置：`packages/server/src/routes/` 新建 `registerXxxRoutes`。
- 接入方法：在 `server/src/app.ts` 注册。
- 测试位置：`packages/server/test/routes/`。
- 细节参考：[http-api](./server/http-api.md)。

**新增一个 WebUI 视图**

- 修改位置：`packages/web/src/<name>/` 新建目录。
- 接入方法：在 `App.tsx` 的视图切换处接入。
- 测试位置：`packages/web/test/` 下按视图镜像。
- 细节参考：[webui](./web/webui.md)。

**新增一个 CLI 命令**

- 修改位置：`packages/cli/src/index.ts`。
- 接入方法：用 commander 注册 action。
- 测试位置：`packages/cli/test/`。
- 细节参考：[cli](./cli/cli.md)。

**新增一个 slash 命令**

- 修改位置：`packages/core/src/commands.ts` 的 `SLASH_COMMANDS` 里登记元数据（name、usage、description，CLI 与 WebUI 读同一份），再在 `packages/cli/src/slash.ts` 的 `createRegistry` 注册 run 实现。
- 接入方法：提示词模板类的自定义命令不需要改代码，放 `~/.kclaw/commands/*.md`。
- 测试位置：`packages/core/test/commands.test.ts` 与 `packages/cli/test/`。
- 细节参考：[cli](./cli/cli.md)、[webui](./web/webui.md)。

**新增一个技能（不改代码）**

- 修改位置：一个目录，里面一份 `SKILL.md`（YAML 头部加 Markdown 正文）。放进 `~/.kclaw/skills/<目录名>/`（全局）或工作区 `.kclaw/skills/<目录名>/`（项目级，覆盖同名全局技能）。
- 接入方法：下一个 run 即生效，每个 run 重新扫描；模型经 `skill_read` 按名加载正文。要从模型可见列表里藏起来加 `disable-model-invocation: true`；要从用户界面彻底消失加 `user-invocable: false`。也可以不搬文件：在 WebUI 技能页把其他 coding agent（Claude Code、Codex、DeepSeek harness、zCode）的技能一键复用成软链接。
- 测试位置：不需要。
- 细节参考：[skills](./core/skills.md)。

**新增一个 hook（不改代码）**

- 修改位置：一个 js、mjs 或 ts 文件，`export const hook = { position, failure? }` 声明挂载点与失败时的行为，default 导出处理函数。放进 `~/.kclaw/hooks/`。
- 接入方法：下一轮 run 即生效，每个 run 重新扫描。`failure` 取 `skip`（默认，失败跳过）或 `deny`（失败时否决所在环节）；`fatal` 只有内置 hook 能用，用户声明会被拒绝装载。
- 测试位置：`packages/core/test/hooks/`。
- 细节参考：[hooks](./core/hooks.md)、[reference/hooks](./reference/hooks.md)。

**新增一种事件**

- 修改位置：`packages/core/src/protocol` 的事件类型定义。
- 接入方法：由 `@kclaw/core` 的 EventBus（`core/src/bus.ts`）广播，客户端订阅处理。
- 测试位置：`packages/core/test/protocol/`。
- 细节参考：[protocol](./core/protocol.md)、[reference/events](./reference/events.md)。

> [!NOTE]
> 约定：core 是纯库，不得反向依赖 server、cli、web。工具与路由的测试按模块镜像放在各包 `test/` 对应目录。
