#requires -Version 5.1
[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$root=Split-Path -Parent $deploy
. (Join-Path $deploy 'Publish.Common.ps1')
$checks=0
function Check {param($Condition,[string]$Message);$script:checks++;if(-not $Condition){throw $Message}}
function Reject {param([scriptblock]$Action);$failed=$false;try{& $Action | Out-Null}catch{$failed=$true};Check $failed 'Expected a failure.'}
function Put {param([string]$Path,[string]$Text);[IO.Directory]::CreateDirectory((Split-Path -Parent $Path))|Out-Null;[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
$scratch=Join-Path $root ('artifacts/publish-test-'+[Guid]::NewGuid().ToString('N'))
$workspace=Join-Path $scratch '工作区 含空格'
$fixtureDeploy=Join-Path $workspace 'deploy'
[IO.Directory]::CreateDirectory($fixtureDeploy)|Out-Null
foreach($file in @('App.Release.ps1','Sop.Release.ps1','Deployment.Common.ps1','Publish.Common.ps1','New-AppRelease.ps1','Publish-App.ps1','Send-AppRelease.ps1','publish.example.json','portal.web.config')) {Copy-Item -LiteralPath (Join-Path $deploy $file) -Destination $fixtureDeploy}
Put (Join-Path $workspace 'portal/index.html') '<title>Portal fixture</title>'
Put (Join-Path $workspace 'portal/config/apps.json') '{"groups":[{"apps":[{"id":"alpha","name":"Alpha","enabled":true},{"id":"localstatic","name":"Local Static","enabled":true},{"id":"sop","name":"SOP","enabled":true}]}]}'
$configFile=Join-Path $workspace 'config.local/publish.json'
Put $configFile '{}'
$config=[pscustomobject]@{inbox='./received';applications=[pscustomobject]@{planhub=[pscustomobject]@{kind='portal';sourceRevision='fixture-portal'}}}
Write-AppReleaseJson $configFile $config
$publish=Join-Path $fixtureDeploy 'Publish-App.ps1'
$result=& $publish -AppId planhub -Version v1 -ConfigPath $configFile -Action Package -NonInteractive
$portal=Assert-AppRelease $result.releasePath
Check ($portal.Manifest.appId -eq 'planhub' -and $portal.Files.Count -eq 3) 'Portal package failed.'
Check ($portal.Files.ContainsKey('web.config')) 'Portal IIS configuration is absent.'
Check ((Get-FileHash -LiteralPath $portal.Files['web.config']).Hash -eq (Get-FileHash -LiteralPath (Join-Path $deploy 'portal.web.config')).Hash) 'Portal IIS baseline was changed.'
Reject {& $publish -AppId planhub -Version v1 -ConfigPath $configFile -NonInteractive}
Reject {& $publish -AppId '../bad' -ConfigPath $configFile -NonInteractive}
Reject {& $publish -AppId unknown -ConfigPath $configFile -NonInteractive}
Reject {Resolve-PublishPath 'D:relative' $workspace}
Reject {Resolve-PublishPath '\rootrelative' $workspace}
$send=Join-Path $fixtureDeploy 'Send-AppRelease.ps1'
$sent=& $send -ReleasePath $result.releasePath -ConfigPath $configFile
Check (Test-Path -LiteralPath (Join-Path $workspace 'received/planhub/v1/payload/index.html')) 'Send did not copy the release.'
Check (-not $sent.remoteApplied) 'Send incorrectly claimed a deployment.'
Check (@(Get-ChildItem -LiteralPath (Join-Path $workspace 'received/planhub') -Directory | Where-Object Name -like '.partial-*').Count -eq 0) 'Successful send left a partial directory.'
$again=& $send -ReleasePath $result.releasePath -ConfigPath $configFile
Check ($again.receivedPath -eq $sent.receivedPath) 'Identical retry did not reuse the package.'
$existingSent=& $publish -AppId planhub -ReleasePath $result.releasePath -ConfigPath $configFile -Action SendExisting -NonInteractive
Check ($existingSent.receivedPath -eq $sent.receivedPath) 'BAT existing-package operation failed.'
Reject {& $send -ReleasePath $result.releasePath -ConfigPath $configFile -ApplyRemote}
Put (Join-Path $result.releasePath 'payload/index.html') 'tampered'
Reject {& $send -ReleasePath $result.releasePath -ConfigPath $configFile}
Check ((Get-Content -LiteralPath (Join-Path $sent.receivedPath 'payload/index.html') -Raw) -eq '<title>Portal fixture</title>') 'Source tampering changed received data.'

$service=Join-Path $scratch 'service-prepared'
Put (Join-Path $service 'server.py') '# fake server; never started'
$sourceRelease=Join-Path $scratch 'alpha-v7'
& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $service -Destination $sourceRelease -AppId alpha -Version v7 -Type service -EntryPoint server.py -SourceRevision fixture -DataMode external -HealthPath /health | Out-Null
$imported=& $publish -AppId alpha -ReleasePath $sourceRelease -ConfigPath $configFile -Action Package -NonInteractive
Check ($imported.version -eq 'v7') 'Existing immutable release version was not retained.'
Check ((Assert-AppRelease $imported.releasePath).Manifest.dataMode -eq 'external') 'Service metadata changed.'
Reject {& $publish -AppId alpha -Version v8 -ReleasePath $sourceRelease -ConfigPath $configFile -NonInteractive}
Reject {& $publish -AppId sop -ReleasePath $sourceRelease -ConfigPath $configFile -NonInteractive}
Put (Join-Path $service 'data/private.db') 'do-not-ship'
Reject {& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $service -Destination (Join-Path $scratch 'bad') -AppId alpha -Version bad -Type service -EntryPoint server.py -SourceRevision fixture -DataMode external -HealthPath /health}

# New static registration exists only in the local map; publish discovers it without script edits.
Put (Join-Path $workspace 'integration/apps.json') '{"applications":{}}'
Put (Join-Path $workspace 'config.local/apps.json') '{"applications":{"localstatic":{"type":"static","root":"../静态页面","entry":"报表.html","publicPaths":["报表.html","assets/"]}}}'
Put (Join-Path $scratch '静态页面/报表.html') '<script src="assets/app.js"></script>'
Put (Join-Path $scratch '静态页面/assets/app.js') 'window.fixture=true;'
[IO.Directory]::CreateDirectory((Join-Path $workspace 'scripts'))|Out-Null
foreach($script in @('prepare-apps.mjs','app-integrations.mjs','portal-instance.mjs')){
    Copy-Item -LiteralPath (Join-Path $root ("scripts/"+$script)) -Destination (Join-Path $workspace 'scripts')
}
$staticResult=& $publish -AppId localstatic -Version local1 -ConfigPath $configFile -Action Package -NonInteractive
$staticEnvelope=Assert-AppRelease $staticResult.releasePath
Check ($staticEnvelope.Manifest.type -eq 'static' -and $staticEnvelope.Files.ContainsKey('index.html') -and $staticEnvelope.Files.ContainsKey('assets/app.js')) 'Local-only static registration was not published.'
Check ((Get-Content -LiteralPath (Join-Path $scratch '静态页面/报表.html') -Raw) -eq (Get-Content -LiteralPath $staticEnvelope.Files['index.html'] -Raw)) 'Static page bytes were changed.'
$badStatic=Join-Path $scratch 'bad-static'
Put (Join-Path $badStatic 'index.html') '<title>fixture</title>'
Put (Join-Path $badStatic 'web.config') '<configuration/>'
Reject {& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $badStatic -Destination (Join-Path $scratch 'bad-static-release') -AppId alpha -Version unsafe -Type static -EntryPoint index.html -SourceRevision fixture -DataMode stateless}

# Source-owned build command: a fake builder only writes an isolated prepared server file.
$builderFile=Join-Path $scratch 'fixture-builder.ps1'
Put $builderFile 'param($Destination); [IO.Directory]::CreateDirectory($Destination)|Out-Null; [IO.File]::WriteAllText((Join-Path $Destination "server.py"),"# built fixture")'
$builderProfile=[pscustomobject]@{kind='payload';sourceRevision='fixture-build';type='service';entryPoint='server.py';dataMode='external';healthPath='/health';build=[pscustomobject]@{command=(Get-Process -Id $PID).Path;cwd=$scratch;args=@('-NoProfile','-File',$builderFile,'-Destination','{output}')}}
$config.applications | Add-Member -NotePropertyName alpha -NotePropertyValue $builderProfile -Force
Write-AppReleaseJson $configFile $config
$builtResult=& $publish -AppId alpha -Version built1 -ConfigPath $configFile -Action Package -NonInteractive
Check ((Get-Content -LiteralPath (Join-Path $builtResult.releasePath 'payload/server.py') -Raw) -eq '# built fixture') 'Source-owned build output not packaged.'
Put $builderFile 'param($Destination); exit 3'
Reject {& $publish -AppId alpha -Version buildfail -ConfigPath $configFile -Action Send -NonInteractive}
Check (-not(Test-Path -LiteralPath (Join-Path $workspace 'received/alpha/buildfail'))) 'Failed build reached inbox.'

# Convert a legacy SOP envelope without changing original files.
$legacy=Join-Path $scratch 'legacy-sop'
$entries=@()
foreach($name in @('server.py','requirements.txt','requirements-intranet.txt','web/index.html','sop/__init__.py','sop/gateway.py','integration/iis/SopIdentityBridge.cs')){
    $path=Join-Path $legacy $name
    Put $path '# fixture'
    $entries+=@{path=$name;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
Write-AppReleaseJson (Join-Path $legacy 'sop-release.json') @{schemaVersion=1;appId='hima-sop';sourceCommit=('a'*40);sourceDirty=$false;files=$entries}
$sopResult=& $publish -AppId sop -Version sopv1 -ReleasePath $legacy -ConfigPath $configFile -NonInteractive
$sopEnvelope=Assert-AppRelease $sopResult.releasePath
Check ($sopEnvelope.Manifest.appId -eq 'sop' -and $sopEnvelope.Files.Count -eq 7) 'SOP normalization failed.'
Check (Test-Path -LiteralPath (Join-Path $legacy 'sop-release.json')) 'Original SOP envelope changed.'

# Existing WinRM only: fake transport executes a fixture installer, never touches IIS.
$remoteRoot=Join-Path $scratch 'fake-B'
Put (Join-Path $remoteRoot 'deploy/Install-AppVersion.ps1') 'param($ReleasePath,$ConfigPath,[switch]$Apply); if(-not $Apply){throw "Apply absent"}; Write-Output "fixture remote health passed"'
$config | Add-Member -NotePropertyName remote -NotePropertyValue ([pscustomobject]@{computerName='fixture-B';toolsRoot=$remoteRoot;configPath='fixture';inboxLocalPath=(Join-Path $workspace 'received')}) -Force
Write-AppReleaseJson $configFile $config
function Invoke-Command {param($ComputerName,$ArgumentList,[scriptblock]$ScriptBlock,$ErrorAction); & $ScriptBlock @ArgumentList}
$remoteSent=@(& $send -ReleasePath $imported.releasePath -ConfigPath $configFile -ApplyRemote)
Check ($remoteSent[-1].remoteApplied) 'Configured remote deployment result missing.'
Put (Join-Path $remoteRoot 'deploy/Install-AppVersion.ps1') 'param($ReleasePath,$ConfigPath,[switch]$Apply); throw "fixture health failure"'
Reject {& $send -ReleasePath $imported.releasePath -ConfigPath $configFile -ApplyRemote}
Write-Host "PASS $checks publishing checks. Fixtures retained at $scratch"
