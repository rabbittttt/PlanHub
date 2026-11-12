@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
node "%~dp0_launcher\start-release.mjs" start --bundle "%~dp0." %*
set "planhub_exit=%errorlevel%"
if not "%planhub_exit%"=="0" (
  echo 启动未完成，请查看上方配置或日志路径。
  pause
)
popd
exit /b %planhub_exit%
