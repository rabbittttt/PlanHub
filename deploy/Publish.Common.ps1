#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'App.Release.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')

function Get-PublishValue {
    param($Object,[string]$Name,$Default=$null)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}
function Resolve-PublishPath {
    param([string]$Value,[string]$Base)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A filesystem path is required.' }
    if ($Value -match '^[A-Za-z]:[^\\/]' -or $Value -match '^[\\/][^\\/]') { throw 'Drive-relative and root-relative paths are not supported.' }
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value).TrimEnd('\','/') }
    return [IO.Path]::GetFullPath((Join-Path $Base $Value)).TrimEnd('\','/')
}
function Assert-PublishVersion {
    param([string]$Version)
    if ($Version -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' -or $Version -match '[. ]$') { throw 'Invalid version. Use letters, digits, dots, underscores or hyphens.' }
}
function Assert-PublishId {
    param([string]$AppId)
    if ($AppId -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $AppId -in @('api','home','portal','config','assets','css','js','data','services','deploy','logs','tests')) { throw 'Invalid application ID.' }
}
function Copy-ValidatedRelease {
    param($Release,[string]$Destination)
    Copy-AppPayload -Release $Release -Destination (Join-Path $Destination 'payload')
    Write-AppReleaseJson (Join-Path $Destination 'app-release.json') $Release.Manifest
    return Assert-AppRelease $Destination
}
function Get-PublishRevision {
    param([string]$Source)
    $result = & git -C $Source rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $result) { throw 'Cannot determine source Git revision. Configure sourceRevision explicitly for a non-Git payload.' }
    $dirty = & git -C $Source status --porcelain --untracked-files=normal 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine source Git status.' }
    return ([string]$result).Trim() + $(if($dirty){'-dirty'}else{''})
}
