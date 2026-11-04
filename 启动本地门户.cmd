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
echo 正在启动本地门户、SOP 与数据速查服务，请保留此窗口。
node scripts\start-local.mjs %*
set "portal_exit=%errorlevel%"
if not "%portal_exit%"=="0" (
  echo.
  echo 启动未完成，请根据上方提示处理后重新打开。
  pause
)
endlocal & exit /b %portal_exit%
