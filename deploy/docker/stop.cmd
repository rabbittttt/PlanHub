@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0deploy.ps1" -Action Stop %*
set "result=%errorlevel%"
if not "%result%"=="0" (pause)
endlocal & exit /b %result%
