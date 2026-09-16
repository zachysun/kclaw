# reference — 参考清单

这组文档只做陈列：把源代码里的枚举、类型联合、注册清单逐值列出，每项一句话说明，配核心源码。不讲机制——机制在各分篇（[core](../core/protocol.md)、[server](../server/realtime.md) 等）。

**真相源原则**：每篇的第一行标出它的源码真相源（类型定义所在文件）。其他技术文档需要罗列这些值时，直接引用本目录对应篇目，不再各自维护一份清单——清单只此一份，源码改了只改这里。

| 篇目 | 陈列内容 | 真相源 |
|------|----------|--------|
| [messages](./messages.md) | 消息类型（Role 3）、停止原因（StopReason 7 + 归一化映射）、放行原因（GrantedBy 8） | `core/src/protocol/messages.ts` |
| [blocks](./blocks.md) | 内容块（6 种）、note 种类（5 种）、附件来源（3 种）、role × 块约定 | `core/src/protocol/blocks.ts` |
| [events](./events.md) | 总线事件（EventType 40 种，含分组与 payload）、事件信封 | `core/src/protocol/events.ts` |
| [session-events](./session-events.md) | 持久化会话事件（events.jsonl 的 21 种类型） | `core/src/protocol/session-events.ts` |
| [wire](./wire.md) | WS 指令帧（10 种）、应答帧（9 种 + error）、排队处置（3 种） | `core/src/protocol/wire.ts` |
| [tools](./tools.md) | 内置工具（22 个：常驻 12 + 条件 10）、risk / concurrency 两轴 | `core/src/tools/` |
| [hooks](./hooks.md) | 钩子位置（14 个）、内置钩子（14 个）、失败策略（3 档） | `core/src/hooks/` |
| [enums](./enums.md) | 其余枚举集：权限模式、压缩结局、记忆触发、团队状态、provider 流事件、ID 前缀 | 分散（篇内逐项标注） |
