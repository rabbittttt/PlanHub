@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "log=%~dp0migration-last.log"
>"%log%" echo Migration started %date% %time%
if not errorlevel 1 goto ready
set "log=%TEMP%\planhub-migration-last.log"
>"%log%" echo Migration started %date% %time%
if errorlevel 1 goto log_failed

:ready
if not exist "%~dp0..\.venv\Scripts\python.exe" goto no_python
"%~dp0..\.venv\Scripts\python.exe" -X utf8 -u -B "%~dp0scripts\migration-menu.py" 2>>"%log%"
set "result=%errorlevel%"
if "%result%"=="10" goto storage
if "%result%"=="11" goto shared
if not "%result%"=="0" type "%log%"
goto done

:storage
set "migration=scripts\migrate-storage.py integration\storage-migration.example.json"
goto apply

:shared
set "migration=scripts\migrate-shared.py"

:apply
pushd "%~dp0" || goto project_failed
echo Applying migration...
>>"%log%" echo Applying %migration%
"..\.venv\Scripts\python.exe" -X utf8 -u -B %migration% --apply >>"%log%" 2>&1
set "result=%errorlevel%"
popd
type "%log%"
goto done

:project_failed
>>"%log%" echo Could not open project directory: "%~dp0"
type "%log%"
set "result=1"
goto done

:no_python
>>"%log%" echo Python not found: "%~dp0..\.venv\Scripts\python.exe"
type "%log%"
set "result=1"

:done
echo Log: "%log%"
goto close_window

:log_failed
echo Could not write a migration log in the project folder or TEMP.
set "result=1"

:close_window
"%SystemRoot%\System32\choice.exe" /c Q /n /m "Press Q to close."
exit /b %result%
