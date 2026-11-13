@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0preview.ps1" -Action Start -Snapshot %*
set "result=%errorlevel%"
if not "%result%"=="0" (pause) else (
  start "" "http://127.0.0.1:4173/"
  timeout /t 3 /nobreak >nul
)
endlocal & exit /b %result%
