#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string[]]$ReleasePaths,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Publish.Common.ps1')

function Test-LocalBundleWithin([string]$Root, [string]$Path) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Get-LocalBundleFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Local bundle launcher input is missing: $Path" }
    Assert-NoReparsePoint -Path $Path
    return [pscustomobject]@{Source = $Path;Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash}
}
function Copy-LocalBundleFile($InputFile, [string]$Path) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::Copy($InputFile.Source, $Path, $false)
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -cne $InputFile.Hash) { throw 'A local bundle input changed while copying. No completed bundle was published.' }
}

if (-not $ReleasePaths.Count) { throw 'Provide the explicit independent releases for this bundle.' }
$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination).TrimEnd('\', '/')
if (-not $target -or $target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\', '/')) { throw 'Destination must be a new directory below a filesystem root.' }
if (Test-Path -LiteralPath $target) { throw 'Local bundle destination already exists. Use a new version directory; nothing will be overwritten.' }
$releases = @{}
foreach ($path in $ReleasePaths) {
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'ReleasePaths must not contain empty paths.' }
    $release = Assert-AppRelease -Path $path
    $id = $release.Manifest.appId
    if ($releases.ContainsKey($id)) { throw "More than one release was supplied for application: $id" }
    if (Test-LocalBundleWithin $release.Root $target) { throw 'Local bundle destination must be outside every input release.' }
    $releases[$id] = [pscustomobject]@{Release = $release;ManifestFile = (Get-LocalBundleFile (Join-Path $release.Root 'app-release.json'))}
}
if (-not $releases.ContainsKey('planhub')) { throw 'The local bundle requires exactly one planhub release.' }
$portal = $releases['planhub'].Release
if ($portal.Manifest.type -cne 'static') { throw 'The planhub release must be static.' }
if (-not $portal.Files.ContainsKey('config/apps.json')) { throw 'The planhub release must include config/apps.json.' }
$registry = Get-Content -LiteralPath $portal.Files['config/apps.json'] -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $registry -or $null -eq $registry.PSObject.Properties['groups'] -or $registry.groups -isnot [Array]) { throw 'The packaged portal registry requires a groups array.' }
$required = [ordered]@{planhub = $true}
$registered = @{}
foreach ($group in $registry.groups) {
    if ($null -eq $group -or $null -eq $group.PSObject.Properties['apps'] -or $group.apps -isnot [Array]) { throw 'Each packaged portal group requires an apps array.' }
    foreach ($app in $group.apps) {
        if ($null -eq $app -or $null -eq $app.PSObject.Properties['id'] -or $app.id -isnot [string] -or $app.id -ceq 'planhub') { throw 'Invalid application in the packaged portal registry.' }
        Assert-PublishId $app.id
        if ($registered.ContainsKey($app.id)) { throw "Duplicate application in the packaged portal registry: $($app.id)" }
        if ($null -eq $app.PSObject.Properties['enabled'] -or $app.enabled -isnot [bool]) { throw 'Packaged portal applications must declare boolean enabled values.' }
        $registered[$app.id] = $true
        if ($app.enabled) { $required[$app.id] = $true }
    }
}
$missing = @($required.Keys | Where-Object { -not $releases.ContainsKey($_) })
if ($missing.Count) { throw ('The local bundle is missing enabled applications: ' + ($missing -join ', ')) }
$extra = @($releases.Keys | Where-Object { -not $required.Contains($_) })
if ($extra.Count) { throw ('Releases are not enabled in the packaged portal: ' + ($extra -join ', ')) }

$templateRoot = Join-Path $PSScriptRoot 'local-bundle'
if (-not (Test-Path -LiteralPath $templateRoot -PathType Container)) { throw 'The local bundle launcher template directory is missing.' }
Assert-NoReparsePoint -Path $templateRoot
$templateNames = @('启动发布版工作台.cmd', '停止发布版工作台.cmd', 'local.runtime.example.json')
$templateEntries = @(Get-ChildItem -LiteralPath $templateRoot -Force)
if ($templateEntries.Count -ne $templateNames.Count -or @($templateEntries | Where-Object { $_.PSIsContainer -or $_.Name -cnotin $templateNames }).Count) { throw 'The local bundle template must contain only its three declared launcher files.' }
$files = [ordered]@{}
foreach ($name in $templateNames) { $files[$name] = Get-LocalBundleFile (Join-Path $templateRoot $name) }
$scriptRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts'
$scriptNames = @('start-release.mjs', 'dev-server.mjs', 'app-integrations.mjs', 'proxy-request.mjs', 'portal-instance.mjs', 'service-process.mjs', 'health-check.mjs')
foreach ($name in $scriptNames) { $files['_launcher/' + $name] = Get-LocalBundleFile (Join-Path $scriptRoot $name) }
foreach ($inputRoot in @($templateRoot, $scriptRoot)) {
    if (Test-LocalBundleWithin ([IO.Path]::GetFullPath($inputRoot)) $target) { throw 'Local bundle destination must be outside its launcher inputs.' }
}
$parent = Split-Path -Parent $target
$ancestor = $parent
while (-not (Test-Path -LiteralPath $ancestor)) {
    $next = Split-Path -Parent $ancestor
    if (-not $next -or $next -eq $ancestor) { throw 'Cannot locate an existing filesystem ancestor for Destination.' }
    $ancestor = $next
}
Assert-NoReparsePoint -Path $ancestor
Write-Host ('Validated local bundle applications: ' + ($required.Keys -join ', '))
if (-not $PSCmdlet.ShouldProcess($target, 'Create a new local bundle from the explicitly validated releases and launcher files')) { return }

$staging = $null
try {
    [void][IO.Directory]::CreateDirectory($parent)
    Assert-NoReparsePoint -Path $parent
    $staging = Join-Path $parent ('.local-bundle-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($staging)
    $applications = [ordered]@{}
    foreach ($id in $required.Keys) {
        $inputRelease = $releases[$id]
        $release = $inputRelease.Release
        $relative = 'releases/' + $id + '/' + $release.Manifest.version
        $destinationRelease = Join-Path $staging $relative
        Copy-AppPayload -Release $release -Destination (Join-Path $destinationRelease 'payload')
        Copy-LocalBundleFile $inputRelease.ManifestFile (Join-Path $destinationRelease 'app-release.json')
        $null = Assert-AppRelease -Path $destinationRelease
        $applications[$id] = [ordered]@{release = $relative}
    }
    foreach ($relative in $files.Keys) { Copy-LocalBundleFile $files[$relative] (Join-Path $staging $relative) }
    Write-AppReleaseJson (Join-Path $staging 'bundle.json') ([ordered]@{schemaVersion = 1;applications = $applications})
    # Directory.Move fails on a concurrent destination instead of replacing it.
    [IO.Directory]::Move($staging, $target)
} catch {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Write-Warning ('Local bundle creation failed. Unpublished temporary files were retained for diagnosis: ' + $staging) }
    throw
}
Write-Host ('Local bundle created: ' + $target)
[pscustomobject]@{bundlePath = $target;applications = @($required.Keys)}
