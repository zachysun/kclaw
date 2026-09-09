# sandbox — exec 沙箱 provider

## 职责

`packages/core/src/sandbox/provider.ts` 的 `createExecSandbox` 是权限批次 A 引入的**唯一新模块**：给 `exec` 工具的子进程套一层操作系统沙箱，作为权限确认之下的纵深防御——命令即使获准运行，也被限制在受控范围内（模型被 prompt injection 时，确认挡不住命令内部的动作，沙箱兜底）。模块只做两件事：**平台可用性探测** 与 **spawn 包装**，不做任何业务判定——"沙箱化是否免审"归权限引擎（`permissions/engine.ts` 的 `sandboxAvailable` 输入），由 run 装配（core `executeRun`）用同一次探测结果喂给两个消费方：

1. `createBuiltinTools` 的 `exec.sandbox`（只有可用才注入，exec 工具本身不探测平台）；
2. `ConfigPermissionGate` 的 `sandboxAvailable`（命令类工具无规则命中时 `allow {reason:"sandboxed"}`）。

单一来源保证 **"sandboxed" 放行的命令必然真被沙箱包住**，反之沙箱不可用时 exec 维持 confirm（fail-closed，绝不裸跑）。

## 接口

```ts
export interface SandboxConfig {          // config.yaml 的 sandbox: 节
  enabled: boolean                        // 整体开关，默认 true
  writeRoots: string[]                    // 追加写白名单（realpath 形态），默认 []
}

export interface ExecSandbox {
  readonly available: boolean
  readonly unavailableReason?: string     // 不可用原因（可用时无）
  spawn(command: string, opts: { cwd: string }): ChildProcess
}

export function createExecSandbox(
  cfg: SandboxConfig,
  o?: { workspace?; home?; tmpDirs?; which? }   // which/tmpDirs 可注入（测试）
): ExecSandbox
```

exec 工具消费的最小面（`tools/exec.ts` 的 `ExecSandboxSpawn`）只有 `spawn`；`createExecSandbox` 的返回值同时满足它（可用时）与 gate 的可用性布尔。

## 平台布局

| 平台 | 工具 | 布局 | 凭据隔离 | 写范围 |
|------|------|------|----------|--------|
| macOS | `sandbox-exec`（/usr/bin，系统自带） | SBPL profile：`(import "system.sb")` + 读全放行（除 `~/.kclaw`）+ 写白名单 + `(deny file-write*)` 兜底 | `~/.kclaw` 读拒绝（SBPL 规则先匹配生效，拒绝规则在宽放行之前） | 工作区 + 系统临时目录 + config writeRoots |
| Linux | `bwrap`（bubblewrap，非特权 user namespaces） | 整个根 `--ro-bind / /` + `~/.kclaw` tmpfs 遮蔽 + `/tmp`、`/var/tmp` tmpfs + 工作区 `--bind` 可写 + `--die-with-parent --new-session` + `--chdir` 工作区 | `~/.kclaw` 被 tmpfs 换成空目录（不可见） | 工作区 + `/tmp` + config writeRoots |

两平台共同点：

- **路径一律 realpath 形态**：`/tmp` 在 macOS 真实路径是 `/private/tmp`，词面匹配可被符号链接绕开（实测踩坑）。`realpathWithin`（来自 permissions/engine.ts）统一解析。
- **网络默认允许，可配 deny**：缺省（`sandbox.network: "allow"`）bwrap 不加 `--unshare-net`、seatbelt profile 放行 `network*`——git clone / npm install / curl 照常工作。`sandbox.network: "deny"` 时 exec 子进程不可建出站/入站连接：Seatbelt 换成 `(deny network-outbound)` + `(deny network-inbound)`（实测裸 `(deny network*)` 过宽——通配符连 shell 启动要用的内部操作一起拦，进程直接起不来；outbound/inbound 恰好拦 `connect()`/`accept()` 而进程可用），bwrap 加 `--unshare-net`。**web_search/web_fetch 不受影响**：它们在 daemon 进程内执行、不走 exec 子进程——这是"断网沙箱不需要沙箱外代理"的架构红利。
- **进程组语义保留**：包装器 spawn 时 `detached: true`，exec 工具的超时 `kill(-pid)` 照旧波及整棵进程树；bwrap 的 `--new-session --die-with-parent` 双保险。
- **越界表现为命令的普通失败**：沙箱内访问放行集外路径得到 Operation not permitted / Read-only file system 之类错误，exec 以 error result 透传——命令"被沙箱拒绝"与"启动失败"都 fail-closed。

## 降级链

```
bwrap 可用（二进制存在 + 真实探测 `bwrap --die-with-parent true` 通过）→ 完整文件系统沙箱
bwrap 不可用 → 不可用（回落人工确认）
```

- 探测在每 run 装配做一次；`bwrap --die-with-parent true` 验证 user namespaces 真的可用（而非只找到二进制）。
- **Landlock 兜底是后续项**：纯 Node 无法发起 `landlock_create_ruleset` syscall，也没有成熟 CLI 包装工具。降级为"不可用 → confirm"是 fail-closed 方向，安全不降级。
- macOS 的 `sandbox-exec` 被 Apple 标注 deprecated 但当前系统仍可用；长期迁移 libsandbox C API 不属本批。
- `sandbox.enabled: false` 关闭整个特性：exec 恢复裸跑、gate 的 `sandboxAvailable` 为 false（所有 exec 走既有判定链）。

## 配置

```yaml
sandbox:
  enabled: true        # 默认开
  writeRoots: []       # 追加写白名单（realpath 形式），如 ~/.npm 缓存目录
  network: allow       # allow | deny；deny 时 exec 子进程断网（web 工具不受影响）
```

daemon 级基础设施配置（非会话偏好），不进会话 meta。npm 等工具在沙箱内需要可写缓存：把 `npm_config_cache` 指到工作区或临时目录，或把缓存路径加进 `writeRoots` 白名单。

## 测试策略

- **纯函数**：`seatbeltProfile` / `bwrapArgs` 断言布局形状（写白名单含工作区与 writeRoots、`~/.kclaw` 遮蔽、缺省无 unshare-net、deny 才有、命令经 `/bin/sh -c`）。
- **注入 seam**：`createExecSandbox` 的 `which`/`tmpDirs` 可注入；exec 工具的沙箱参数用 fake sandbox（放行 / 失败 / 超时）驱动——见 `tools/exec.test.ts`。
- **真实冒烟**（环境依赖，慢速测试）：macOS 本机真 `sandbox-exec`（写工作区成功、写家目录被拒、读 `~/.kclaw` 被拒、网络 socket 可建；network deny 时出站 connect 得 EPERM 而文件操作照常），Linux CI ubuntu runner 真 bwrap（写工作区成功、家目录只读、`~/.kclaw` 遮蔽）。冒烟用注入的**假 home**（tmp 或真 home 下的临时目录），不碰真实 `~/.kclaw`。
