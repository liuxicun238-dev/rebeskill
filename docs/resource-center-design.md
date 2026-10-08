# Resource Center / Asset Library Design

## Visual Theme & Atmosphere

主题是“可检索的 AI 资产工作台”：信息密度高、层级清晰、卡片轻量悬浮。截图中的深蓝仅作为暗色主题下的表现，页面不绑定固定蓝色；背景、表面、边框、文字和强调色全部继承 LingXi 的主题 token。

## Color Palette & Roles

```css
--resource-bg: var(--bg-primary);
--resource-surface: var(--bg-secondary);
--resource-surface-soft: var(--bg-tertiary);
--resource-text: var(--text-primary);
--resource-text-soft: var(--text-secondary);
--resource-text-muted: var(--text-muted);
--resource-border: var(--border-default);
--resource-accent: var(--accent-primary);
--resource-accent-soft: color-mix(in srgb, var(--accent-primary) 14%, transparent);
```

## Typography Rules

使用项目全局中文字体栈；标题 18–22px / 700，卡片标题 13–14px / 650，元信息 11–12px / 400，正文行高不低于 1.6。

## Component Stylings

- 顶部标题、导航和搜索保持单行紧凑布局。
- 统计卡使用主题表面、细边框和轻阴影；hover 时只提升边框与 1px 位移。
- 资产卡为三列网格，预览位于顶部，信息与操作栏位于下方。
- active / hover / focus-visible 均使用 `--resource-accent` 及其透明混合色；禁用态使用 `--text-disabled`。

## Layout Principles

页面内边距 20–28px，模块间距 12–16px；桌面端资产卡最小宽度 260px，优先保持三列；窄屏降为单列。

## Depth & Elevation

采用单层玻璃感：表面使用 `color-mix`，边框使用主题边框 token，阴影使用主题背景混合透明色。避免大面积高强度 blur。

## Animation & Interaction

L1：卡片 hover 以 140ms border / translateY 反馈，按钮提供 focus-visible。L2：资产卡使用短暂 fade-in；搜索、筛选和主题切换保持即时。`prefers-reduced-motion` 下关闭位移动画。

## Do's and Don'ts

- Do 复用现有主题变量。
- Do 保留图片 / 视频真实预览。
- Do 使用清晰的数量、类型和路径元信息。
- Do 为所有按钮保留键盘焦点样式。
- Don't 写死深蓝、纯白或固定强调色。
- Don't 使用 emoji 代替图标。
- Don't 让卡片操作遮挡标题和预览。
- Don't 在移动端产生横向滚动。

## Responsive Behavior

860px 以下工具栏堆叠，资产网格单列，统计卡自动换行；按钮触控区域不小于 36px。600px 以下隐藏非关键路径元信息，保留标题、类型、时间和主要操作。
