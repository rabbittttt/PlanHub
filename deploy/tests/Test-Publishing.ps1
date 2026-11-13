#requires -Version 5.1
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$root=Split-Path -Parent $deploy
. (Join-Path $deploy 'Publish.Common.ps1')
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('planhub-publish-test-'+[Guid]::NewGuid().ToString('N'))
$fixture=Join-Path $scratch 'workspace'
function Put($Path,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($false)))}
function Check($Value,$Message){if(-not $Value){throw $Message};$publishTestState.checks++}
function Reject([scriptblock]$Run){$failed=$false;try{& $Run|Out-Null}catch{$failed=$true};Check $failed 'Expected rejection'}
$publishTestState=[pscustomobject]@{checks=0;dockerBuildArgs=$null}
[void][IO.Directory]::CreateDirectory((Join-Path $fixture 'deploy'))
foreach($name in @('Publish-App.ps1','Publish.Common.ps1','App.Release.ps1','Sop.Release.ps1','Deployment.Common.ps1','New-AppRelease.ps1','publish.example.json')){Copy-Item -LiteralPath (Join-Path $deploy $name) -Destination (Join-Path $fixture 'deploy')}
Put (Join-Path $fixture 'portal/index.html') 'portal fixture'
Put (Join-Path $fixture 'portal/config/apps.json') '{"groups":[{"apps":[{"id":"leads","enabled":true,"name":"Leads"}]}]}'
$config=Join-Path $fixture 'config.local/publish.json'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $config))
Write-AppReleaseJson $config @{applications=@{planhub=@{kind='portal';sourceRevision='test'};leads=@{kind='static'}}}
$publish=Join-Path $fixture 'deploy/Publish-App.ps1'
try {
    $result=& $publish -AppId planhub -Version test-v1 -ConfigPath $config -NonInteractive -BuildOnly
    $release=Assert-AppRelease $result.releasePath
    Check ($release.Files.Count -eq 2) 'Portal payload should contain only portal files'
    Check (-not $release.Files.ContainsKey('web.config')) 'Obsolete IIS file included'
    Reject {& $publish -AppId planhub -Version test-v1 -ConfigPath $config -NonInteractive -BuildOnly}
    # A prepared fixture page packages directly, including old private configs
    # that still contain the retired confirmation field.
    $preparedPage=Join-Path $scratch 'page-source'
    Put (Join-Path $preparedPage 'index.html') '<title>Fixture-owned page</title>'
    foreach($version in @('leads-current','leads-legacy')){
        if($version -eq 'leads-legacy'){
            $settings=Get-Content -LiteralPath $config -Raw -Encoding UTF8|ConvertFrom-Json
            $settings.applications.leads|Add-Member -NotePropertyName businessSourceConfirmed -NotePropertyValue $false
            Write-AppReleaseJson $config $settings
        }
        $preparedRelease=Join-Path $scratch $version
        & (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $preparedPage -Destination $preparedRelease -AppId leads -Version $version -Type static -EntryPoint index.html -SourceRevision fixture -DataMode stateless|Out-Null
        $leads=& $publish -AppId leads -ReleasePath $preparedRelease -ConfigPath $config -NonInteractive -BuildOnly
        $validated=Assert-AppRelease $leads.releasePath
        Check ($validated.Manifest.appId -eq 'leads') 'Configured leads release was blocked by a retired confirmation flag'
        Check ((Get-FileHash -LiteralPath $validated.Files['index.html']).Hash -eq (Get-FileHash -LiteralPath (Join-Path $preparedPage 'index.html')).Hash) 'Configured child page was modified'
    }
    Reject {& $publish -AppId unknown -ConfigPath $config -NonInteractive -BuildOnly}
    Reject {& $publish -AppId planhub -Action Deploy -ConfigPath $config -NonInteractive}
    Reject {& $publish -AppId '../outside' -ConfigPath $config -NonInteractive -BuildOnly}
    function node {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
        Check ($Arguments[0].EndsWith('build-docker.mjs')) 'Unexpected Node invocation'
        $publishTestState.dockerBuildArgs=$Arguments
        $output=if($Arguments[1] -eq '--complete'){$Arguments[2]}else{$Arguments[1]}
        [void][IO.Directory]::CreateDirectory($output)
        $global:LASTEXITCODE=0
    }
    $delivery=& $publish -AppId planhub -Version docker-v2 -ConfigPath $config -NonInteractive
    Check ($delivery.deliveryPath -match '[\\/]release[\\/]planhub-') 'One-app delivery must use English release directory'
    Check ($publishTestState.dockerBuildArgs.Count -eq 3) 'Single-app delivery should contain only selected release'
    Put (Join-Path $fixture 'portal/config/apps.json') '{"groups":[]}'
    $all=& $publish -All -Version all-v3 -ConfigPath $config -NonInteractive
    Check ($publishTestState.dockerBuildArgs[1] -eq '--complete') 'Selection 0 must enforce a complete Docker package'
    Check (Test-Path -LiteralPath $all.deliveryPath -PathType Container) 'Selection 0 did not return a delivery folder'
    Check ($publishTestState.dockerBuildArgs.Count -eq 4) 'Complete package did not receive the built releases'
    function node { $global:LASTEXITCODE=1 }
    Reject {& $publish -AppId planhub -Version docker-fail -ConfigPath $config -NonInteractive}
    Write-Output ("Publishing checks passed: "+$publishTestState.checks)
} finally {
    Remove-Item Function:node -ErrorAction SilentlyContinue
    Set-Location -LiteralPath $root
    $resolved=[IO.Path]::GetFullPath($scratch)
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^planhub-publish-test-[a-f0-9]{32}$'){throw 'Unexpected temporary fixture cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
