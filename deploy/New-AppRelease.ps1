#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$PayloadPath,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$AppId,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][ValidateSet('static','service')][string]$Type,
    [Parameter(Mandatory=$true)][string]$EntryPoint,
    [Parameter(Mandatory=$true)][string]$SourceRevision,
    [Parameter(Mandatory=$true)][ValidateSet('external','stateless')][string]$DataMode,
    [string]$HealthPath='/'
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'App.Release.ps1')
$source = (Get-Item -LiteralPath $PayloadPath).FullName.TrimEnd('\','/')
$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination).TrimEnd('\','/')
if (Test-Path -LiteralPath $target) { throw 'Use a new version directory; destination already exists.' }
if ($target -eq $source -or $target.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Release destination must be outside the payload.' }
$manifest = New-AppManifest -PayloadPath $source -AppId $AppId -Version $Version -Type $Type -EntryPoint $EntryPoint -SourceRevision $SourceRevision -DataMode $DataMode -HealthPath $HealthPath
Write-Output "Validated $AppId $Version ($Type). Copies prepared artifacts only; does not build, start or deploy the app."
if ($PSCmdlet.ShouldProcess($target,'Create new independent release envelope')) {
    $release = [pscustomobject]@{Manifest=$manifest;Files=(Assert-AppPayload $source $manifest)}
    $null = Copy-ValidatedRelease $release $target
    Write-Output "Release created: $target"
}
