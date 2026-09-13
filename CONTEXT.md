# kclaw

单守护进程的个人 AI 助理：`@kclaw/core` 引擎 + Fastify daemon + CLI/Web 双客户端，状态以会话事件溯源持久化。

## Language

### 指令的四个来源

**Skill（技能）**:
一份含元数据头与指令正文的 SKILL.md 能力包；模型可自主发现并按需加载正文。可见性可配置。
_Avoid_: 插件、扩展、宏

**Command（自定义命令）**:
用户显式敲 `/xxx` 才触发的提示词模板（`~/.kclaw/commands/*.md`）；模型不能自主发现它。
_Avoid_: skill、斜杠脚本

### 技能复用

**Skill Reuse（技能复用）**:
把其他 coding agent 已有的技能目录以软链接接入 kclaw，内容不复制，仍由源目录维护。
_Avoid_: 导入、安装、同步

**Discovery（探测）**:
扫描其他 coding agent 的用户级技能目录，找出其中可复用的技能。
_Avoid_: 扫描、导入向导

**Visibility Tier（可见档位）**:
一个技能在用户面（点名、技能页）与模型面（系统提示词技能列表）的呈现档位，共四档：完全可见、仅用户、仅模型、暂不启用。自有技能与复用技能共用这套档位。
_Avoid_: 权限、启用开关

**Cognition（认知）**:
关于用户与项目的常驻事实性记忆（persona/rule/wiki），注入系统提示词，内容是"是什么"而非"怎么做"。
_Avoid_: 人设文件、知识库

**Persona（人设）**:
`~/.kclaw/AGENTS.md`，整份常驻系统提示词的全局身份与规则。
_Avoid_: 系统配置

### 界面

**Audit（审计）**:
会话事件流（会话的唯一真相）在 Web 端的只读回看视图，原则是"让用户掌握发生的一切"。
_Avoid_: 轨迹、trail、trajectory、日志页

**Subagent（子代理）**:
主对话模型经 `subagent_run` 工具自主派出的短命执行单元：独立子会话（`meta.parentSessionId` 标识）、单层委派、结题答复即工具结果。子会话对用户只读。
_Avoid_: 子agent、分支会话、平行代理

### 压缩

**Waterline（水位线）**:
压缩触发的五条阈值线，每条是上下文预算的百分比，由水位线模块统一解析为绝对 token 阈值：省略线（缺省 0.70，请求组装时旧工具输出的省略预算）、预压线（0.75，聊天途中后台预压缩的起点）、黄线（0.80，收尾压缩的触发线）、红线（0.90，聊天途中紧急压缩）、目标线（0.33，压缩后的回落水位）。
_Avoid_: 压缩阈值、watermarks

### 架构约定

**Protocol（线上形状）**:
消息、事件、指令帧、排队条目的唯一类型出处：`@kclaw/core/protocol` 纯类型出口。server / web / cli 三端一律引用，不手抄镜像。
_Avoid_: mirrors 注释、各端自定义 wire 类型
