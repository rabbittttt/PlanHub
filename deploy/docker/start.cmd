@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0deploy.ps1" -Action Start %*
set "result=%errorlevel%"
if not "%result%"=="0" (pause) else (timeout /t 3 /nobreak >nul)
endlocal & exit /b %result%
