#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DeploymentRoot, [switch]$RequireComplete)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'App.Release.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
$root=(Get-Item -LiteralPath $DeploymentRoot).FullName
Assert-NoReparsePoint $root
$inventoryPath=Join-Path $root 'config\release-inventory.json'
Assert-NoReparsePoint $inventoryPath
$inventory=Get-Content -LiteralPath $inventoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($inventory.schemaVersion -ne 1 -or $inventory.applications -isnot [Array]) { throw 'Unsupported release inventory.' }
$seen=@{}
foreach ($app in $inventory.applications) {
    if ($app.id -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $seen.ContainsKey($app.id)) { throw 'Invalid inventory ID.' }
    $seen[$app.id]=$true
    if ($app.delivery -eq 'external') {
        if ($RequireComplete) { throw "Application release not included: $($app.id)" }
        Write-Output "EXTERNAL: $($app.id) (not validated or deployed by this package)"
        continue
    }
    if ($app.delivery -cne 'included') { throw 'Invalid delivery status.' }
    if ($app.format -ceq 'sop' -and $app.id -ceq 'sop') {
        if ($app.root -cne 'services/sop' -or $app.manifest -cne 'services/sop/sop-release.json') { throw 'Invalid SOP inventory path.' }
        $null=Assert-SopRelease (Join-Path $root 'services\sop')
    } elseif ($app.format -ceq 'app') {
        if ($app.type -cnotin @('static','service')) { throw 'Invalid application type.' }
        $folder=if ($app.type -ceq 'static') { 'apps' } else { 'services' }
        if ($app.root -cne "$folder/$($app.id)" -or $app.manifest -cne "config/app-releases/$($app.id).json") { throw 'Invalid inventory path.' }
        $manifestPath=Join-Path $root $app.manifest
        Assert-NoReparsePoint $manifestPath
        $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.appId -cne $app.id -or $manifest.version -cne $app.version -or $manifest.type -cne $app.type) { throw 'Inventory and manifest differ.' }
        $null=Assert-AppPayload -Path (Join-Path $root $app.root) -Manifest $manifest
    } else { throw 'Unsupported inventory format.' }
    Write-Output "VERIFIED: $($app.id)"
}
$registry=Get-Content -LiteralPath (Join-Path $root 'portal\config\apps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($app in @($registry.groups | ForEach-Object { $_.apps } | Where-Object { $_.enabled -and $_.status -eq 'ready' })) {
    if (-not $seen.ContainsKey($app.id)) { throw "Ready app missing from inventory: $($app.id)" }
}
Write-Output 'Artifact checks passed. Service restarts, data compatibility and IIS acceptance still require the release procedure.'
