@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
echo 正在后台启动本地门户及已配置的业务服务...
node scripts\start-background.mjs %*
set "portal_exit=%errorlevel%"
if not "%portal_exit%"=="0" (
  echo.
  echo 启动存在异常，请查看上方提示和日志；此窗口不会自动关闭。
  pause
)
endlocal & exit /b %portal_exit%
