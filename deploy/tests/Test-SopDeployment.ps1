#requires -Version 5.1
[CmdletBinding()]
param([string]$SopSourceRoot = '')
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $deploy
. (Join-Path $deploy 'Deployment.Common.ps1')
. (Join-Path $deploy 'Sop.Common.ps1')
. (Join-Path $deploy 'Sop.Release.ps1')
if (-not $SopSourceRoot) { $SopSourceRoot = $env:SOP_SOURCE_ROOT }
if (-not $SopSourceRoot) { $SopSourceRoot = Join-Path (Split-Path -Parent $project) 'PythonProject\计划看板' }
$SopSourceRoot = [IO.Path]::GetFullPath($SopSourceRoot)
foreach ($required in @('sop_gateway.py', 'scripts\build_release.py', 'integration\iis\SopIdentityBridge.cs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SopSourceRoot $required) -PathType Leaf)) { throw "Specify the authoritative integrated SOP project with SopSourceRoot. Missing: $required" }
}
Assert-NoReparsePoint -Path $SopSourceRoot
$scratch = Join-Path $project ('artifacts\sop-deploy-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
function Assert-True { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }
function Assert-Rejected {
    param([object]$Config)
    $path = Join-Path $scratch 'candidate.json'
    Write-SopJson -Path $path -Value $Config
    $rejected = $false
    try { Read-SopIisConfig -Path $path | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Unsafe SOP deployment configuration was accepted.'
}
try {
    $example = Join-Path $deploy 'sop-iis.example.json'
    $valid = Read-SopIisConfig -Path $example
    Assert-True ($valid.AllowWrites -eq $true) 'Department members must share enabled business writes by default.'
    for ($i = 0; $i -lt 16; $i++) {
        $secret = New-SopProxySecret
        Assert-True ($secret -cmatch '^[A-Za-z0-9_-]{32,256}$') 'Generated secret is incompatible with the Python gateway.'
        Assert-True ($secret.Length -eq 96) 'Expected 48 random bytes encoded as 96 hex characters.'
    }
    $previousSecret = [Environment]::GetEnvironmentVariable('SOP_PROXY_SECRET', 'Process')
    try {
        $env:SOP_PROXY_SECRET = $secret
        $pythonCheck = Join-Path $scratch 'check_generated_secret.py'
        [IO.File]::WriteAllText($pythonCheck, 'import sys; sys.path.insert(0, sys.argv[1]); from sop_gateway import GatewayConfig; config = GatewayConfig.load(sys.argv[2]); assert len(config.proxy_secret) == 96; print("Generated deployment secret accepted by Python GatewayConfig.load")', (New-Object Text.UTF8Encoding($false)))
        & python '-B' $pythonCheck $SopSourceRoot (Join-Path $deploy 'sop.example.json')
        if ($LASTEXITCODE -ne 0) { throw 'Generated proxy secret was rejected by the Python gateway.' }
    }
    finally { [Environment]::SetEnvironmentVariable('SOP_PROXY_SECRET', $previousSecret, 'Process'); $secret = $null }
    foreach ($value in @('true', 'false', 1, 0, @(), $null)) {
        $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
        $invalid.AllowWrites = $value
        Assert-Rejected $invalid
    }
    $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
    $invalid.PSObject.Properties.Remove('AllowWrites')
    Assert-Rejected $invalid
    $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
    $invalid | Add-Member -NotePropertyName WriteGroups -NotePropertyValue @('DOMAIN\Editors')
    Assert-Rejected $invalid
    $paused = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
    $paused.AllowWrites = $false
    $pausedPath = Join-Path $scratch 'paused.json'
    Write-SopJson -Path $pausedPath -Value $paused
    Assert-True (-not (Read-SopIisConfig -Path $pausedPath).AllowWrites) 'Global maintenance pause must remain available.'
    foreach ($value in @('https://data.internal/path', 'https://user:password@data.internal', 'https://data.internal/', 'ftp://data.internal')) {
        $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
        $invalid.PublicOrigin = $value
        Assert-Rejected $invalid
    }
    $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
    $invalid.ProxySecretPath = 'D:\DataPlatform\portal\secret.txt'
    Assert-Rejected $invalid
    $plan = & (Join-Path $deploy 'Configure-SopProxy.ps1') -PlanOnly
    Assert-True (($plan -join "`n") -match 'Offline plan validated') 'Offline plan failed.'
    & (Join-Path $deploy 'Build-SopIdentityBridge.ps1') -OutputDirectory (Join-Path $scratch 'bin') -SourcePath (Join-Path $SopSourceRoot 'integration\iis\SopIdentityBridge.cs') | Out-Null
    $assembly = [Reflection.Assembly]::LoadFile((Join-Path $scratch 'bin\SopIdentityBridge.dll'))
    Assert-True ($null -ne $assembly.GetType('DataPlatform.SopIdentityBridge')) 'Compiled bridge type missing.'
    $releasePath = Join-Path $scratch 'sop-runtime'
    & python '-B' (Join-Path $SopSourceRoot 'scripts\build_release.py') '--destination' $releasePath
    if ($LASTEXITCODE -ne 0) { throw 'Authoritative SOP runtime build failed.' }
    $release = Assert-SopRelease -Path $releasePath
    Assert-True ($release.Manifest.appId -ceq 'hima-sop') 'Built artifact is not a SOP release.'
    $packConfig = Get-Content -LiteralPath (Join-Path $deploy 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $packConfig.StaticApplications = @()
    $packConfigPath = Join-Path $scratch 'iis.json'
    Write-SopJson -Path $packConfigPath -Value $packConfig
    $packageRoot = Join-Path $scratch 'package'
    & (Join-Path $deploy 'New-DeploymentPackage.ps1') -Destination $packageRoot -ConfigPath $packConfigPath -IncludeSop -SopReleasePath $releasePath | Out-Null
    $packaged = Assert-SopRelease -Path (Join-Path $packageRoot 'services\sop')
    Assert-True ($packaged.Manifest.sourceCommit -eq $release.Manifest.sourceCommit) 'SOP source provenance changed during portal packaging.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'deploy\sop-upstream.patch'))) 'Obsolete SOP patch was packaged.'
    & (Join-Path $deploy 'Install-SopDependencies.ps1') -DeploymentRoot $packageRoot -WhatIf | Out-Null
    & (Join-Path $deploy 'Register-SopTask.ps1') -DeploymentRoot $packageRoot -ServiceAccount 'DOMAIN\svc-sop' | Out-Null
    $tamper = Join-Path $releasePath 'web\index.html'
    [IO.File]::AppendAllText($tamper, 'tamper')
    $rejected = $false
    try { Assert-SopRelease -Path $releasePath | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Tampered SOP artifact was accepted.'
    Write-Output 'SOP source-owned build, manifest checks, packaging, offline checksums, PS5.1 plans and C# compilation passed. No IIS/task changes were made.'
}
finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $intended = [IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\') + '\sop-deploy-test-'
    if (-not $resolved.StartsWith($intended, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected test cleanup path.' }
    # The compiled assembly remains loaded in PS5.1; cleanup may be deferred until
    # this test process ends. The test directory stays ignored under artifacts/.
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Write-Output 'The ignored test directory can be removed after this PowerShell process exits.' }
}
