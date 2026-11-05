#requires -Version 5.1
[CmdletBinding()]
param([string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Quicklook.Common.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\config\quicklook.json' }
$config = Read-QuicklookConfig -Path $ConfigPath
Assert-QuicklookProject -Config $config
if (-not (Test-Path -LiteralPath $config.PythonPath -PathType Leaf)) { throw 'Install the configured QuickLook Python runtime first.' }
Assert-NoReparsePoint -Path $config.PythonPath
if ($config.SharedDataRoot -and -not (Test-Path -LiteralPath $config.SharedDataRoot -PathType Container)) { throw 'The configured QuickLook shared data root does not exist. Migrate the approved data separately before starting.' }
# Do not attach to, stop, or replace an unowned listener on the fixed application
# port. The original service itself also binds exclusively on Windows.
$probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $config.BackendPort)
try { $probe.Start() } catch { throw 'QuickLook port 8765 is already occupied. Stop the known service through its owner before starting this task.' }
finally { $probe.Stop() }
Assert-QuicklookExistingAncestor -Path $config.LogDirectory
foreach ($name in @('service.out.log', 'service.err.log')) {
    Assert-QuicklookExistingAncestor -Path (Join-Path $config.LogDirectory $name)
}
New-Item -ItemType Directory -Force -Path $config.LogDirectory | Out-Null
$previousShared = [Environment]::GetEnvironmentVariable('SHARED_DATA_ROOT', 'Process')
$previousEncoding = [Environment]::GetEnvironmentVariable('PYTHONIOENCODING', 'Process')
try {
    if ($config.SharedDataRoot) { $env:SHARED_DATA_ROOT = $config.SharedDataRoot }
    else { Remove-Item Env:\SHARED_DATA_ROOT -ErrorAction SilentlyContinue }
    $env:PYTHONIOENCODING = 'utf-8'
    Push-Location -LiteralPath $config.ProjectRoot
    try {
        # Foreground invocation lets Task Scheduler observe the process exit.
        # No app-specific security mode, data copy, or HTML injection is added.
        $ErrorActionPreference = 'Continue'
        & $config.PythonPath '-B' '-u' (Join-Path $config.ProjectRoot 'server.py') 1>> (Join-Path $config.LogDirectory 'service.out.log') 2>> (Join-Path $config.LogDirectory 'service.err.log')
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($exitCode -ne 0) { throw "QuickLook process exited with code $exitCode. Check logs/quicklook/service.err.log." }
    }
    finally { $ErrorActionPreference = 'Stop'; Pop-Location }
}
finally {
    [Environment]::SetEnvironmentVariable('SHARED_DATA_ROOT', $previousShared, 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', $previousEncoding, 'Process')
}
