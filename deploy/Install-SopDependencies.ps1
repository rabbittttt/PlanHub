#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [string]$PythonPath = 'python'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
$root = [IO.Path]::GetFullPath($DeploymentRoot)
Assert-NoReparsePoint -Path $root
$wheelRoot = Join-Path $root 'offline\wheels'
$requirements = Join-Path $root 'services\sop\requirements-intranet.txt'
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
if ($expected.Count -ne 2 -or -not ($expected.Keys | Where-Object { $_ -like 'openpyxl-3.1.5-*' }) -or -not ($expected.Keys | Where-Object { $_ -like 'et_xmlfile-2.0.0-*' })) { throw 'Expected only the pinned openpyxl 3.1.5 and et_xmlfile 2.0.0 wheels.' }
foreach ($name in $expected.Keys) {
    $wheel = Join-Path $wheelRoot $name
    $stream = [IO.File]::OpenRead($wheel)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
    if ($actual -ne $expected[$name]) { throw "Offline wheel checksum mismatch: $name" }
}
Write-Output 'Pinned offline wheel checksums passed. No package index will be contacted.'
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
