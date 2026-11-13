#requires -Version 5.1
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('planhub-preview-test-'+[Guid]::NewGuid().ToString('N'))
$package=Join-Path $scratch 'delivery';[void][IO.Directory]::CreateDirectory($package)
function Save($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false)))}
function Put($Path,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($false)))}
function Check($Value,$Message){if(-not $Value){throw $Message};$previewTestState.checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected safe rejection'}
function Tree($Path){$snapshot=@{};Get-ChildItem -LiteralPath $Path -Recurse -File|ForEach-Object {$snapshot[$_.FullName.Substring($Path.Length)]=(Get-FileHash -LiteralPath $_.FullName).Hash};return $snapshot}
function Same-Tree($Before,$After){return ($Before|ConvertTo-Json -Compress) -ceq ($After|ConvertTo-Json -Compress)}
foreach($name in @('deploy.ps1','start.cmd','stop.cmd','preview.ps1','preview.cmd','stop-preview.cmd','runtime.example.json')){Copy-Item -LiteralPath (Join-Path $root ('deploy/docker/'+$name)) -Destination $package}
Put (Join-Path $package 'images.tar') 'fixture archive';Put (Join-Path $package 'README.md') 'fixture guide'
$definition=@{name='planhub';services=@{
    network=@{image='network-fixture';restart='unless-stopped';ports=@(@{target=4173;published='${PLANHUB_PORT}';host_ip='${PLANHUB_BIND}'})}
    planhub=@{image='portal-fixture';restart='unless-stopped';network_mode='service:network';volumes=@(@{source='${PLANHUB_RUNTIME}';target='/runtime'})}
}}
Save (Join-Path $package 'compose.json') $definition
$files=@{};foreach($name in @('deploy.ps1','start.cmd','stop.cmd','preview.ps1','preview.cmd','stop-preview.cmd','runtime.example.json','images.tar','compose.json','README.md')){$files[$name]=(Get-FileHash -LiteralPath (Join-Path $package $name)).Hash.ToLowerInvariant()}
$manifest=@{schemaVersion=1;platform='linux/amd64';contractHash='fixture-contract';complete=$true;applications=@('planhub');files=$files;images=@{network=@{tag='network-fixture';id='sha256:network'};planhub=@{tag='portal-fixture';id='sha256:planhub'}}}
Save (Join-Path $package 'delivery.json') $manifest
$deploy=Join-Path $package 'deploy.ps1';$entry=Join-Path $package 'preview.ps1'
& $deploy -Action Prepare
$source=Join-Path $scratch 'planhub-runtime'
Put (Join-Path $source 'config/shared_config.py') 'MERGE_GROUPS = {}'
Put (Join-Path $source 'shared/orders.xlsx') 'fixture shared workbook bytes'
Put (Join-Path $source 'data/sop/sop.sqlite3') 'fixture saved plan bytes'
$original=Tree $source
$previewTestState=[pscustomobject]@{checks=0;calls=(New-Object Collections.Generic.List[object]);runtime=$null;sourceRunning=$false;failHealth=$false;foreign=$false}
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $previewTestState.calls.Add(@($Arguments));$global:LASTEXITCODE=0
    if($Arguments[0] -eq 'info'){return 'linux/x86_64'}
    if($Arguments[0] -eq 'compose' -and $Arguments[1] -eq 'version'){return '2.24.0'}
    if($Arguments[0] -eq 'ps'){
        if($Arguments -contains 'label=planhub.runtime'){if($previewTestState.sourceRunning){return 'source-running'};return ''}
        if($previewTestState.runtime){return 'preview-network'};return ''
    }
    if($Arguments[0] -eq 'inspect'){
        $owner=if($Arguments[-1] -eq 'source-running'){$source.Replace('\','/').ToUpperInvariant()}elseif($previewTestState.foreign){'foreign-runtime'}else{$previewTestState.runtime}
        return ConvertTo-Json -Depth 10 -InputObject @(@{Config=@{Labels=@{'planhub.runtime'=$owner}};State=@{Running=$true};Image='sha256:network'})
    }
    if($Arguments[0] -eq 'image' -and $Arguments[1] -eq 'inspect'){if($Arguments[-1] -eq 'network-fixture'){return 'sha256:network'}else{return 'sha256:planhub'}}
    if($Arguments[0] -eq 'compose'){
        if($Arguments -contains 'down'){$previewTestState.runtime=$null}
        if($Arguments -contains 'up'){$previewTestState.runtime=$env:PLANHUB_RUNTIME;if($previewTestState.failHealth){$global:LASTEXITCODE=1}}
    }
}
try{
    Reject {& $entry -Action Start}
    Remove-Item -LiteralPath (Join-Path $source 'deployment.lock')
    Reject {& $entry -Action Start -Snapshot}
    Check (-not(Test-Path -LiteralPath (Join-Path $source 'deployment.lock'))) 'Preview created a missing source lock'
    Put (Join-Path $source 'deployment.lock') ''
    Reject {& $deploy -Action Start -LocalPreview}
    $invalidRuntime=Join-Path $scratch 'not-a-preview'
    Reject {& $deploy -Action Start -LocalPreview -RuntimeDirectory $invalidRuntime}
    Check (-not(Test-Path -LiteralPath $invalidRuntime)) 'Invalid LocalPreview created a runtime directory'
    $previewTestState.sourceRunning=$true
    Reject {& $entry -Action Start -Snapshot}
    $previewTestState.sourceRunning=$false
    & $entry -Action Start -Snapshot
    $statePath=Join-Path $scratch 'planhub-preview/active.json';$state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    $runtime=Join-Path (Join-Path $scratch 'planhub-preview') $state.snapshot
    $config=Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw|ConvertFrom-Json
    Check ($config.publicOrigin -ceq 'http://127.0.0.1:4174' -and $config.listenAddress -ceq '127.0.0.1') 'Preview was not bound to the local browser origin'
    Check ($config.preview.user -match '^[\x20-\x7e]+$' -and $config.preview.user.Contains('\')) 'Launching Windows identity was not recorded'
    Check ($config.proxySecret -cne (Get-Content -LiteralPath (Join-Path $source 'config.json') -Raw|ConvertFrom-Json).proxySecret) 'Formal proxy secret was reused'
    $compose=Get-Content -LiteralPath (Join-Path $runtime 'compose.preview.json') -Raw|ConvertFrom-Json
    Check ($compose.name -ceq 'planhub-preview') 'Preview shared the formal Compose project'
    Check ($compose.services.network.ports[0].host_ip -ceq '127.0.0.1' -and $compose.services.network.ports[0].published -eq '4174') 'Preview exposed a non-loopback host port'
    Check (@($compose.services.PSObject.Properties|Where-Object {$_.Value.restart -cne 'no'}).Count -eq 0) 'Preview would auto-restart on boot'
    Check (Same-Tree $original (Tree $source)) 'Snapshot creation modified source files'
    Check ((Get-FileHash -LiteralPath (Join-Path $runtime 'shared/orders.xlsx')).Hash -eq (Get-FileHash -LiteralPath (Join-Path $source 'shared/orders.xlsx')).Hash) 'Shared inputs were not copied'
    Put (Join-Path $runtime 'data/sop/sop.sqlite3') 'trial edits'
    $previewTestState.calls.Clear();& $entry -Action Stop
    Check (Test-Path -LiteralPath (Join-Path $runtime 'data/sop/sop.sqlite3')) 'Stopping preview deleted the snapshot'
    & $entry -Action Start -Snapshot
    Check ([IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits') 'Restart replaced trial data'
    Reject {& $deploy -Action Start -RuntimeDirectory $runtime}
    $previewTestState.calls.Clear();& $entry -Action Start -Snapshot -RefreshSnapshot
    $newState=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    Check ($newState.snapshot -cne $state.snapshot) 'Refresh overwrote the previous snapshot'
    Check (Test-Path -LiteralPath (Join-Path $runtime 'data/sop/sop.sqlite3')) 'Refresh removed the prior snapshot'
    $newRuntime=Join-Path (Join-Path $scratch 'planhub-preview') $newState.snapshot
    Check ([IO.File]::ReadAllText((Join-Path $newRuntime 'data/sop/sop.sqlite3')) -ceq 'fixture saved plan bytes') 'Refresh did not copy the latest source'
    Check (Same-Tree $original (Tree $source)) 'Preview lifecycle changed source data'
    $previewTestState.foreign=$true;Reject {& $entry -Action Stop};$previewTestState.foreign=$false
    $previewTestState.failHealth=$true;Reject {& $entry -Action Start -Snapshot};$previewTestState.failHealth=$false
    $commands=@($previewTestState.calls|Where-Object {$_[0] -eq 'compose' -and $_[1] -eq '--project-name'})
    Check (@($commands|Where-Object {$_[2] -cne 'planhub-preview'}).Count -eq 0) 'Preview touched the formal Compose project'
    Check (@($commands|Where-Object {$_ -contains '--volumes' -or $_ -contains '--remove-orphans'}).Count -eq 0) 'Preview removed data or unrelated containers'
    Write-Output ('Docker local preview checks passed: '+$previewTestState.checks)
}finally{
    Remove-Item Function:docker -ErrorAction SilentlyContinue
    $resolved=[IO.Path]::GetFullPath($scratch);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^planhub-preview-test-[a-f0-9]{32}$'){throw 'Unexpected temporary test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
