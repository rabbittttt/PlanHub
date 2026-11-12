#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RuntimeConfig)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Runtime.Release.ps1')
$runtime = Get-Content -LiteralPath $RuntimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$release = Assert-AppRelease (Split-Path -Parent $runtime.payload)
if ($release.Manifest.appId -cne $runtime.appId -or $release.Manifest.version -cne $runtime.version) { throw 'Active service and release manifest differ.' }
if ($runtime.appId -ceq 'sop') {
    Assert-SopRuntimeConsistency -Root ([string]$runtime.root) -Definition $runtime.definition -RequireInitialized
}
$command = Resolve-LocalDeploymentPath $runtime.definition.command $runtime.root 'command'
$changed=@{}
try {
    foreach ($item in $runtime.definition.environment.PSObject.Properties) {
        $changed[$item.Name]=[Environment]::GetEnvironmentVariable($item.Name,'Process')
        [Environment]::SetEnvironmentVariable($item.Name,(Expand-RunValue $item.Value $runtime),'Process')
    }
    $secrets=Get-Setting $runtime.definition 'secretEnvironmentFiles' ([pscustomobject]@{})
    foreach ($item in $secrets.PSObject.Properties) {
        $changed[$item.Name]=[Environment]::GetEnvironmentVariable($item.Name,'Process')
        $secretPath=Resolve-LocalDeploymentPath $item.Value $runtime.root 'secret file'
        [Environment]::SetEnvironmentVariable($item.Name,([IO.File]::ReadAllText($secretPath).Trim()),'Process')
    }
    $arguments=@($runtime.definition.arguments | ForEach-Object { Expand-RunValue $_ $runtime })
    $logRoot=Join-Path $runtime.root ('logs\'+$runtime.appId)
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Set-Location -LiteralPath $runtime.payload
    & $command @arguments *>> (Join-Path $logRoot 'service.log')
    if ($LASTEXITCODE -ne 0) { throw "Service exited with code $LASTEXITCODE. See $logRoot" }
} finally {
    foreach ($name in $changed.Keys) { [Environment]::SetEnvironmentVariable($name,$changed[$name],'Process') }
}
