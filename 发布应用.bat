@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0deploy\Publish-App.ps1" %*
set "publish_exit=%errorlevel%"
if not "%publish_exit%"=="0" echo 发布操作未完成，请查看上方具体错误。不会因为已生成或传送包就视为上线。
pause
endlocal & exit /b %publish_exit%
