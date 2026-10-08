# AI 打包规范（必须遵守）

本文件供后续 AI 和开发人员执行本项目打包任务时使用。

## “打包”的默认含义

当用户只说“打包”“重新打包”“打个安装包”时，默认含义是：

- 构建 Electron 应用；
- 继续构建项目的自研 Windows 安装器；
- 最终交付可直接安装的 `灵犀 LingXiCode Installer 1.0.0.exe`。

除非用户明确说“只生成解包目录”“只跑基础打包”或“不要安装器”，否则不得只运行基础 Electron 打包。

## 唯一默认命令

在当前源码根目录（包含 `package.json`、`electron/`、`frontend/` 和 `installer/` 的目录）执行：

```powershell
npm run dist
```

`npm run dist` 会调用：

```text
dist -> dist:self -> installer/build-self-installer.ps1 -> npm run pack
```

不得用以下命令代替默认打包：

- `npm run pack`：只生成 Electron 解包目录，没有最终自研安装器。
- `electron-builder --dir`：同样只有基础解包结果。
- `npm start`：只是启动程序，不是打包。

## 固定的外置输出目录

所有大型构建产物必须放在项目目录之外：

```text
E:\灵犀-11\安装器\
├─ dist\win-unpacked\
├─ payload\app.zip
└─ installer\灵犀 LingXiCode Installer 1.0.0.exe
```

禁止把 `dist`、`payload` 或最终安装器改回源码项目目录。这样做会显著增加项目复制、备份和版本切换的体积。

自研安装脚本会从当前源码路径向上查找名为 `灵犀-11` 的工作区根目录，再固定使用其下的 `安装器`。因此源码可以在 `E:\灵犀-11` 下更换版本目录或嵌套深度；AI 不得套用上一次会话中的旧源码绝对路径。

## 执行前检查

1. 以用户当前指定或当前工作区的源码目录为准。
2. 确认当前目录的 `package.json` 中存在 `dist` 和 `dist:self` 脚本。
3. 确认存在 `installer/build-self-installer.ps1`。
4. 不要因为看到项目内残留的旧 `dist` 目录，就把它当作本轮输出目录。

## 成功标准

只有同时满足以下条件才能告诉用户“打包完成”：

1. `npm run dist` 退出码为 `0`。
2. 日志出现 `Self installer built:`。
3. 下列文件存在且大小大于 `0`：

```text
E:\灵犀-11\安装器\installer\灵犀 LingXiCode Installer 1.0.0.exe
E:\灵犀-11\安装器\payload\app.zip
E:\灵犀-11\安装器\dist\win-unpacked\lingxi-lingxicode.exe
```

完成后向用户报告最终安装器的完整路径、文件大小和最后修改时间。

## 出错时怎么处理

- 出现 `Missing app output`：先核对 `package.json` 的 `build.directories.output` 与脚本中的 `$AppDir`，两者都必须指向 `E:\灵犀-11\安装器\dist\win-unpacked`。不要把输出临时改回项目目录。
- 源码路径变化：重新从当前工作区根目录运行，不要继续使用旧路径。
- 只有编译警告但最后出现 `Self installer built:` 且退出码为 `0`：属于成功；仍需检查文件存在且非空。
- 构建失败：必须说明真实报错并继续修复构建链路，不能拿 `win-unpacked` 冒充最终安装器。
