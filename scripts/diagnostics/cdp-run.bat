@echo off
cd /d "%~dp0..\.."
start "electron-debug" /min cmd /c "npx electron . --remote-debugging-port=9222 2>nul"
echo Waiting for Electron to start...
timeout /t 8 /nobreak >nul
echo Running CDP test...
node "%~dp0cdp-test.js"
echo Done.
taskkill /fi "WINDOWTITLE eq electron-debug*" /f >nul 2>nul
