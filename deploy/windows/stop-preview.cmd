@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0preview.ps1" -Action Stop %*
set "result=%errorlevel%"
if not "%result%"=="0" (pause)
endlocal & exit /b %result%
