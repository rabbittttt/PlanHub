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

    # A separate fixture workspace exercises the real bundle script without real reports/data.
    $workspace=Join-Path $scratch 'workspace'
    $fixtureDeploy=Join-Path $workspace 'deploy'
    New-Item -ItemType Directory -Path $fixtureDeploy | Out-Null
    Get-ChildItem -LiteralPath $deploy -File | Where-Object { $_.Extension -in @('.ps1','.json','.config','.xml') -and $_.Name -notlike '*.local.*' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $fixtureDeploy }
    Put (Join-Path $workspace 'portal\index.html') '<title>Portal fixture</title>'
    Put (Join-Path $workspace 'docs\README.md') 'fixture'
    $registry=@{groups=@(@{apps=@(@{id='alpha';url='/alpha/';enabled=$true;status='ready'},@{id='beta';url='/beta/';enabled=$true;status='ready'})})}
    Write-AppReleaseJson (Join-Path $workspace 'portal\config.json') $registry
    New-Item -ItemType Directory -Path (Join-Path $workspace 'portal\config') | Out-Null
    Write-AppReleaseJson (Join-Path $workspace 'portal\config\apps.json') $registry
    Put (Join-Path $workspace 'apps\alpha\index.html') '<title>Collected static</title>'
    $config=@{SiteName='Fixture';ApplicationPool='Fixture';DeploymentRoot='..';HostName='';Port=8080;RequireReverseProxy=$false;StaticApplications=@(@{Name='alpha';Enabled=$true})}
    $configPath=Join-Path $fixtureDeploy 'fixture.json';Write-AppReleaseJson $configPath $config
    $bundle=Join-Path $scratch 'bundle'
    $packArgs=@{Destination=$bundle;ConfigPath=$configPath}
    Reject { & (Join-Path $fixtureDeploy 'New-DeploymentPackage.ps1') @packArgs -RequireComplete }
    Assert-True (-not(Test-Path -LiteralPath $bundle)) 'Incomplete strict package created files.'
    $partial=Join-Path $scratch 'partial-bundle'
    & (Join-Path $fixtureDeploy 'New-DeploymentPackage.ps1') -Destination $partial -ConfigPath $configPath | Out-Null
    & (Join-Path $partial 'deploy\Test-DeploymentPackage.ps1') -DeploymentRoot $partial | Out-Null
    Reject { & (Join-Path $partial 'deploy\Test-DeploymentPackage.ps1') -DeploymentRoot $partial -RequireComplete }
    $partialInventory=Get-Content -LiteralPath (Join-Path $partial 'config\release-inventory.json') -Raw | ConvertFrom-Json
    Assert-True (@($partialInventory.applications | Where-Object { $_.id -eq 'beta' -and $_.delivery -eq 'external' }).Count -eq 1) 'Partial delivery was hidden.'
    $dynamic=Join-Path $scratch 'dynamic-prepared'
    Put (Join-Path $dynamic 'server.py') '# fixture backend v2 with new route; never executed'
    Put (Join-Path $dynamic 'web\index.html') '<title>New tab</title>'
    $dynamicRelease=Join-Path $scratch 'beta-v2'
    & (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $dynamic -Destination $dynamicRelease -AppId beta -Version v2 -Type service -EntryPoint server.py -SourceRevision fixture-v2 -DataMode external -HealthPath /health | Out-Null
    Put (Join-Path $scratch 'business-data\sentinel.txt') 'persistent data untouched'
    $mapPath=Join-Path $scratch 'releases.json'
    Write-AppReleaseJson $mapPath @{applications=@(@{id='beta';release='./beta-v2'},@{id='alpha';release='./alpha-v2'})}
    $packArgs.AppReleasesPath=$mapPath
    & (Join-Path $fixtureDeploy 'New-DeploymentPackage.ps1') @packArgs -RequireComplete -WhatIf | Out-Null
    Assert-True (-not(Test-Path -LiteralPath $bundle)) 'Bundle WhatIf wrote files.'
    & (Join-Path $fixtureDeploy 'New-DeploymentPackage.ps1') @packArgs -RequireComplete | Out-Null
    & (Join-Path $bundle 'deploy\Test-DeploymentPackage.ps1') -DeploymentRoot $bundle -RequireComplete | Out-Null
    Assert-True ((Get-Content -LiteralPath (Join-Path $bundle 'apps\alpha\assets\tabs.js') -Raw) -match 'second') 'Explicit static release was not used.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $bundle 'services\beta\web\index.html') -Raw) -match 'New tab') 'New frontend missing.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $bundle 'services\beta\server.py') -Raw) -match 'new route') 'Matching backend missing.'
    Reject { & (Join-Path $fixtureDeploy 'New-DeploymentPackage.ps1') @packArgs -RequireComplete }
    $moved=Join-Path $scratch 'moved-bundle';Move-Item -LiteralPath $bundle -Destination $moved
    & (Join-Path $moved 'deploy\Test-DeploymentPackage.ps1') -DeploymentRoot $moved -RequireComplete | Out-Null
    Put (Join-Path $moved 'services\beta\server.py') '# replaced old backend'
    Reject { & (Join-Path $moved 'deploy\Test-DeploymentPackage.ps1') -DeploymentRoot $moved }
    Assert-True ((Get-Content -LiteralPath (Join-Path $scratch 'business-data\sentinel.txt') -Raw) -eq 'persistent data untouched') 'Data modified.'
    Write-Output "Generic release checks passed: $script:checks assertions; version isolation, complete pairs, hashes, missing apps, portable paths and no overwrites."
} finally {
    $resolved=[IO.Path]::GetFullPath($scratch)
    $expected=[IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\')+'\app-release-test-'
    if(-not $resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
