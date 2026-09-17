# WebUI 主题注册表

## 职责

WebUI 的视觉主题是**可插拔**的：一套主题 = `packages/web/src/themes/` 下的一个样式文件（调色板、color-scheme、圆角、焦点环与主题专属装饰全在自己文件里）+ `packages/web/src/theme.ts` 里 `THEME_META` 的一行登记（显示名与浏览器栏颜色）。新增主题即"一个文件 + 一行注册"，不需要改任何组件代码——组件只引用 CSS 变量（design tokens），不感知具体主题。

## 机制

- **主题清单从文件名派生**：`themeStylesheetIds()` 用构建期扫描（`import.meta.glob("./themes/*.css", { eager: true })`）从样式文件名读出主题 id，内联进产物、不发额外请求。`THEME_META` 的键必须与样式文件一一对应——单测 `theme.test.ts` 断言两边集合相等，注册表与样式文件脱节会直接测试失败。
- **切换靠 `<html data-theme>` 一个属性**：整个换肤是纯 CSS 的——每个主题文件以 `html[data-theme="<主题id>"]` 选择器命中自己的值，组件不动。`applyTheme(theme)` 写这个属性、同步更新 `meta[name="theme-color"]`（PWA 窗口与移动端状态栏的颜色）并持久化到 localStorage 键 `kclaw_theme`；localStorage 写失败只影响下次启动，本次会话仍生效。
- **首帧不闪错主题**：`index.html` 头部有一段内联脚本，在样式表加载前就把 localStorage 里的值原样写到 `<html data-theme>` 上——它不认识主题清单（因此加主题不用改它），未知/损坏的值没有专属块命中，自然渲染默认主题配色。应用挂载后 `App.tsx` 再用 `loadTheme()`（非法值回落 `DEFAULT_THEME`）统一应用一次，把属性与浏览器栏颜色纠正到合法值。
- **顶栏下拉**：主题选项来自 `themeOptions()`——默认主题排最前、其余按字母序，显示名用 `THEME_META.label`（中文名）。选择即切换并持久化。
- **默认主题拥有 `:root`**：phantom 的样式文件以 `:root, html[data-theme="phantom"]` 开头。这层 `:root` 是双重身份——既是 phantom 自己的调色板，也是未知/损坏存储值的回退目标；共享的暗色派生表面（代码块底色、行条纹、代码高亮、阴影、遮罩）也定义在这里，amber 等暗色主题继承它们，paper 等浅色主题逐一覆盖。

## 现有三套主题

| 主题 id | 显示名 | 观感 |
|---------|--------|------|
| `phantom` | 红黑 | 默认。近黑画布 + 红色强调 + 黄色警示的高对比配色；红色专用于 agent 活动信号（daemon 连接状态点、回复进行时的脉冲光标行、输入框提示符），警示用危险条纹黄。直角小圆角，带专属装饰层：斜体标题、斜切标签、危险条纹带、斜体按钮 |
| `amber` | 琥珀 | 暖黑画布 + 琥珀强调的经典观感，圆角更软。未声明的派生表面继承 phantom 的暗色基线 |
| `paper` | 纸白 | 象牙白纸面 + 墨色文字 + 朱砂强调的浅色主题。浅色下警示改深琥珀/焦橙保证可读，派生表面全部覆盖为浅色值 |

## 新增主题

1. 在 `packages/web/src/themes/` 新建 `<主题id>.css`，以 `html[data-theme="<主题id>"]` 块声明该主题的全部设计令牌（浅色主题要连 phantom `:root` 里的派生表面一起覆盖）。
2. 在 `theme.ts` 的 `THEME_META` 加一行：`<主题id>: { label: "显示名", themeColor: "浏览器栏颜色" }`。
3. 跑一遍 `theme.test.ts`——它保证样式文件与注册表同步，两处不一致会失败。

## 关联

- [webui](./webui.md)：WebUI 整体视图、token 引导与 WS 客户端（主题下拉在顶栏的完整布局上下文）
- [architecture](../architecture.md)：WebUI 作为独立构建的静态产物，由 daemon 托管
