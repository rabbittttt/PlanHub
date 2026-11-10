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
node scripts\register-app.mjs %*
set "portal_exit=%errorlevel%"
pause
endlocal & exit /b %portal_exit%