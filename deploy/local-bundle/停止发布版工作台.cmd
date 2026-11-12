@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
node "%~dp0_launcher\start-release.mjs" stop --bundle "%~dp0." %*
set "planhub_exit=%errorlevel%"
if not "%planhub_exit%"=="0" pause
popd
exit /b %planhub_exit%
