@echo off
chcp 65001 >nul
title 灵犀 LingXiCode 开发模式

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     灵犀 LingXiCode 开发模式启动      ║
echo  ║     支持 DevTools 调试               ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [错误] 未检测到 Node.js
    pause
    exit /b 1
)

:: 检查依赖
if not exist "node_modules\.bin\electron.cmd" (
    echo  [提示] 正在安装依赖...
    call npm install --proxy=false --https-proxy=false
    if %errorlevel% neq 0 (
        echo  [错误] 依赖安装失败，请检查网络或 npm 配置
        pause
        exit /b 1
    )
)

:: 开发模式启动（带 DevTools）
echo  [启动] 开发模式启动中...
echo  [提示] 按 Ctrl+Shift+I 打开 DevTools
echo.

call "node_modules\.bin\electron.cmd" . --devtools

pause