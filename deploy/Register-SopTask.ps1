#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [Parameter(Mandatory = $true)][string]$ServiceAccount,
    [string]$TaskName = 'DataPlatform-SOP',
    [int]$Port = 0,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DeploymentRoot)
if ($root -notmatch '^[A-Za-z]:\\' -or $root.Length -le 3 -or $root.Contains('"')) { throw 'DeploymentRoot must be an absolute local directory.' }
if ($ServiceAccount -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$' -or $ServiceAccount -match '(?i)(^|\\)(SYSTEM|LocalSystem|Administrators)$') { throw 'Use an explicit least-privilege DOMAIN\ServiceAccount, not SYSTEM or Administrators.' }
if ($TaskName -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid task name.' }
if ($Port -lt 0 -or $Port -gt 65535) { throw 'Invalid backend port override; 0 uses the protected SOP configuration.' }
$launcher = Join-Path $root 'deploy\Start-SopService.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The packaged SOP service launcher is missing.' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
$release = Assert-SopRelease -Path (Join-Path $root 'services\sop')
$shell = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $launcher + '" -DeploymentRoot "' + $root + '" -Port ' + $Port
Write-Output "Task: $TaskName; account: $ServiceAccount; backend port: $Port"
if ($Port -eq 0) { Write-Output 'Backend port 0 means read BackendPort from protected config/sop-auth.json when starting.' }
Write-Output 'Startup trigger, hidden launcher, one instance, retry after failure, no execution time limit.'
Write-Output 'S4U logon stores no password and cannot access network shares. Data/source files must be local to this server.'
if (-not $Apply) { Write-Output 'Plan only. No task has been registered or started.'; return }
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register new stopped SOP background task with S4U service account')) { return }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'A task with this name already exists. Review it rather than replacing it automatically.' }
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $release.Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Output 'SOP task registered, not started. Grant Log on as a batch job and local folder permissions, then start it for acceptance.'
