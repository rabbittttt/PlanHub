#requires -Version 5.1
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('planhub-native-snapshot-test-'+[Guid]::NewGuid().ToString('N'))
$package=Join-Path $scratch 'delivery';[void][IO.Directory]::CreateDirectory($package)
$script:checks=0
function Save($Path,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false)))}
function Put($Path,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($false)))}
function Check($Value,$Message){if(-not $Value){throw $Message};$script:checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected safe rejection'}
function Tree($Path){$snapshot=@{};Get-ChildItem -LiteralPath $Path -Recurse -File|ForEach-Object {$snapshot[$_.FullName.Substring($Path.Length)]=(Get-FileHash -LiteralPath $_.FullName).Hash};return $snapshot}
function Same-Tree($Before,$After){return ($Before|ConvertTo-Json -Compress) -ceq ($After|ConvertTo-Json -Compress)}
foreach($name in @('preview.ps1','preview.cmd','stop-preview.cmd')){Copy-Item -LiteralPath (Join-Path $root ('deploy/windows/'+$name)) -Destination $package}
Put (Join-Path $package 'deploy.ps1') @'
param([string]$Action)
if($Action -ne 'Validate'){throw 'Only package validation is allowed in this snapshot fixture.'}
return (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'delivery.json') -Raw|ConvertFrom-Json)
'@
Put (Join-Path $package 'launcher/native-preview.mjs') @'
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),runtime=args[args.indexOf('--runtime')+1];
if(fs.existsSync(path.join(runtime,'fixture-fail.json')))process.exit(7);
fs.appendFileSync(path.join(runtime,'fixture-native-calls.txt'),args[0]+'\n');
'@
[void][IO.Directory]::CreateDirectory((Join-Path $package 'runtime/node'))
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $package 'runtime/node/node.exe')
$manifest=@{schemaVersion=2;complete=$true;contractHash='fixture-contract';applications=@('planhub','sop');versions=@{planhub='fixture-v1';sop='fixture-v1'}}
Save (Join-Path $package 'delivery.json') $manifest
$source=Join-Path $scratch 'planhub-runtime';[void][IO.Directory]::CreateDirectory($source)
$settings=@{schemaVersion=1;publicOrigin='https://planhub.example.invalid';listenAddress='127.0.0.1';port=4173;sharedDirectory='shared';sopSharedConfig='config/shared_config.py';quicklookSourceBase='shared';proxySecret=('a'*64);sopSecret=('b'*64);vehicleSecret=('c'*64)}
Save (Join-Path $source 'config.json') $settings
Put (Join-Path $source 'deployment.lock') ''
Put (Join-Path $source 'config/shared_config.py') 'MERGE_GROUPS = {}'
Put (Join-Path $source 'shared/orders.xlsx') 'fixture shared input bytes'
Put (Join-Path $source 'data/sop/sop.sqlite3') 'fixture saved plan bytes'
$entry=Join-Path $package 'preview.ps1'
function docker {throw 'Native preview must not invoke Docker.'}
try{
    Reject {& $entry -Action Start}
    Remove-Item -LiteralPath (Join-Path $source 'deployment.lock')
    Reject {& $entry -Action Start -Snapshot}
    Check (-not(Test-Path -LiteralPath (Join-Path $source 'deployment.lock'))) 'Preview created a missing source lock'
    Put (Join-Path $source 'deployment.lock') ''
    Save (Join-Path $source 'deployment-state.json') @{running=$true}
    Reject {& $entry -Action Start -Snapshot}
    Save (Join-Path $source 'deployment-state.json') @{running=$false}
    Save (Join-Path $source 'deployment-active.json') @{schemaVersion=1;mayBeRunning=$true}
    Reject {& $entry -Action Start -Snapshot}
    Save (Join-Path $source 'deployment-active.json') @{schemaVersion=1;mayBeRunning=$false}
    $settings.quicklookSourceBase='not-copied';Save (Join-Path $source 'config.json') $settings
    Reject {& $entry -Action Start -Snapshot}
    $settings.quicklookSourceBase='shared';Save (Join-Path $source 'config.json') $settings
    $original=Tree $source
    & $entry -Action Start -Snapshot
    $statePath=Join-Path $scratch 'planhub-preview/active.json';$state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    $runtime=Join-Path (Join-Path $scratch 'planhub-preview') $state.snapshot
    $config=Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw|ConvertFrom-Json
    Check ($config.publicOrigin -ceq 'http://127.0.0.1:4173' -and $config.port -eq 4173 -and $config.listenAddress -ceq '127.0.0.1') 'Preview did not use the fixed loopback browser origin'
    Check ($config.preview.user -match '^[\x20-\x7e]+$' -and $config.preview.user.Contains('\')) 'Launching Windows identity was not recorded'
    Check ($config.proxySecret -cne $settings.proxySecret) 'Original proxy secret was reused'
    Check (Same-Tree $original (Tree $source)) 'Snapshot creation changed original files'
    Check ((Get-FileHash -LiteralPath (Join-Path $runtime 'shared/orders.xlsx')).Hash -eq (Get-FileHash -LiteralPath (Join-Path $source 'shared/orders.xlsx')).Hash) 'Shared input was not copied'
    Put (Join-Path $runtime 'data/sop/sop.sqlite3') 'trial edits'
    & $entry -Action Stop
    Check ([IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits') 'Stopping removed trial data'
    $config.publicOrigin='http://127.0.0.1:4174';$config.port=4174
    Save (Join-Path $runtime 'config.json') $config
    Put (Join-Path $runtime 'fixture-fail.json') 'fixture stop failure'
    Reject {& $entry -Action Start -Snapshot}
    Check ((Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw|ConvertFrom-Json).port -eq 4174) 'Legacy snapshot config changed before its worker could stop'
    Remove-Item -LiteralPath (Join-Path $runtime 'fixture-fail.json')
    & $entry -Action Start -Snapshot
    Check ([IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits') 'Restart replaced trial data'
    $upgraded=Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw|ConvertFrom-Json
    Check ($upgraded.port -eq 4173 -and $upgraded.publicOrigin -ceq 'http://127.0.0.1:4173') 'Legacy snapshot did not migrate to unified public port'
    & $entry -Action Start -Snapshot -RefreshSnapshot
    $next=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    Check ($next.snapshot -cne $state.snapshot) 'Refresh overwrote the previous snapshot'
    Check (Test-Path -LiteralPath (Join-Path $runtime 'data/sop/sop.sqlite3')) 'Refresh deleted the previous snapshot'
    $newRuntime=Join-Path (Join-Path $scratch 'planhub-preview') $next.snapshot
    Check ([IO.File]::ReadAllText((Join-Path $newRuntime 'data/sop/sop.sqlite3')) -ceq 'fixture saved plan bytes') 'Refresh did not use original data'
    Check (Same-Tree $original (Tree $source)) 'Preview lifecycle changed original data'
    Put (Join-Path $newRuntime 'fixture-fail.json') 'fixture'
    Reject {& $entry -Action Start -Snapshot}
    Write-Output ('Native snapshot checks passed: '+$script:checks)
}finally{
    Remove-Item Function:docker -ErrorAction SilentlyContinue
    $resolved=[IO.Path]::GetFullPath($scratch);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^planhub-native-snapshot-test-[a-f0-9]{32}$'){throw 'Unexpected temporary test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
