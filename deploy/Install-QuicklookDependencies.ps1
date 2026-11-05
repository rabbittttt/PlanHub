#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = '',
    [string]$PythonPath = 'python',
    [string]$WheelPath = '',
    [switch]$Online
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Quicklook.Common.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\config\quicklook.json' }
$config = Read-QuicklookConfig -Path $ConfigPath
Assert-QuicklookProject -Config $config
$requirements = Join-Path $config.ProjectRoot 'requirements.txt'
if (Test-Path -LiteralPath $config.RuntimePath) { throw 'RuntimePath already exists. Stop the service and select a new runtime directory rather than replacing a running environment.' }
if ($Online -and $WheelPath) { throw 'Online and WheelPath cannot be combined.' }
if (-not $Online) {
    if (-not $WheelPath) { $WheelPath = 'offline/quicklook-wheels' }
    $WheelPath = Resolve-QuicklookPath $WheelPath $config.DeploymentRoot 'WheelPath'
    Assert-QuicklookWheels -Path $WheelPath
}
Write-Output "Independent requirements: $requirements"
Write-Output "New runtime: $($config.RuntimePath)"
if ($Online) { Write-Output 'Explicit online mode: pip will use its default package index. Review source requirements and selected dependency versions before publishing.' }
else { Write-Output 'Offline wheel checksums passed. No package index will be contacted.' }
if (-not $PSCmdlet.ShouldProcess($config.RuntimePath, 'Create QuickLook Python environment and install the independent project requirements')) { return }
& $PythonPath '-B' '-c' 'import sys; sys.exit(sys.version_info < (3, 11))'
if ($LASTEXITCODE -ne 0) { throw 'A working Python 3.11+ installation is required.' }
& $PythonPath '-m' 'venv' $config.RuntimePath
if ($LASTEXITCODE -ne 0) { throw 'QuickLook virtual environment creation failed.' }
$pipArgs = @('-m', 'pip', '--isolated', 'install', '--disable-pip-version-check')
if (-not $Online) { $pipArgs += @('--no-index', '--find-links', $WheelPath) }
$pipArgs += @('-r', $requirements)
& $config.PythonPath @pipArgs
if ($LASTEXITCODE -ne 0) { throw 'QuickLook dependency installation failed. The new environment was retained for diagnosis; it was not activated as a service.' }
& $config.PythonPath '-m' 'pip' 'check'
if ($LASTEXITCODE -ne 0) { throw 'QuickLook dependency consistency check failed.' }
Write-Output "QuickLook runtime ready: $($config.PythonPath). No service or IIS configuration was changed."
