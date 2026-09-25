## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`zachysun/kclaw`), operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 核心工程原则

1. **架构与领域优先**：计划阶段应以理想架构为目标，明确业务目标、领域边界、模块职责、依赖方向和数据流，形成符合领域规律、面向长期维护且可持续演进的设计后再进入编码；不得以短期实现便利牺牲整体设计。设计必须完整，实现应当克制：不做推测性抽象，抽象延迟到第二个真实用例出现时才引入，单一场景直接实现。在本仓库具体指守住 workspace 包边界：`@kclaw/server`、`@kclaw/web`、`@kclaw/cli` 只消费 `@kclaw/core`，聚合包 `kclaw` 只负责组装，依赖单向，不反向、不横向。
2. **追求优雅的代码模块**：模块应高内聚、低耦合，通过精简且稳定的接口封装内部复杂度，使职责、命名、依赖和扩展方式清晰自然；代码按单一职责拆分，单个文件不得超过 500 行，接近上限时应优先重构模块边界。
3. **保持边界与数据流清晰**：协议模型、领域模型、持久化模型和视图模型不得相互泄漏（在本仓库依次对应：LLM 供应商协议消息、会话事件、`events.jsonl` 持久化、web 视图状态等）；数据必须在边界处完成校验和独立转换，避免跨层共享可变状态。
4. **安全与隔离默认开启**：daemon 以 token 鉴权，各 workspace 数据相互隔离；权限判定链与 exec 沙箱遵循最小权限原则，可沙箱化的操作先在沙箱内免审执行。任何外部输入（用户消息、模型输出、MCP 服务返回、工作区文件）均视为不可信；API key 与 token 等敏感信息不得进入代码、日志、事件流或接口响应。
5. **面向并发与故障设计**：后端应主动考虑幂等性、竞态、事务边界、超时、取消、重试、背压和资源释放（在本仓库如 run 队列、压缩调度、钩子超时、subagent 与沙箱子进程的取消和清理）；不得通过无边界重试、吞错或隐式共享状态掩盖问题。
6. **保障完整前端体验**：前端应控制渲染成本、异步状态和并发请求，保持清晰的 UI 结构；用户流程必须覆盖加载、空状态、错误、重试、反馈和可访问性。
7. **复用稳定的业务语义**：优先复用已有模块和能力，但不要仅因代码外形相似而过早抽象；确需重复时，必须注释说明其独立演进或暂不抽象的原因。新增依赖前先核查项目已有依赖（根 `package.json` 与 `packages/` workspace）能否满足需求，不得臆断已有库缺少功能，先查阅文档和类型定义；确需引入时优先成熟且维护良好的库，不重复实现通用功能。
8. **为未来维护者保留上下文**：代码、注释、测试和架构文档是跨越时间的协作媒介。非显然的设计决策、兼容约束、已知缺陷和临时方案，必须记录原因、影响范围、潜在风险及移除条件；技术债务应关联可追踪 issue，关键架构决策应同步到 `docs/adr/`，禁止留下缺少上下文的 `TODO`。
9. **确保变更可验证、可观测、可回滚**：每项改动都应行为可测试、运行状态可观测（在本仓库经事件流与审计页）、故障可定位，并兼顾向后兼容和回滚路径；错误与日志必须保留诊断上下文，但不得泄露敏感信息。
10. **删除优于兼容**：内部路径重构时直接删除过时实现，禁止新增兼容层、deprecated shim 或双写逻辑；对外契约（`~/.kclaw/` 配置文件格式、HTTP/WS 接口、已分发版本的行为）的兼容性按契约单独评估，属于合同义务而非迁就旧代码。

> **变更速查**：提交前通常运行 `pnpm -r build && pnpm -r test`；`@kclaw/server`、`@kclaw/web`、`@kclaw/cli` 经 workspace 链接消费 `@kclaw/core` 的 dist，先构建再测，旧产物会假红。修改 web 或 core 后额外运行 `pnpm --filter kclaw build` 重组装聚合包，daemon 重启后才会吃到新产物（daemon 用 node 24 跑）。改动行为、事件、工具或路由后，先同步 `docs/` 对应篇章再提交。推送前做一遍隐私自查（本机 pre-push 钩子会再扫一遍）。
