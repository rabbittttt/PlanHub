@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0deploy\Deploy-Interactive.ps1" %*
set "planhub_exit=%errorlevel%"
if not "%planhub_exit%"=="0" echo 部署未完成，请保留上方错误信息。业务数据未被发布包覆盖。
popd
pause
exit /b %planhub_exit%
