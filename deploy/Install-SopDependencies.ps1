#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [string]$PythonPath = 'python'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
$root = [IO.Path]::GetFullPath($DeploymentRoot)
Assert-NoReparsePoint -Path $root
$release = Assert-SopRelease -Path (Join-Path $root 'services\sop')
$wheelRoot = Join-Path $root 'offline\wheels'
$requirements = Join-Path $release.Root 'requirements-intranet.txt'
$venv = Join-Path $root 'runtime\sop-venv'
foreach ($required in @($requirements, (Join-Path $wheelRoot 'SHA256SUMS'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing offline dependency input: $required" }
}
$expected = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $wheelRoot 'SHA256SUMS') -Encoding UTF8) {
    if ($line -notmatch '^([a-fA-F0-9]{64})  ([A-Za-z0-9_.-]+\.whl)$') { throw 'Invalid SHA256SUMS line.' }
    if ($expected.ContainsKey($matches[2])) { throw 'Duplicate wheel checksum entry.' }
    $expected[$matches[2]] = $matches[1].ToLowerInvariant()
}
if ($expected.Count -lt 1) { throw 'The offline wheel checksum manifest is empty.' }
foreach ($wheel in Get-ChildItem -LiteralPath $wheelRoot -File -Filter '*.whl') {
    if (-not $expected.ContainsKey($wheel.Name)) { throw "Undeclared offline wheel: $($wheel.Name)" }
}
foreach ($name in $expected.Keys) {
    $wheel = Join-Path $wheelRoot $name
    $stream = [IO.File]::OpenRead($wheel)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
    if ($actual -ne $expected[$name]) { throw "Offline wheel checksum mismatch: $name" }
}
Write-Output 'Offline wheel checksums passed. Dependency versions come from the SOP release requirements; no package index will be contacted.'
if ($PSCmdlet.ShouldProcess($venv, 'Create SOP virtual environment and install pinned offline requirements')) {
    & $PythonPath '-c' 'import sys; sys.exit(sys.version_info < (3, 10))'
    if ($LASTEXITCODE -ne 0) { throw 'A working Python 3.10+ installation is required.' }
    & $PythonPath '-m' 'venv' $venv
    if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed.' }
    $python = Join-Path $venv 'Scripts\python.exe'
    & $python '-m' 'pip' '--isolated' 'install' '--no-index' '--disable-pip-version-check' '--find-links' $wheelRoot '-r' $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Offline dependency installation failed.' }
    Write-Output "SOP Python runtime ready: $python"
}
