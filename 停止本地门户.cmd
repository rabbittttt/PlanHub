@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node scripts\stop-local.mjs %*
set "portal_exit=%errorlevel%"
if not "%portal_exit%"=="0" pause
endlocal & exit /b %portal_exit%
