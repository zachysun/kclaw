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

**Cognition（认知）**:
关于用户与项目的常驻事实性记忆（persona/rule/wiki），注入系统提示词，内容是"是什么"而非"怎么做"。
_Avoid_: 人设文件、知识库

**Persona（人设）**:
`~/.kclaw/AGENTS.md`，整份常驻系统提示词的全局身份与规则。
_Avoid_: 系统配置
