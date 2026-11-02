#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $deploy
. (Join-Path $deploy 'Deployment.Common.ps1')
. (Join-Path $deploy 'Sop.Common.ps1')
. (Join-Path $deploy 'Sop.Release.ps1')
$scratch = Join-Path $project ('artifacts\sop-release-validation-' + [Guid]::NewGuid().ToString('N'))
$release = Join-Path $scratch 'release'
New-Item -ItemType Directory -Force -Path $release | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$manifest = [ordered]@{ schemaVersion = 1; appId = 'hima-sop'; sourceCommit = ('0' * 40); sourceDirty = $false; files = @() }
foreach ($name in @('server.py', 'sop_gateway.py', 'requirements.txt', 'requirements-intranet.txt', 'web/index.html', 'integration/iis/SopIdentityBridge.cs')) {
    $file = Join-Path $release ($name.Replace('/', '\'))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    [IO.File]::WriteAllText($file, 'fixture ' + $name, $utf8)
    $manifest.files += [ordered]@{ path = $name; sha256 = (Get-SopFileSha256 -Path $file); bytes = (Get-Item -LiteralPath $file).Length }
}
$manifestPath = Join-Path $release 'sop-release.json'
function Save-Manifest { Write-SopJson -Path $manifestPath -Value $manifest }
function Expect-Rejected {
    $rejected = $false
    try { Assert-SopRelease -Path $release | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unsafe SOP artifact was accepted.' }
}
try {
    Save-Manifest
    $valid = Assert-SopRelease -Path $release
    if ($valid.Files.Count -ne 6) { throw 'Valid release was not loaded completely.' }
    $extra = Join-Path $release 'private.secret'
    [IO.File]::WriteAllText($extra, 'fixture-not-a-real-secret', $utf8)
    Expect-Rejected
    Remove-Item -LiteralPath $extra
    $web = Join-Path $release 'web\index.html'
    [IO.File]::AppendAllText($web, 'tamper')
    Expect-Rejected
    [IO.File]::WriteAllText($web, 'fixture web/index.html', $utf8)
    $saved = $manifest.files[0].path
    $manifest.files[0].path = '../outside.py'
    Save-Manifest
    Expect-Rejected
    $manifest.files[0].path = $saved
    $manifest.files += $manifest.files[0]
    Save-Manifest
    Expect-Rejected
    $manifest.files = @($manifest.files | Select-Object -First 6)
    Save-Manifest
    $runtime = Join-Path $release 'runtime'
    New-Item -ItemType Directory -Path $runtime | Out-Null
    Expect-Rejected
    Remove-Item -LiteralPath $runtime
    $null = Assert-SopRelease -Path $release
    $rejected = $false
    try { & (Join-Path $deploy 'New-DeploymentPackage.ps1') -Destination (Join-Path $scratch 'missing-release-package') -IncludeSop -WhatIf | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Portal packaging silently accepted a missing explicit SOP release.' }
    Write-Output 'SOP manifest checks passed: explicit release, hashes, undeclared files/directories, traversal and duplicate paths.'
}
finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $expected = [IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\') + '\sop-release-validation-'
    if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
