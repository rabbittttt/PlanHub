#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [int]$Port = 0
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DeploymentRoot)
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
Assert-NoReparsePoint -Path $root
$release = Assert-SopRelease -Path (Join-Path $root 'services\sop')
$gatewayPath = Join-Path $root 'config\sop.json'
$authPath = Join-Path $root 'config\sop-auth.json'
$auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
$gateway = Get-Content -LiteralPath $gatewayPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Port -eq 0) { $Port = [int]$auth.BackendPort }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'The configured SOP backend port is invalid.' }
if ($gateway.proxy_secret_env -ne 'SOP_PROXY_SECRET') { throw 'Gateway secret environment variable must be SOP_PROXY_SECRET.' }
if ([bool]$gateway.allow_writes -ne (@($auth.WriteGroups).Count -gt 0)) { throw 'Gateway write switch and IIS write group configuration disagree.' }
if ($gateway.public_origin -ne $auth.PublicOrigin) { throw 'Gateway and IIS bridge public origins disagree.' }
$secret = [IO.File]::ReadAllText([string]$auth.ProxySecretPath).Trim()
if ($secret -cnotmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'Gateway secret file is invalid.' }
foreach ($required in @($gateway.shared_config)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required deployment input is missing: $required" }
}
$sales = Join-Path ([string]$gateway.data_dir) 'sales.json'
$sources = @(Get-ChildItem -LiteralPath ([string]$gateway.source_dir) -File -Filter '*.xlsx' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '~$*' })
if (-not (Test-Path -LiteralPath $sales -PathType Leaf) -and -not $sources.Count) { throw 'SOP requires a validated sales.json snapshot or real source workbooks. Empty source directories cannot initialize production data.' }
$python = Join-Path $root 'runtime\sop-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Install the SOP offline Python virtual environment first.' }
$logs = Join-Path $root 'logs\sop'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$env:SOP_PROXY_SECRET = $secret
$env:SOP_EXCEL_ENGINE = 'python'
$secret = $null
try {
    # Keep the child in this foreground task process. Scheduler observes its exit
    # and applies restart policy. No secrets appear in command arguments.
    & $python '-B' (Join-Path $release.Root 'server.py') '--host' '127.0.0.1' '--port' $Port '--gateway-config' $gatewayPath *>> (Join-Path $logs 'service.log')
    if ($LASTEXITCODE -ne 0) { throw "SOP process exited with code $LASTEXITCODE." }
}
finally { Remove-Item Env:\SOP_PROXY_SECRET -ErrorAction SilentlyContinue }
