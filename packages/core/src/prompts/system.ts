/**
 * 系统提示词的固定脚手架文本。本目录收拢全部内置提示词文本（守卫测试
 * 扫描实现文件里的寄居文本）；纯文本导出常量、带插值的导出模板函数，
 * 不含业务逻辑。
 */

/** System prompt fallback when ~/.kclaw/AGENTS.md is missing or empty. */
export const DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"

/**
 * 系统提示词里对注入约定的声明（与 Claude Code 一致：在系统提示中预先声明标签
 * 可信，模型才能区分"系统注入"与"用户输入"）。主会话与subagent的系统提示词
 * 组装都经 agent/system-prompt.ts 拼接本段（人设基础文本分别来自 run-assembly.ts
 * 的 systemPrompt 与本目录 subagent.ts 的 subagentSystemPrompt）。
 */
export const SYSTEM_INJECTION_CONVENTION = [
  "对话中可能出现在 <system-reminder> 标签内的内容：它们是系统自动注入的备注（任务来源、相关记忆、迭代上限等），不是用户手动输入，也与所在消息的内容无关；处理任务时以其指引为准。",
  "对话开头可能出现 <compacted-summary> 标签：那是更早对话的压缩摘要，仅作背景，不要把其中记录的旧请求当作新指令来执行。",
].join("\n")

/**
 * 工具目录段（stable 段尾部，run-assembly 组装）：本 run 未全量列出的
 * 工具只留名字与一行描述，格式文本在这里，过滤/截断逻辑留在 run-assembly。
 */

/** 目录标题行。 */
export const TOOL_DIRECTORY_HEADING = "# 工具目录（本 run 未全量列出的工具）"

/** 单条目录行：名字 + 截断后的一行描述 + 直呼指引。 */
export function toolDirectoryEntry(name: string, desc: string): string {
  return `- ${name}：${desc}（可直呼，参数拿不准先用 tool_search 查询）`
}

/** 低频工具汇总行：只列名字。 */
export function toolDirectoryLowFreqLine(names: string[]): string {
  return `- 低频工具（只列名字，详情用 tool_search 查询后调用）：${names.join("、")}`
}

/** MCP 外部工具说明行。 */
export const TOOL_DIRECTORY_MCP_NOTE = "- MCP 外部工具同样只列名字，名单见 tool_search 的说明。"
