@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "entered="
chcp 65001 >nul
set "log=%~dp0migration-last.log"
>"%log%" echo Migration started %date% %time%
if not errorlevel 1 goto open_project
set "log=%TEMP%\planhub-migration-last.log"
>"%log%" echo Migration started %date% %time%
if errorlevel 1 goto log_failed

:open_project
pushd "%~dp0" 2>>"%log%"
if errorlevel 1 goto failed
set "entered=1"
set "python=..\.venv\Scripts\python.exe"
if exist "%python%" goto menu
>>"%log%" echo 找不到打包电脑的 Python，请检查 "%~dp0..\.venv\Scripts\python.exe"
goto failed

:menu
echo 1. 迁移旧应用数据库
echo 2. 迁移旧共享目录
choice /c 12 /m "请选择" 2>>"%log%"
if errorlevel 3 goto input_failed
if errorlevel 2 goto shared
if not errorlevel 1 goto input_failed
set "migration=scripts\migrate-storage.py integration\storage-migration.example.json"
goto plan

:shared
set "migration=scripts\migrate-shared.py"

:plan
>>"%log%" echo 核对迁移计划 %migration%
"%python%" -X utf8 -u -B %migration% >>"%log%" 2>&1
if errorlevel 1 goto failed
type "%log%"
choice /c YN /m "已停止服务并确认执行迁移？" 2>>"%log%"
if errorlevel 3 goto input_failed
if errorlevel 2 goto done
if not errorlevel 1 goto input_failed
>>"%log%" echo 正在执行迁移
echo 正在执行迁移，请等待结果。
"%python%" -X utf8 -u -B %migration% --apply >>"%log%" 2>&1
if errorlevel 1 goto failed
type "%log%"
echo 迁移命令已完成。

:done
echo 日志 "%log%"
choice /c Q /n /m "按 Q 关闭窗口。"
popd
exit /b 0

:input_failed
>>"%log%" echo 无法读取菜单选择。

:failed
type "%log%"
echo 操作失败。完整日志 "%log%"
goto wait_for_close

:log_failed
echo 无法在脚本目录或临时目录创建日志。请检查写入权限。

:wait_for_close
choice /c Q /n /m "按 Q 关闭窗口。"
if defined entered popd
exit /b 1
