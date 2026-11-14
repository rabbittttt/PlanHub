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
function Read($Path){return Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json}
function Tree($Path){$snapshot=@{};Get-ChildItem -LiteralPath $Path -Recurse -File|ForEach-Object {$snapshot[$_.FullName.Substring($Path.Length)]=(Get-FileHash -LiteralPath $_.FullName).Hash};return $snapshot}
function Same-Tree($Before,$After){return ($Before|ConvertTo-Json -Compress) -ceq ($After|ConvertTo-Json -Compress)}
foreach($name in @('preview.ps1','preview.cmd','stop-preview.cmd')){Copy-Item -LiteralPath (Join-Path $root ('deploy/windows/'+$name)) -Destination $package}
Put (Join-Path $package 'runtime-common.ps1') @'
function Resolve-PreviewNode([string]$Delivery){return (Join-Path $Delivery 'runtime/node/node.exe')}
'@
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
if(args[0]==='check-snapshot'){
  const proof=path.join(runtime,'fixture-compatibility.json');
  if(!fs.existsSync(proof))process.exit(8);
  const result=JSON.parse(fs.readFileSync(proof,'utf8'));
  if(!result.compatible)process.exit(9);
  process.stdout.write(JSON.stringify(result)+'\n');
}
'@
[void][IO.Directory]::CreateDirectory((Join-Path $package 'runtime/node'))
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $package 'runtime/node/node.exe')
$manifest=@{schemaVersion=2;complete=$true;contractHash='fixture-contract';snapshotContractHash='fixture-snapshot-contract';applications=@('planhub','sop');versions=@{planhub='fixture-v1';sop='fixture-v1'}}
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
    Put (Join-Path $runtime 'shared/orders.xlsx') 'trial shared edits'
    $snapshotConfigPath=Join-Path $runtime 'config.json'
    $snapshotConfigHash=(Get-FileHash -LiteralPath $snapshotConfigPath).Hash
    $sourceConfigPath=Join-Path $source 'config.json'
    $originalSourceConfig=[IO.File]::ReadAllText($sourceConfigPath)
    $sourceHash=$state.sourceConfigHash
    & $entry -Action Stop
    Check ([IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits') 'Stopping removed trial data'
    $settings.publicOrigin='https://new-origin.example.invalid';$settings.sharedDirectory='other-shared';$settings.proxySecret=('d'*64)
    Save $sourceConfigPath $settings
    & $entry -Action Start -Snapshot -UpdateMode Keep
    Check ((Get-FileHash -LiteralPath $snapshotConfigPath).Hash -ceq $snapshotConfigHash) 'Keep pulled configuration changes from the prepared source'
    Check ((Read $statePath).sourceConfigHash -ceq $sourceHash) 'Keep replaced the hash identifying the copied source configuration'
    Remove-Item -LiteralPath $sourceConfigPath
    & $entry -Action Start -Snapshot
    Check ((Get-FileHash -LiteralPath $snapshotConfigPath).Hash -ceq $snapshotConfigHash) 'Keep required or rewrote a missing source configuration'
    Put $sourceConfigPath $originalSourceConfig
    $settings.publicOrigin='https://planhub.example.invalid';$settings.sharedDirectory='shared';$settings.proxySecret=('a'*64)
    $manifest.versions.planhub='fixture-v2';Save (Join-Path $package 'delivery.json') $manifest
    $oldStateHash=(Get-FileHash -LiteralPath $statePath).Hash
    Put (Join-Path $runtime 'fixture-fail.json') 'fixture stop failure'
    Reject {& $entry -Action Start -Snapshot}
    Check ((Get-FileHash -LiteralPath $statePath).Hash -ceq $oldStateHash -and (Get-FileHash -LiteralPath $snapshotConfigPath).Hash -ceq $snapshotConfigHash) 'Failed program stop changed snapshot state or configuration'
    Remove-Item -LiteralPath (Join-Path $runtime 'fixture-fail.json')
    & $entry -Action Start -Snapshot
    $calls=@(Get-Content -LiteralPath (Join-Path $runtime 'fixture-native-calls.txt'))
    Check (($calls[($calls.Length-2)..($calls.Length-1)] -join ',') -ceq 'stop,start') 'Updating programs did not stop the owned old preview before restarting'
    Check ((Read $statePath).snapshot -ceq $state.snapshot -and [IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits' -and [IO.File]::ReadAllText((Join-Path $runtime 'shared/orders.xlsx')) -ceq 'trial shared edits') 'Program update replaced trial data or shared files'
    $manifest.contractHash='fixture-port-change';Save (Join-Path $package 'delivery.json') $manifest
    & $entry -Action Start -Snapshot
    Check ((Read $statePath).snapshot -ceq $state.snapshot -and (Get-FileHash -LiteralPath $snapshotConfigPath).Hash -ceq $snapshotConfigHash) 'A compatible backend port change required fresh trial data or configuration'
    $legacy=Read $statePath;$legacy.PSObject.Properties.Remove('snapshotContractHash');$legacy.contractHash='fixture-legacy-contract';Save $statePath $legacy
    $beforeLegacy=(Get-FileHash -LiteralPath $statePath).Hash
    Reject {& $entry -Action Start -Snapshot}
    Check ((Get-FileHash -LiteralPath $statePath).Hash -ceq $beforeLegacy) 'An unverified legacy contract changed snapshot state'
    Save (Join-Path $runtime 'fixture-compatibility.json') @{compatible=$true;snapshotContractHash=$manifest.snapshotContractHash}
    & $entry -Action Start -Snapshot
    Check ((Read $statePath).snapshotContractHash -ceq $manifest.snapshotContractHash -and (Read $statePath).snapshot -ceq $state.snapshot) 'Verified legacy port migration did not retain and adopt the old snapshot'
    Remove-Item -LiteralPath (Join-Path $runtime 'fixture-compatibility.json')
    $manifest.contractHash='fixture-incompatible';$manifest.snapshotContractHash='fixture-other-contract';Save (Join-Path $package 'delivery.json') $manifest
    $beforeIncompatible=(Get-FileHash -LiteralPath $statePath).Hash
    Reject {& $entry -Action Start -Snapshot}
    Check ((Get-FileHash -LiteralPath $statePath).Hash -ceq $beforeIncompatible -and (Get-FileHash -LiteralPath $snapshotConfigPath).Hash -ceq $snapshotConfigHash) 'Incompatible program contract changed trial configuration or state'
    $manifest.contractHash='fixture-port-change';$manifest.snapshotContractHash='fixture-snapshot-contract';$manifest.applications=@('planhub','sop','extra');Save (Join-Path $package 'delivery.json') $manifest
    Reject {& $entry -Action Start -Snapshot}
    Check ((Get-FileHash -LiteralPath $statePath).Hash -ceq $beforeIncompatible) 'Changed application set updated snapshot state without explicit refresh'
    $manifest.applications=@('planhub','sop');Save (Join-Path $package 'delivery.json') $manifest
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
    Check (Same-Tree $original (Tree $source)) 'Code-only preview updates changed original source files'
    function Read-Host {param([string]$Prompt);return $global:NativePreviewFixtureChoice}
    $global:NativePreviewFixtureChoice=''
    & $entry -Action Start -Snapshot -ChooseUpdate
    Check ((Read $statePath).snapshot -ceq $state.snapshot -and [IO.File]::ReadAllText((Join-Path $runtime 'shared/orders.xlsx')) -ceq 'trial shared edits') 'The Enter/default menu choice refreshed existing trial files'
    $global:NativePreviewFixtureChoice='2'
    & $entry -Action Start -Snapshot -ChooseUpdate
    $menuSnapshot=Read $statePath
    Check ($menuSnapshot.snapshot -cne $state.snapshot -and [IO.File]::ReadAllText((Join-Path $runtime 'data/sop/sop.sqlite3')) -ceq 'trial edits') 'Menu choice 2 did not create a separate snapshot and retain the old trial data'
    Remove-Item Function:Read-Host
    & $entry -Action Start -Snapshot -RefreshSnapshot
    $next=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    Check ($next.snapshot -cne $state.snapshot -and $next.snapshot -cne $menuSnapshot.snapshot) 'Explicit refresh overwrote a previous snapshot'
    Check (Test-Path -LiteralPath (Join-Path $runtime 'data/sop/sop.sqlite3')) 'Refresh deleted the previous snapshot'
    $newRuntime=Join-Path (Join-Path $scratch 'planhub-preview') $next.snapshot
    Check ([IO.File]::ReadAllText((Join-Path $newRuntime 'data/sop/sop.sqlite3')) -ceq 'fixture saved plan bytes') 'Refresh did not use original data'
    Check (Same-Tree $original (Tree $source)) 'Preview lifecycle changed original data'
    $newPackage=Join-Path $scratch 'delivery-v2'
    Copy-Item -LiteralPath $package -Destination $newPackage -Recurse
    $entry=Join-Path $newPackage 'preview.ps1'
    & $entry -Action Start -Snapshot
    $newCalls=@(Get-Content -LiteralPath (Join-Path $newRuntime 'fixture-native-calls.txt'))
    Check ((Read $statePath).snapshot -ceq $next.snapshot -and (Read $statePath).packageDirectory -ceq $newPackage -and ($newCalls[($newCalls.Length-2)..($newCalls.Length-1)] -join ',') -ceq 'stop,start') 'A new delivery folder did not safely adopt the retained snapshot'
    Put (Join-Path $newRuntime 'fixture-fail.json') 'fixture'
    Reject {& $entry -Action Start -Snapshot}
    Write-Output ('Native snapshot checks passed: '+$script:checks)
}finally{
    Remove-Item Function:docker -ErrorAction SilentlyContinue
    Remove-Item Function:Read-Host -ErrorAction SilentlyContinue
    Remove-Variable -Name NativePreviewFixtureChoice -Scope Global -ErrorAction SilentlyContinue
    $resolved=[IO.Path]::GetFullPath($scratch);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^planhub-native-snapshot-test-[a-f0-9]{32}$'){throw 'Unexpected temporary test cleanup path'}
    for($attempt=0;$attempt -lt 10;$attempt++){
        try{Remove-Item -LiteralPath $resolved -Recurse -Force;break}catch{if($attempt -eq 9){throw};Start-Sleep -Milliseconds 200}
    }
}
