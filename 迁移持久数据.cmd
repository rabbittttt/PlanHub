@echo off
setlocal
cd /d "%~dp0"
"%~dp0..\.venv\Scripts\python.exe" -X utf8 -B scripts\migrate-storage.py integration\storage-migration.example.json
if errorlevel 1 goto end
choice /c YN /m "Services must be stopped. Apply this migration and retain recovery copies"
if errorlevel 2 goto end
"%~dp0..\.venv\Scripts\python.exe" -X utf8 -B scripts\migrate-storage.py integration\storage-migration.example.json --apply
:end
pause
