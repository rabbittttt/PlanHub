#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $deploy
. (Join-Path $deploy 'App.Release.ps1')
$scratch = Join-Path $project ('artifacts\local-bundle-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scratch)
$script:checks = 0
function Check([bool]$Value, [string]$Message) { $script:checks++;if (-not $Value) { throw $Message } }
function Reject([scriptblock]$Action) { $failed = $false;try { & $Action | Out-Null } catch { $failed = $true };Check $failed 'Expected local bundle rejection.' }
function Put([string]$Path, [string]$Text) { [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }
function Make-Release([string]$Id, [string]$Version, [string]$Type, $Registry = $null) {
    $prepared = Join-Path $scratch ('prepared-' + $Id + '-' + $Version)
    $entry = if ($Type -eq 'static') { 'index.html' } else { 'server.py' }
    Put (Join-Path $prepared $entry) ('fixture ' + $Id + ' ' + $Version)
    if ($null -ne $Registry) { [void][IO.Directory]::CreateDirectory((Join-Path $prepared 'config'));Write-AppReleaseJson (Join-Path $prepared 'config/apps.json') $Registry }
    $mode = if ($Type -eq 'static') { 'stateless' } else { 'external' }
    $health = if ($Type -eq 'static') { '/' } else { '/healthz' }
    $manifest = New-AppManifest -PayloadPath $prepared -AppId $Id -Version $Version -Type $Type -EntryPoint $entry -SourceRevision fixture -DataMode $mode -HealthPath $health
    $releasePath = Join-Path $scratch ('inputs/' + $Id + '-' + $Version)
    $release = [pscustomobject]@{Manifest = $manifest;Files = (Assert-AppPayload $prepared $manifest)}
    $null = Copy-ValidatedRelease $release $releasePath
    # Distinct formatting detects accidental manifest JSON reserialization.
    [IO.File]::AppendAllText((Join-Path $releasePath 'app-release.json'), "`r`n`r`n", (New-Object Text.UTF8Encoding($false)))
    return $releasePath
}
$workspace = Join-Path $scratch 'workspace'
$fixtureDeploy = Join-Path $workspace 'deploy'
[void][IO.Directory]::CreateDirectory($fixtureDeploy)
foreach ($name in @('New-LocalBundle.ps1', 'Publish.Common.ps1', 'App.Release.ps1', 'Deployment.Common.ps1', 'Sop.Release.ps1')) { Copy-Item -LiteralPath (Join-Path $deploy $name) -Destination $fixtureDeploy }
$templateNames = @('启动发布版工作台.cmd', '停止发布版工作台.cmd', 'local.runtime.example.json')
foreach ($name in $templateNames) { Put (Join-Path $fixtureDeploy ('local-bundle/' + $name)) ('fixture template ' + $name) }
$scriptNames = @('start-release.mjs', 'dev-server.mjs', 'app-integrations.mjs', 'proxy-request.mjs', 'portal-instance.mjs', 'service-process.mjs', 'health-check.mjs')
foreach ($name in $scriptNames) { Put (Join-Path $workspace ('scripts/' + $name)) ('// fixture launcher ' + $name) }
Put (Join-Path $workspace 'scripts/not-allowlisted.mjs') '// must not be shipped'
Put (Join-Path $workspace 'config.local/private.json') '{"private":"must not be shipped"}'
$registry = @{groups = @(@{apps = @(@{id = 'alpha';enabled = $true;status = 'ready'}, @{id = 'beta';enabled = $true;status = 'pending'}, @{id = 'disabled';enabled = $false})})}
$portal = Make-Release planhub portal1 static $registry
$alpha = Make-Release alpha a1 static
$beta = Make-Release beta b2 service
$releasePaths = @($beta, $portal, $alpha)
$bundleScript = Join-Path $fixtureDeploy 'New-LocalBundle.ps1'
$target = Join-Path $scratch 'complete-bundle'
$sourceManifestHash = (Get-FileHash -LiteralPath (Join-Path $portal 'app-release.json') -Algorithm SHA256).Hash

& $bundleScript -ReleasePaths $releasePaths -Destination $target -WhatIf | Out-Null
Check (-not (Test-Path -LiteralPath $target)) 'WhatIf wrote a bundle.'
$result = & $bundleScript -ReleasePaths $releasePaths -Destination $target
Check ($result.bundlePath -eq $target -and $result.applications.Count -eq 3) 'Bundle result omitted its location or applications.'
$bundle = Get-Content -LiteralPath (Join-Path $target 'bundle.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Check ($bundle.schemaVersion -eq 1 -and @($bundle.applications.PSObject.Properties).Count -eq 3) 'Invalid bundle index.'
Check ($bundle.applications.planhub.release -eq 'releases/planhub/portal1') 'Portal release mapping is incorrect.'
Check ($bundle.applications.beta.release -eq 'releases/beta/b2') 'Enabled pending application was omitted.'
foreach ($source in $releasePaths) {
    $original = Assert-AppRelease $source
    $copied = Join-Path $target ('releases/' + $original.Manifest.appId + '/' + $original.Manifest.version)
    $null = Assert-AppRelease $copied
    Check ((Get-FileHash -LiteralPath (Join-Path $source 'app-release.json') -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath (Join-Path $copied 'app-release.json') -Algorithm SHA256).Hash) 'Release manifest bytes were changed.'
    foreach ($path in $original.Files.Keys) {
        Check ((Get-FileHash -LiteralPath $original.Files[$path] -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath (Join-Path $copied ('payload/' + $path)) -Algorithm SHA256).Hash) 'Release payload bytes were changed.'
    }
}
foreach ($name in $templateNames) { Check ((Get-Content -LiteralPath (Join-Path $target $name) -Raw -Encoding UTF8) -eq ('fixture template ' + $name)) 'A launcher template was omitted or changed.' }
foreach ($name in $scriptNames) { Check (Test-Path -LiteralPath (Join-Path $target ('_launcher/' + $name)) -PathType Leaf) 'An allowlisted launcher module was omitted.' }
foreach ($privatePath in @('config.local', 'data', 'logs', '_launcher/not-allowlisted.mjs', 'releases/disabled')) { Check (-not (Test-Path -LiteralPath (Join-Path $target $privatePath))) 'Private or unrequested content was copied.' }
Check ((Get-FileHash -LiteralPath (Join-Path $portal 'app-release.json') -Algorithm SHA256).Hash -eq $sourceManifestHash) 'Input release was rewritten.'
Reject { & $bundleScript -ReleasePaths $releasePaths -Destination $target }
Check (Test-Path -LiteralPath (Join-Path $target 'bundle.json')) 'Rejecting an existing destination altered it.'
Reject { & $bundleScript -ReleasePaths @($alpha, $beta) -Destination (Join-Path $scratch 'no-portal') }
Reject { & $bundleScript -ReleasePaths @($portal, $alpha) -Destination (Join-Path $scratch 'missing-enabled') }
Check (-not (Test-Path -LiteralPath (Join-Path $scratch 'missing-enabled'))) 'Incomplete bundle created an output directory.'
Reject { & $bundleScript -ReleasePaths @($portal, $alpha, $beta, $alpha) -Destination (Join-Path $scratch 'duplicate') }
$anotherPortal = Make-Release planhub portal2 static $registry
Reject { & $bundleScript -ReleasePaths @($portal, $anotherPortal, $alpha, $beta) -Destination (Join-Path $scratch 'two-portals') }
$servicePortal = Make-Release planhub service service
Reject { & $bundleScript -ReleasePaths @($servicePortal, $alpha, $beta) -Destination (Join-Path $scratch 'service-portal') }
$noRegistry = Make-Release planhub no-registry static
Reject { & $bundleScript -ReleasePaths @($noRegistry) -Destination (Join-Path $scratch 'no-registry') }
$disabled = Make-Release disabled d1 static
Reject { & $bundleScript -ReleasePaths @($portal, $alpha, $beta, $disabled) -Destination (Join-Path $scratch 'disabled-extra') }
Reject { & $bundleScript -ReleasePaths $releasePaths -Destination (Join-Path $alpha 'nested-bundle') }
Reject { & $bundleScript -ReleasePaths $releasePaths -Destination (Join-Path $workspace 'scripts/nested-bundle') }

$badRegistry = Make-Release planhub bad-registry static @{groups = @(@{apps = @(@{id = 'alpha';enabled = 'true'})})}
Reject { & $bundleScript -ReleasePaths @($badRegistry, $alpha) -Destination (Join-Path $scratch 'bad-registry') }
$duplicateRegistry = Make-Release planhub duplicate-registry static @{groups = @(@{apps = @(@{id = 'alpha';enabled = $true}, @{id = 'alpha';enabled = $false})})}
Reject { & $bundleScript -ReleasePaths @($duplicateRegistry, $alpha) -Destination (Join-Path $scratch 'duplicate-registry') }
$alphaIndex = Join-Path $alpha 'payload/index.html'
$savedAlpha = [IO.File]::ReadAllText($alphaIndex)
Put $alphaIndex 'tampered release'
Reject { & $bundleScript -ReleasePaths $releasePaths -Destination (Join-Path $scratch 'tampered') }
Put $alphaIndex $savedAlpha
Put (Join-Path $beta 'payload/data/private.db') 'do not ship'
Reject { & $bundleScript -ReleasePaths $releasePaths -Destination (Join-Path $scratch 'private-input') }

$emptyRegistry = Make-Release planhub standalone static @{groups = @()}
Put (Join-Path $fixtureDeploy 'local-bundle/extra.secret') 'do not ship'
Reject { & $bundleScript -ReleasePaths @($emptyRegistry) -Destination (Join-Path $scratch 'extra-template') }
Remove-Item -LiteralPath (Join-Path $fixtureDeploy 'local-bundle/extra.secret')
Put (Join-Path $fixtureDeploy 'local-bundle/nested/hidden.txt') 'unexpected template tree'
Reject { & $bundleScript -ReleasePaths @($emptyRegistry) -Destination (Join-Path $scratch 'template-directory') }
Remove-Item -LiteralPath (Join-Path $fixtureDeploy 'local-bundle/nested/hidden.txt')
Remove-Item -LiteralPath (Join-Path $fixtureDeploy 'local-bundle/nested')
$module = Join-Path $workspace 'scripts/health-check.mjs'
Remove-Item -LiteralPath $module
Reject { & $bundleScript -ReleasePaths @($emptyRegistry) -Destination (Join-Path $scratch 'missing-module') }
Check (-not (Test-Path -LiteralPath (Join-Path $scratch 'missing-module'))) 'Missing launcher input created an output directory.'
Put $module '// fixture launcher health-check.mjs'
$standaloneResult = & $bundleScript -ReleasePaths @($emptyRegistry) -Destination (Join-Path $scratch 'standalone')
Check ($standaloneResult.applications.Count -eq 1) 'Portal without enabled apps failed.'
Write-Output ("Local bundle checks passed: $script:checks. Fixtures retained at $scratch")
