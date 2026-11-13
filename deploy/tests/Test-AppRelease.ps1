#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$project=Split-Path -Parent $deploy
. (Join-Path $deploy 'App.Release.ps1')
$scratch=Join-Path $project ('artifacts\app-release-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$script:checks=0
function Assert-True { param([bool]$Value,[string]$Message);$script:checks++;if(-not $Value){throw $Message} }
function Reject { param([scriptblock]$Action);$failed=$false;try{& $Action | Out-Null}catch{$failed=$true};Assert-True $failed 'Expected rejection.' }
function Put { param([string]$Path,[string]$Text);New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path)|Out-Null;[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false))) }
try {
    $payload=Join-Path $scratch 'prepared'
    Put (Join-Path $payload 'index.html') '<title>Example</title><script src="assets/tabs.js"></script>'
    Put (Join-Path $payload 'assets\tabs.js') 'const tabs=["first"];'
    $release=Join-Path $scratch 'alpha-v1'
    $args=@{PayloadPath=$payload;Destination=$release;AppId='alpha';Version='v1';Type='static';EntryPoint='index.html';SourceRevision='fixture-v1';DataMode='stateless'}
    & (Join-Path $deploy 'New-AppRelease.ps1') @args -WhatIf | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $release)) 'WhatIf wrote files.'
    & (Join-Path $deploy 'New-AppRelease.ps1') @args | Out-Null
    $valid=Assert-AppRelease $release
    Assert-True ($valid.Files.Count -eq 2) 'Incomplete release.'
    Reject { & (Join-Path $deploy 'New-AppRelease.ps1') @args }
    Put (Join-Path $payload 'assets\tabs.js') 'const tabs=["first","second"];'
    Assert-True ((Get-Content -LiteralPath (Join-Path $release 'payload\assets\tabs.js') -Raw) -notmatch 'second') 'Source edits changed the release.'
    $null=Assert-AppRelease $release
    $args.Destination=Join-Path $scratch 'alpha-v2';$args.Version='v2';$args.SourceRevision='fixture-v2'
    & (Join-Path $deploy 'New-AppRelease.ps1') @args | Out-Null
    $null=Assert-AppRelease $args.Destination
    Assert-True ((Get-Content -LiteralPath (Join-Path $args.Destination 'payload\assets\tabs.js') -Raw) -match 'second') 'New version omitted new tab.'
    Put (Join-Path $release 'payload\undeclared.txt') 'unexpected'
    Reject { Assert-AppRelease $release }
    Remove-Item -LiteralPath (Join-Path $release 'payload\undeclared.txt')
    $html=Join-Path $release 'payload\index.html';$original=[IO.File]::ReadAllText($html)
    Put $html 'mixed-version page';Reject { Assert-AppRelease $release };Put $html $original
    foreach($bad in @('../outside','/absolute','a\b','a:stream','.env','data/sales.json','input_file/raw.txt','output_file/warehouse.db','CON.txt','a./b','foo.sqlite','runtime/python.exe')) { Assert-True (-not (Test-AppReleasePath $bad)) "Unsafe path accepted: $bad" }
    $manifestPath=Join-Path $release 'app-release.json';$saved=[IO.File]::ReadAllText($manifestPath)
    $manifest=$saved|ConvertFrom-Json;$manifest.files+= $manifest.files[0]
    Write-AppReleaseJson $manifestPath $manifest;Reject { Assert-AppRelease $release };Put $manifestPath $saved
    $args.Destination=Join-Path $scratch 'invalid-data-mode';$args.DataMode='external';Reject { & (Join-Path $deploy 'New-AppRelease.ps1') @args -WhatIf };$args.DataMode='stateless'

    Write-Output ('App release integrity checks passed: '+$script:checks)
} finally {
    $resolved=[IO.Path]::GetFullPath($scratch)
    $expected=[IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\')+'\app-release-test-'
    if(-not $resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
