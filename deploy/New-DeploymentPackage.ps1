#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$ConfigPath = '',
    [switch]$IncludeSop,
    [string]$SopReleasePath = '',
    [string]$AppReleasesPath = '',
    [switch]$RequireComplete
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'config.example.json' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
. (Join-Path $PSScriptRoot 'App.Release.ps1')
$config = Read-DeploymentConfig -Path $ConfigPath
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\portal'))
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Use a new release directory; no files will be overwritten.' }
if ($target.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must not be inside portal source.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'index.html') -PathType Leaf)) { throw 'portal/index.html is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'config\apps.json') -PathType Leaf)) { throw 'portal/config/apps.json is missing.' }
Assert-NoReparsePoint -Path $source
$ancestor = Split-Path -Parent $target
while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
Assert-NoReparsePoint -Path $ancestor
$entries = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
$appSources = @{}
$sopRelease = $null
if ($IncludeSop) {
    if (-not $SopReleasePath) { throw 'IncludeSop requires an explicit SopReleasePath built by the authoritative SOP project.' }
    $sopRelease = Assert-SopRelease -Path $SopReleasePath
    if ($target -eq $sopRelease.Root -or $target.StartsWith($sopRelease.Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must not be inside the input SOP release.' }
} elseif ($SopReleasePath) { throw 'SopReleasePath requires IncludeSop.' }
# Generic inputs are explicit release envelopes, never discovery of live project folders.
$registry = Get-Content -LiteralPath (Join-Path $source 'config\apps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$readyApps = @($registry.groups | ForEach-Object { $_.apps } | Where-Object { $_.enabled -and $_.status -eq 'ready' })
$generic = @{}
if ($AppReleasesPath) {
    $mapFile = (Get-Item -LiteralPath $AppReleasesPath).FullName
    $map = Get-Content -LiteralPath $mapFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $map.PSObject.Properties['applications'] -or $map.applications -isnot [Array]) { throw 'Release map requires an applications array.' }
    foreach ($binding in $map.applications) {
        if ($null -eq $binding.PSObject.Properties['id'] -or $null -eq $binding.PSObject.Properties['release'] -or $binding.release -isnot [string]) { throw 'Release binding requires id and release.' }
        $id = [string]$binding.id
        if ($id -eq 'sop') { throw 'SOP retains its original validated format; use IncludeSop and SopReleasePath.' }
        if ($generic.ContainsKey($id)) { throw "Duplicate release: $id" }
        $registered = @($readyApps | Where-Object { $_.id -ceq $id -and $_.url -ceq "/$id/" })
        if ($registered.Count -ne 1) { throw "Release must match one ready application and its fixed prefix: $id" }
        $releasePath = Resolve-LocalDeploymentPath $binding.release (Split-Path -Parent $mapFile) 'application release'
        $release = Assert-AppRelease $releasePath
        if ($release.Manifest.appId -cne $id) { throw "Release ID mismatch: $id" }
        if ($target -eq $release.Root -or $target.StartsWith($release.Root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be outside every input release.' }
        $static = @($config.StaticApplications | Where-Object { $_.Name -ceq $id -and $_.Enabled })
        if (($release.Manifest.type -ceq 'static') -ne ($static.Count -eq 1)) { throw "Static/service deployment mapping differs: $id" }
        $generic[$id] = $release
    }
}
$staticManifests = @{}
$packageVersion = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($app in $config.StaticApplications | Where-Object { $_.Enabled }) {
    if ($generic.ContainsKey($app.Name)) { continue }
    $appSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\apps\' + $app.Name)))
    if (-not (Test-Path -LiteralPath (Join-Path $appSource 'index.html') -PathType Leaf)) { throw "Enabled app release is missing index.html: $appSource" }
    Assert-NoReparsePoint -Path $appSource
    $entries += @(Get-ChildItem -LiteralPath $appSource -Recurse -Force)
    $appSources[$app.Name] = $appSource
    $staticManifests[$app.Name] = New-AppManifest -PayloadPath $appSource -AppId $app.Name -Version $packageVersion -Type static -EntryPoint index.html -SourceRevision 'collected-static-artifact' -DataMode stateless
}
foreach ($entry in $entries) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Portal source contains a reparse point: $($entry.Name)" }
    if ($entry.Name -in @('.git', '.env', 'node_modules', '.aws', '.codex')) { throw "Portal source contains a non-public entry: $($entry.Name)" }
}
$inventory = @()
foreach ($app in $readyApps) {
    $id = $app.id
    if ($id -eq 'sop' -and $IncludeSop) {
        $inventory += [ordered]@{id=$id;delivery='included';format='sop';root='services/sop';manifest='services/sop/sop-release.json'}
    } elseif ($generic.ContainsKey($id) -or $staticManifests.ContainsKey($id)) {
        $manifest = if ($generic.ContainsKey($id)) { $generic[$id].Manifest } else { $staticManifests[$id] }
        $folder = if ($manifest.type -eq 'static') { 'apps' } else { 'services' }
        $inventory += [ordered]@{id=$id;delivery='included';format='app';type=$manifest.type;version=$manifest.version;root="$folder/$id";manifest="config/app-releases/$id.json"}
    } else {
        $inventory += [ordered]@{id=$id;delivery='external';format=$null;root=$null;manifest=$null}
    }
}
$missing = @($inventory | Where-Object { $_.delivery -eq 'external' } | ForEach-Object { $_.id })
if ($missing.Count) {
    if ($RequireComplete) { throw ('Missing independent releases for ready apps: ' + ($missing -join ', ')) }
    Write-Warning ('Partial package; these ready apps require separate releases/services: ' + ($missing -join ', '))
}
if ($PSCmdlet.ShouldProcess($target, 'Create new portal deployment package')) {
    foreach ($folder in @('portal', 'apps', 'services', 'data', 'logs', 'config', 'deploy', 'docs')) {
        New-Item -ItemType Directory -Path (Join-Path $target $folder) -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'portal') -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portal.web.config') -Destination (Join-Path $target 'portal\web.config') -Force
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $target 'config\iis.json')
    foreach ($template in @('quicklook.example.json', 'quicklook-iis.example.json')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $template) -Destination (Join-Path $target ('config\' + $template))
    }
    Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.ps1', '.xml', '.config', '.json', '.cs') -and $_.Name -notlike '*.local.*' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'deploy')
    }
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\docs') -File -Filter '*.md' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'docs')
    }
    New-Item -ItemType Directory -Path (Join-Path $target 'config\app-releases') | Out-Null
    foreach ($app in $config.StaticApplications) {
        if ($generic.ContainsKey($app.Name)) { continue }
        $destinationApp = Join-Path $target ('apps\' + $app.Name)
        if ($app.Enabled) {
            $release = [pscustomobject]@{Manifest=$staticManifests[$app.Name];Files=(Assert-AppPayload $appSources[$app.Name] $staticManifests[$app.Name])}
            Copy-AppPayload -Release $release -Destination $destinationApp
            Write-AppReleaseJson -Path (Join-Path $target ('config\app-releases\' + $app.Name + '.json')) -Value $release.Manifest
        } else { New-Item -ItemType Directory -Path $destinationApp | Out-Null }
    }
    foreach ($id in $generic.Keys) {
        $release = $generic[$id]
        $folder = if ($release.Manifest.type -eq 'static') { 'apps' } else { 'services' }
        Copy-AppPayload -Release $release -Destination (Join-Path $target ("$folder\$id"))
        Write-AppReleaseJson -Path (Join-Path $target ("config\app-releases\$id.json")) -Value $release.Manifest
    }
    Write-AppReleaseJson -Path (Join-Path $target 'config\release-inventory.json') -Value ([ordered]@{schemaVersion=1;version=$packageVersion;applications=@($inventory)})
    if ($IncludeSop) {
        # This directory is an immutable deployment artifact, not portal-owned
        # business source. Its provenance and exact contents come from SOP.
        foreach ($relative in $sopRelease.Files.Keys) {
            $destinationFile = Join-Path $target ('services\sop\' + $relative.Replace('/', '\'))
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationFile) | Out-Null
            Copy-Item -LiteralPath $sopRelease.Files[$relative] -Destination $destinationFile
        }
        Copy-Item -LiteralPath (Join-Path $sopRelease.Root 'sop-release.json') -Destination (Join-Path $target 'services\sop\sop-release.json')
        $null = Assert-SopRelease -Path (Join-Path $target 'services\sop')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'sop.example.json') -Destination (Join-Path $target 'config\sop.example.json')
        $wheelSource = Join-Path $PSScriptRoot '..\offline\wheels'
        if (Test-Path -LiteralPath $wheelSource) {
            Assert-NoReparsePoint -Path $wheelSource
            $wheels = @(Get-ChildItem -LiteralPath $wheelSource -File | Where-Object { $_.Extension -eq '.whl' -or $_.Name -eq 'SHA256SUMS' })
            if ($wheels.Count) {
                New-Item -ItemType Directory -Force -Path (Join-Path $target 'offline\wheels') | Out-Null
                $wheels | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'offline\wheels') }
            }
        }
    }
    $quicklookWheels = Join-Path $PSScriptRoot '..\offline\quicklook-wheels'
    if (Test-Path -LiteralPath $quicklookWheels) {
        Assert-NoReparsePoint -Path $quicklookWheels
        $wheelFiles = @(Get-ChildItem -LiteralPath $quicklookWheels -File | Where-Object { $_.Extension -eq '.whl' -or $_.Name -eq 'SHA256SUMS' })
        if ($wheelFiles.Count) {
            $wheelDestination = Join-Path $target 'offline\quicklook-wheels'
            New-Item -ItemType Directory -Force -Path $wheelDestination | Out-Null
            foreach ($wheel in $wheelFiles) {
                Assert-NoReparsePoint -Path $wheel.FullName
                Copy-Item -LiteralPath $wheel.FullName -Destination $wheelDestination
            }
        }
    }
    & (Join-Path $PSScriptRoot 'Test-DeploymentPackage.ps1') -DeploymentRoot $target -RequireComplete:$RequireComplete
    Write-Output "Package created: $target"
    Write-Output "Enabled static artifacts copied. External SOP release included: $IncludeSop. Business data and credentials are not copied."
    if ($IncludeSop) { Write-Output "SOP release source commit: $($sopRelease.Manifest.sourceCommit); source dirty: $($sopRelease.Manifest.sourceDirty)" }
    Write-Output "Configured server destination: $($config.DeploymentRoot)"
    Write-Output 'See config/release-inventory.json for included and external applications. No service was started, IIS changed, or data migrated.'
}
