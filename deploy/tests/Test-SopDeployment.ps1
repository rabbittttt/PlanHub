#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $deploy
. (Join-Path $deploy 'Sop.Common.ps1')
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
    Assert-True ($valid.WriteGroups.Count -eq 0) 'Default write groups must be empty.'
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
        & python $pythonCheck (Join-Path $project 'services\sop') (Join-Path $deploy 'sop.example.json')
        if ($LASTEXITCODE -ne 0) { throw 'Generated proxy secret was rejected by the Python gateway.' }
    }
    finally { [Environment]::SetEnvironmentVariable('SOP_PROXY_SECRET', $previousSecret, 'Process'); $secret = $null }
    foreach ($value in @('Editors', '*', 'DOMAIN\*', 'DOMAIN\Editors,Everyone', ' DOMAIN\Editors')) {
        $invalid = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json
        $invalid.WriteGroups = @($value)
        Assert-Rejected $invalid
    }
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
    & (Join-Path $deploy 'Build-SopIdentityBridge.ps1') -OutputDirectory (Join-Path $scratch 'bin') | Out-Null
    $assembly = [Reflection.Assembly]::LoadFile((Join-Path $scratch 'bin\SopIdentityBridge.dll'))
    Assert-True ($null -ne $assembly.GetType('DataPlatform.SopIdentityBridge')) 'Compiled bridge type missing.'
    & (Join-Path $deploy 'Install-SopDependencies.ps1') -DeploymentRoot $project -WhatIf | Out-Null
    & (Join-Path $deploy 'Register-SopTask.ps1') -DeploymentRoot $project -ServiceAccount 'DOMAIN\svc-sop' | Out-Null
    Write-Output 'SOP deployment configuration, offline checksums, PS5.1 plans and C# compilation passed. No IIS/task changes were made.'
}
finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $intended = [IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\') + '\sop-deploy-test-'
    if (-not $resolved.StartsWith($intended, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected test cleanup path.' }
    # The compiled assembly remains loaded in PS5.1; cleanup may be deferred until
    # this test process ends. The test directory stays ignored under artifacts/.
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Write-Output 'The ignored test directory can be removed after this PowerShell process exits.' }
}
