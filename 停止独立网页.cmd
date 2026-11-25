@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-standalone.ps1" %*
set "standalone_exit=%errorlevel%"
if not "%standalone_exit%"=="0" pause
exit /b %standalone_exit%
