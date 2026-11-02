#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$ConfigPath = '',
    [switch]$IncludeSop
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'config.example.json' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
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
$sopSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\services\sop'))
$sopFiles = @()
if ($IncludeSop) {
    foreach ($required in @('server.py', 'sop_gateway.py', 'requirements.txt', 'web\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sopSource $required) -PathType Leaf)) { throw "SOP source is incomplete: $required" }
    }
    Assert-NoReparsePoint -Path $sopSource
    $sopFiles = @(Get-ChildItem -LiteralPath $sopSource -File | Where-Object { $_.Extension -eq '.py' -or $_.Name -in @('requirements.txt', 'requirements-intranet.txt') })
    $sopFiles += @(Get-ChildItem -LiteralPath (Join-Path $sopSource 'web') -Recurse -File)
    $sopFiles += @(Get-ChildItem -LiteralPath (Join-Path $sopSource 'scripts') -File | Where-Object { $_.Extension -eq '.mjs' })
    $entries += $sopFiles
}
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
    Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.ps1', '.xml', '.config', '.json', '.cs', '.patch') -and $_.Name -notlike '*.local.*' } | ForEach-Object {
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
        foreach ($file in $sopFiles) {
            $relative = $file.FullName.Substring($sopSource.Length + 1)
            $destinationFile = Join-Path $target ('services\sop\' + $relative)
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationFile) | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destinationFile
        }
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
    Write-Output "Package created: $target"
    Write-Output "Enabled static artifacts copied. SOP source included: $IncludeSop. Business runtime data and credentials are not copied."
    Write-Output "Configured server destination: $($config.DeploymentRoot)"
}
