/**
 * 快捷键总表（spec B14）：`?` 帮助浮层的唯一数据源，输入编辑器与覆盖层的
 * 实际处理与本表一一对应——帮助文档不漂移的唯一办法是只写一份。
 * 分三组（context）：输入编辑器、覆盖层（转录/帮助）、全局。
 */
export interface KeyBinding {
  /** 展示用键位名（帮助浮层第一列）。 */
  keys: string
  /** 说明（帮助浮层第二列）。 */
  description: string
  /** 生效上下文。 */
  context: "输入" | "覆盖层" | "全局"
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { keys: "Enter", description: "发送当前输入；补全/搜索打开时接受当前候选", context: "输入" },
  { keys: "Tab", description: "接受补全候选", context: "输入" },
  { keys: "↑ / ↓", description: "补全选择；无菜单时翻阅输入历史", context: "输入" },
  { keys: "Ctrl+R", description: "反向搜索输入历史（再按切换更早匹配）", context: "输入" },
  { keys: "Ctrl+A / Ctrl+E", description: "光标移到行首 / 行尾", context: "输入" },
  { keys: "Ctrl+W", description: "向前删一个词", context: "输入" },
  { keys: "Ctrl+K", description: "删除光标到行尾", context: "输入" },
  { keys: "Ctrl+U", description: "清空当前输入", context: "输入" },
  { keys: "/", description: "输入行首敲 / 弹出命令菜单（内置命令 + 已装技能）", context: "输入" },
  { keys: "@", description: "敲 @ 弹出文件引用菜单（与 WebUI 同一候选排序）", context: "输入" },
  { keys: "Esc", description: "关闭补全菜单；无菜单且运行中则停止当前 run", context: "输入" },
  { keys: "↑ / ↓ / j / k", description: "转录视图滚动一行", context: "覆盖层" },
  { keys: "PgUp / PgDn", description: "转录视图滚动一页", context: "覆盖层" },
  { keys: "g / G", description: "转录视图跳到开头 / 结尾", context: "覆盖层" },
  { keys: "{ / }", description: "转录视图跳到上一条 / 下一条用户消息", context: "覆盖层" },
  { keys: "q / Esc", description: "关闭转录视图", context: "覆盖层" },
  { keys: "Esc / ?", description: "关闭帮助浮层", context: "覆盖层" },
  { keys: "Ctrl+O", description: "开关转录视图（全文与完整工具输出在此可达）", context: "全局" },
  { keys: "?", description: "输入为空时打开本帮助", context: "全局" },
  { keys: "Shift+Tab", description: "循环切换权限模式（readonly → default → acceptEdits → trusted → auto）", context: "全局" },
  { keys: "Ctrl+C", description: "取消当前 run → 清空队列 → 退出（三段升级）", context: "全局" },
]
