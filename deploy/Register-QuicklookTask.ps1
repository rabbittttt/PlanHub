#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = '',
    [Parameter(Mandatory = $true)][string]$ServiceAccount,
    [string]$TaskName = 'DataPlatform-Quicklook',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Quicklook.Common.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\config\quicklook.json' }
$config = Read-QuicklookConfig -Path $ConfigPath
Assert-QuicklookProject -Config $config
if ($ServiceAccount -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$' -or $ServiceAccount -match '(?i)(^|\\)(SYSTEM|LocalSystem|Administrators)$') { throw 'Use an explicit least-privilege DOMAIN\ServiceAccount, not SYSTEM or Administrators.' }
if ($TaskName -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid task name.' }
$launcher = Join-Path $config.DeploymentRoot 'deploy\Start-QuicklookService.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Packaged QuickLook service launcher is missing.' }
Assert-NoReparsePoint -Path $launcher
$shell = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $launcher + '" -ConfigPath "' + $config.ConfigPath + '"'
Write-Output "Task: $TaskName; account: $ServiceAccount; fixed loopback port: 8765"
Write-Output "Project: $($config.ProjectRoot); runtime: $($config.RuntimePath); logs: $($config.LogDirectory)"
Write-Output 'Startup trigger, hidden launcher, one instance, retry after failure, no execution time limit.'
Write-Output 'S4U stores no password and cannot access network shares or mapped drives. Review all saved workspace.json source folders as well as SharedDataRoot. No business data is migrated.'
if (-not $Apply) { Write-Output 'Plan only. No task has been registered or started.'; return }
if (-not (Test-Path -LiteralPath $config.PythonPath -PathType Leaf)) { throw 'Install the QuickLook runtime before registering a task.' }
if ($config.SharedDataRoot -and -not (Test-Path -LiteralPath $config.SharedDataRoot -PathType Container)) { throw 'The configured shared data root is missing.' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply requires administrator rights.' }
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register new stopped QuickLook background task with S4U service account')) { return }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'A task with this name already exists. Review it instead of replacing it automatically.' }
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $config.ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal | Out-Null
Write-Output 'QuickLook task registered, not started. Grant batch logon and required local permissions (read code/runtime; modify output_file, selected import folders, and logs), then start for acceptance.'
