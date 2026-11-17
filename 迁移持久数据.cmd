@echo off
setlocal
cd /d "%~dp0"
echo 1. Migrate legacy application databases
echo 2. Migrate legacy shared folder to centralized storage
choice /c 12 /m "Select migration"
if errorlevel 2 goto shared
set "migration=scripts\migrate-storage.py integration\storage-migration.example.json"
goto plan
:shared
set "migration=scripts\migrate-shared.py"
:plan
"%~dp0..\.venv\Scripts\python.exe" -X utf8 -B %migration%
if errorlevel 1 goto end
choice /c YN /m "Services must be stopped. Apply and retain recovery copies"
if errorlevel 2 goto end
"%~dp0..\.venv\Scripts\python.exe" -X utf8 -B %migration% --apply
:end
pause
