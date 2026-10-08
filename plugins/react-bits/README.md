# React Bits（第三方插件）

这是灵犀对 [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) 的离线接入插件。

- 安装插件后，技能下拉中会出现“React Bits”。
- `library/` 内置精简后的组件源码，不包含 React Bits 官网、演示媒体和站点工程。
- 组件不会被整体写入用户项目；AI 只复制当前任务选中的组件和变体。
- 支持 `js-css`、`js-tailwind`、`ts-css`、`ts-tailwind` 四种变体。

## 本地工具

```powershell
node scripts/react-bits-library.cjs status --json
node scripts/react-bits-library.cjs search light --json
node scripts/react-bits-library.cjs inspect LightRays --variant ts-css --json
node scripts/react-bits-library.cjs copy LightRays --variant ts-css --project C:\path\to\project --json
```

React Bits 及其组件由原项目作者维护，许可证见 `LICENSES/REACT-BITS-LICENSE.md`。
