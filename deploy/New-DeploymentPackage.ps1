#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$ConfigPath = '',
    [switch]$IncludeSop,
    [string]$SopReleasePath = ''
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'config.example.json' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
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
foreach ($app in $config.StaticApplications | Where-Object { $_.Enabled }) {
    $appSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\apps\' + $app.Name)))
    if (-not (Test-Path -LiteralPath (Join-Path $appSource 'index.html') -PathType Leaf)) { throw "Enabled app release is missing index.html: $appSource" }
    Assert-NoReparsePoint -Path $appSource
    $entries += @(Get-ChildItem -LiteralPath $appSource -Recurse -Force)
    $appSources[$app.Name] = $appSource
}
foreach ($entry in $entries) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Portal source contains a reparse point: $($entry.Name)" }
    if ($entry.Name -in @('.git', '.env', 'node_modules', '.aws', '.codex')) { throw "Portal source contains a non-public entry: $($entry.Name)" }
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
    Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.ps1', '.xml', '.config', '.json') -and $_.Name -notlike '*.local.*' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'deploy')
    }
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\docs') -File -Filter '*.md' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'docs')
    }
    foreach ($app in $config.StaticApplications) {
        New-Item -ItemType Directory -Path (Join-Path $target ('apps\' + $app.Name)) -Force | Out-Null
        if ($app.Enabled) {
            Get-ChildItem -LiteralPath $appSources[$app.Name] -Force | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target ('apps\' + $app.Name)) -Recurse
            }
        }
    }
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
    Write-Output "Package created: $target"
    Write-Output "Enabled static artifacts copied. External SOP release included: $IncludeSop. Business data and credentials are not copied."
    if ($IncludeSop) { Write-Output "SOP release source commit: $($sopRelease.Manifest.sourceCommit); source dirty: $($sopRelease.Manifest.sourceDirty)" }
    Write-Output "Configured server destination: $($config.DeploymentRoot)"
    Write-Output 'Quicklook server tools and templates included. Deploy its independent project separately; its source and persistent data are not copied.'
}
