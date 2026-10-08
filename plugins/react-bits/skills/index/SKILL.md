---
name: index
title: React Bits
description: 离线检索并按需接入第三方 React Bits 动效组件；支持 JS/TS、CSS/Tailwind，自动分析依赖并适配现有项目。
---

# React Bits 离线组件接入

你正在使用灵犀的第三方 **React Bits** 插件。组件源码已随插件安装，无需联网下载。

## 适用场景

- 用户需要 React 页面动效、交互组件、文字动画或 WebGL 背景。
- 用户明确提到 React Bits，或提供了 React Bits 组件代码。
- 现有 React/Vite/Next.js 项目需要加入一个视觉组件并适配当前主题。

## 不适用场景

- 非 React 项目，且用户不希望引入 React。
- 只需简单 CSS 就能实现的效果，不应为了展示而引入重型依赖。
- 用户要求把全部组件复制进项目。必须坚持按需接入。

## 工具位置

本 Skill 文件位于 `<插件目录>/skills/index/SKILL.md`，工具位于：

```text
<插件目录>/scripts/react-bits-library.cjs
```

使用 Node.js 执行。路径中有空格时必须加引号。

## 标准流程

1. 检查当前项目的 React、TypeScript、Tailwind 和构建工具版本。
2. 查询离线库状态：

   ```text
   node "<插件目录>/scripts/react-bits-library.cjs" status --json
   ```

3. 将用户意图转换为英文组件关键词，再搜索候选项：

   ```text
   node "<插件目录>/scripts/react-bits-library.cjs" search "light" --json
   ```

4. 根据项目选择一种变体：

   - `js-css`：JavaScript + 普通 CSS
   - `js-tailwind`：JavaScript + Tailwind
   - `ts-css`：TypeScript + 普通 CSS
   - `ts-tailwind`：TypeScript + Tailwind

5. 先检查组件文件与依赖：

   ```text
   node "<插件目录>/scripts/react-bits-library.cjs" inspect LightRays --variant ts-css --json
   ```

6. 复制单个组件到当前项目：

   ```text
   node "<插件目录>/scripts/react-bits-library.cjs" copy LightRays --variant ts-css --project "<项目绝对路径>" --json
   ```

7. 只安装 `dependencies` 返回的必要依赖；不要安装 React Bits 官网的整套依赖。
8. 将组件接入真实页面，适配主题变量、容器尺寸、层级、交互和 reduced-motion。
9. 运行项目现有的检查或构建，并进行可见界面验证。

## 设计与工程规则

- 组件只是素材，不是最终设计。必须根据当前产品的色彩、字体、空间和动效节奏重新调整。
- 动效背景默认 `pointer-events: none`；交互组件除外。
- WebGL、Three.js、OGL、GSAP、Matter.js 等依赖必须按需引入。
- 优先保证移动端、窗口缩放和高 DPI 下正常。
- 尊重 `prefers-reduced-motion`，并为低性能设备提供静态或低开销降级。
- 禁止复制整个 `library/` 到用户项目，禁止将其包装成新的组件商城或组件合集。
- 已复制组件必须保留工具生成的 `LICENSE.react-bits.md` 和来源说明。

## 输出要求

完成后向用户说明：使用了哪个组件、选了哪种变体、增加了哪些依赖、修改了哪些页面，以及如何关闭或调整动效。
