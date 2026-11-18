# WebUI 主题注册表

## 职责

WebUI 的视觉主题是**可插拔**的：一套主题 = `packages/web/src/themes/` 下的一个样式文件（调色板、color-scheme、圆角、焦点环、阴影/玻璃/渐变 token 与主题专属装饰全在自己文件里）+ `packages/web/src/theme.ts` 里 `THEME_META` 的一行登记（显示名与浏览器栏颜色）。新增主题即"一个文件 + 一行注册"，不需要改任何组件代码：组件只引用 CSS 变量（design tokens），不感知具体主题。

## 设计决策

- **主题清单从文件名派生**：`themeStylesheetIds()` 用构建期扫描（`import.meta.glob("./themes/*.css", { eager: true })`）从样式文件名读出主题 id，内联进产物、不发额外请求。`THEME_META` 的键必须与样式文件一一对应：单测 `theme.test.ts` 断言两边集合相等，注册表与样式文件脱节会直接测试失败。
- **切换靠 `<html data-theme>` 一个属性**：整个换肤是纯 CSS 的：每个主题文件以 `html[data-theme="<主题id>"]` 选择器命中自己的值，组件不动。`applyTheme(theme)` 写这个属性、同步更新 `meta[name="theme-color"]`（PWA 窗口与移动端状态栏的颜色）并持久化到 localStorage 键 `kclaw_theme`；localStorage 写失败只影响下次启动，本次会话仍生效。
- **首帧不闪错主题**：`index.html` 头部有一段内联脚本，在样式表加载前就把 localStorage 里的值原样写到 `<html data-theme>` 上。它不认识主题清单（因此加主题不用改它），未知/损坏的值没有专属块命中，自然渲染默认主题配色。应用挂载后 `App.tsx` 再用 `loadTheme()`（非法值回退到 `DEFAULT_THEME`）统一应用一次，把属性与浏览器栏颜色纠正到合法值。
- **顶栏下拉**：主题选项来自 `themeOptions()`：默认主题排最前、其余按字母序，显示名用 `THEME_META.label`（中文名）。选择即切换并持久化。
- **默认主题拥有 `:root`**：paper 的样式文件以 `:root, html[data-theme="paper"]` 开头。这层 `:root` 有双重身份：既是 paper 自己的调色板，也是未知/损坏存储值的回退目标。每套主题的派生表面（代码块底色、行条纹、代码高亮、阴影色调、遮罩）都在自己文件里完整声明：浅色主题与暗色主题的派生值本来就不相同，逐主题声明比"暗色基线 + 浅色覆盖"更直白。
- **共享的视觉语言，主题只换调色板**：圆角（卡片 12px / 控件 8px / 弹窗 16px）、分层软阴影（`--shadow-1/2/3`，每层一个贴地接触影加一个环境影）、玻璃浮层（`--glass-bg` + `backdrop-filter` 模糊，toast/菜单/悬浮卡/抽屉用）、按钮材质（`--btn-grad` 竖向渐变 + 分层阴影，主操作用 `--accent-grad` 信号色渐变）由三套主题共用同一套 token 名，数值按各自调色板取值。安静按钮（列表行、tab 标签、裸 × 按钮）在使用处覆写 `background` 并声明 `box-shadow: none`。

## 现有三套主题

| 主题 id | 显示名 | 观感 |
|---------|--------|------|
| `paper` | 瓷白 | 默认。冷灰画布上铺白色卡片，墨色文字，柔和朱红作为 agent 信号色（红色只用于 agent 活动、选中态细条与主操作）；警示用深琥珀、危险用焦赭保证浅色下可读。画布带极淡的竖向渐变，卡片与浮层走分层软阴影；对话页里用户输入是气泡，assistant / tool 输出直接渲染在画布上 |
| `phantom` | 红黑 | 安静的暗色主题：深炭画布 + 柔白文字 + 哑光信号红，警示/危险用哑金。唯一专属装饰是活动 tab 的滑动块带红色调（`accent-dim` 填充），整页无高对比装饰 |
| `amber` | 琥珀 | 暖炭画布 + 琥珀信号色的暖暗观感，危险用哑鲑红。圆角、阴影、玻璃与另两套同一语言 |

## 新增主题

1. 在 `packages/web/src/themes/` 新建 `<主题id>.css`，以 `html[data-theme="<主题id>"]` 块声明该主题的全部设计令牌：调色板、三级圆角、焦点环、按钮与主操作渐变、三层阴影、玻璃底色、派生表面（代码块底色、行条纹、代码高亮、遮罩）——对照现有主题文件逐项补齐，缺项会回退到默认主题的值。
2. 在 `theme.ts` 的 `THEME_META` 加一行：`<主题id>: { label: "显示名", themeColor: "浏览器栏颜色" }`。
3. 执行一遍 `theme.test.ts`，它保证样式文件与注册表同步，两处不一致会失败。

## 关联

- [webui](./webui.md)：WebUI 整体视图、token 引导与 WS 客户端（主题下拉在顶栏的完整布局上下文）
- [architecture](../architecture.md)：WebUI 作为独立构建的静态产物，由 daemon 托管
