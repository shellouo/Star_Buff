@echo off
setlocal
cd /d "%~dp0"

echo [1/2] Start Core (buff monitor)...
start "Core" cmd /k node app\buff_monitor_cli.js live

echo [2/2] Start Overlay HTTP server (Python)...
start "Overlay" cmd /k node tools\serve_overlay.js



REM 给服务器 0.6 秒启动时间（避免浏览器打开太快404）
echo.
echo If it doesn't open, manually visit:
echo http://127.0.0.1:3000/overlay.html
echo.
pause
