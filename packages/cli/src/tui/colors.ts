/**
 * TUI 色板与图标（spec B9）：四档封顶——正文默认色、系统事件 dim、错误红、
 * 工具行琥珀（与 web amber 主题的 `--accent: #e0a44e` 呼应）。颜色开关遵守
 * C1：configureColor 已在 ink 加载前把结论写进它读取的环境变量，组件经
 * ink `<Text>` 的 color/dimColor 属性用色（ink 内部用 chalk 上色），从不
 * 自行判断。
 *
 * 图标几何系：⏺ 工具调用、⎿ 工具结果缩进、✻ thinking/进行中、✱ 系统事件、
 * ⚠ 注意、· 提示。系统事件的文案前缀（✱/⚠/[note]）由 frame-view 生成、
 * 现状逐字一致，这里只提供颜色档位与工具行图标。
 */
export const AMBER = "#e0a44e"

export const ICONS = {
  tool: "⏺",
  result: "⎿",
  thinking: "✻",
  system: "✱",
  warn: "⚠",
  hint: "·",
  error: "✖",
} as const

/** Spinner 帧：细点步进，工具进行中与 run 间隙行共用。 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
