#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Start','Stop')][string]$Action='Start',
    [switch]$Snapshot,
    [switch]$RefreshSnapshot,
    [ValidateSet('Keep','Refresh')][string]$UpdateMode='Keep',
    [switch]$ChooseUpdate,
    [string]$SourceDirectory=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$package=(Get-Item -LiteralPath $PSScriptRoot).FullName
$parent=Split-Path -Parent $package
$previewRoot=Join-Path $parent 'planhub-preview'
if(-not $SourceDirectory){$SourceDirectory=Join-Path $parent 'planhub-runtime'}
$source=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDirectory).TrimEnd('\','/')
if($source -eq [IO.Path]::GetPathRoot($source).TrimEnd('\','/')){throw 'Source runtime must be below a filesystem root.'}
function Within([string]$Root,[string]$Path){return $Path.Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\','/')+'\',[StringComparison]::OrdinalIgnoreCase)}
function No-Link([string]$Path){
    $current=$Path
    while($current){
        if(Test-Path -LiteralPath $current){$item=Get-Item -LiteralPath $current -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Linked snapshot path is not allowed: '+$current)}}
        $next=Split-Path -Parent $current;if($next -eq $current){break};$current=$next
    }
}
function Relative-Path([string]$Value){
    if(-not $Value -or $Value -match '[\\:]' -or $Value.StartsWith('/') -or @($Value.Split('/')|Where-Object {-not $_ -or $_.StartsWith('.')}).Count){throw 'Snapshot configuration paths must be relative to their runtime directory.'}
}
function Source-Path([string]$Value){
    if(-not $Value -or $Value -match '[\\:]' -or $Value.StartsWith('/') -or @($Value.Split('/')|Where-Object {-not $_ -or $_.StartsWith('.')}).Count){throw 'Source configuration paths must be relative to planhub-runtime.'}
    $result=[IO.Path]::GetFullPath((Join-Path $source $Value));No-Link $result;return $result
}
function Read-Json([string]$Path){return Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json}
function Save-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30)+"`n",(New-Object Text.UTF8Encoding($false)))}
function Secret {
    $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
    return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
}
function Actor {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try{
        $name=$identity.Name
        if($name.Length -le 100 -and $name -cmatch '^([A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+)$'){return $name}
        $sid=$identity.User.Value
        if($sid -cnotmatch '^S-1-[0-9-]+$'){throw 'Cannot identify the current Windows operator.'}
        return 'SID\'+$sid
    }finally{$identity.Dispose()}
}
function Native([string]$Mode,[string]$Runtime){
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    & $node (Join-Path $package 'launcher/native-preview.mjs') $Mode --package $package --runtime $Runtime
    if($LASTEXITCODE -ne 0){throw ('Native preview failed. Logs: '+(Join-Path $Runtime 'logs'))}
}
function Snapshot-Contract($State,$Manifest,[string]$Runtime){
    $current=$Manifest.PSObject.Properties['snapshotContractHash']
    $previous=$State.PSObject.Properties['snapshotContractHash']
    if($State.contractHash -ceq $Manifest.contractHash){return}
    if($null -ne $current -and $null -ne $previous -and $previous.Value -ceq $current.Value){return}
    if($null -eq $current -or -not $current.Value){throw 'This package cannot verify snapshot compatibility. Use a newly built complete package; existing trial data was retained.'}
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $proof=& $node (Join-Path $package 'launcher/native-preview.mjs') check-snapshot --package $package --runtime $Runtime --contract-hash $State.contractHash
    if($LASTEXITCODE -ne 0){throw 'The startup contract changed or its previous package is unavailable. Existing trial data was retained. Use a compatible package, or explicitly choose 2 / -RefreshSnapshot to create a separate snapshot.'}
    try{$result=($proof -join [Environment]::NewLine)|ConvertFrom-Json}catch{throw 'Snapshot compatibility proof is invalid. Existing trial data was retained.'}
    if($result.compatible -cne $true -or $result.snapshotContractHash -cne $current.Value){throw 'Snapshot startup contracts are incompatible. Existing trial data was retained; explicitly choose 2 / -RefreshSnapshot only if a fresh test copy is intended.'}
}
function Program-Signature($Manifest){
    $versions=@($Manifest.versions.PSObject.Properties|Sort-Object Name|ForEach-Object {$_.Name+'='+[string]$_.Value}) -join ','
    return ([string]$Manifest.contractHash)+'|'+$versions
}
function Adopt-Package($State,$Manifest){
    $State|Add-Member -Force -NotePropertyName contractHash -NotePropertyValue $Manifest.contractHash
    $State|Add-Member -Force -NotePropertyName packageDirectory -NotePropertyValue $package
    $State|Add-Member -Force -NotePropertyName programSignature -NotePropertyValue (Program-Signature $Manifest)
    if($null -ne $Manifest.PSObject.Properties['snapshotContractHash']){$State|Add-Member -Force -NotePropertyName snapshotContractHash -NotePropertyValue $Manifest.snapshotContractHash}
}
function Assert-CopyTree([string]$Path){
    No-Link $Path
    if(Test-Path -LiteralPath $Path -PathType Container){
        foreach($entry in Get-ChildItem -LiteralPath $Path -Force -Recurse){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Snapshot inputs contain a link: '+$entry.FullName)}}
    }
}
function Copy-Tree([string]$From,[string]$To){
    if(-not(Test-Path -LiteralPath $From -PathType Container)){[void][IO.Directory]::CreateDirectory($To);return}
    [void][IO.Directory]::CreateDirectory($To)
    foreach($entry in Get-ChildItem -LiteralPath $From -Force){Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $To $entry.Name) -Recurse -Force}
}
No-Link $source;No-Link $previewRoot
if((Within $source $previewRoot) -or (Within $previewRoot $source) -or (Within $package $source) -or (Within $source $package)){throw 'Preview snapshots, source data and the package must be separate directories.'}
$manifest=& (Join-Path $package 'deploy.ps1') -Action Validate
if(-not $manifest.complete){throw 'Use a complete package built with selection 0 or 8 for local preview.'}
$runtimeHelper=Join-Path $package 'runtime-common.ps1';No-Link $runtimeHelper
if(-not(Test-Path -LiteralPath $runtimeHelper -PathType Leaf)){throw 'Runtime resolver is missing. Copy the complete delivery folder again.'}
. $runtimeHelper
$node=Resolve-PreviewNode -Delivery $package
No-Link $node
if($RefreshSnapshot -or $UpdateMode -eq 'Refresh' -or $ChooseUpdate){$Snapshot=$true}
if($Action -eq 'Stop' -and -not(Test-Path -LiteralPath (Join-Path $source 'native-preview.json')) -and (Test-Path -LiteralPath (Join-Path $previewRoot 'active.json'))){$Snapshot=$true}
if(-not $Snapshot){
    if($source -ine (Join-Path $parent 'planhub-runtime')){throw 'Direct local use requires the sibling planhub-runtime directory.'}
    $directLock=$null
    try{
        $lockFile=Join-Path $source 'deployment.lock';No-Link $lockFile
        $directLock=[IO.File]::Open($lockFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $derived=Join-Path $source 'native-preview.json';No-Link $derived
        $marker=Join-Path $source 'native-direct.json';No-Link $marker
        if($Action -eq 'Stop'){
            if(-not(Test-Path -LiteralPath $derived) -and (Test-Path -LiteralPath (Join-Path $source 'native-owner.json'))){throw 'Local owner exists but its derived configuration is missing. Restore that configuration before stopping.'}
            if(Test-Path -LiteralPath $derived){Native 'stop' $source}
            Save-Json $marker @{schemaVersion=1;mayBeRunning=$false}
            Write-Host 'Local services stopped. Persistent data retained.'
            return
        }
        foreach($item in @(@('deployment-active.json','mayBeRunning'),@('deployment-state.json','running'))){
            $file=Join-Path $source $item[0];No-Link $file
            if(Test-Path -LiteralPath $file){$record=Read-Json $file;if($record.($item[1]) -cne $false){throw 'Stop formal Docker services with stop.cmd before direct local startup.'}}
        }
        $sourceFile=Join-Path $source 'config.json';No-Link $sourceFile
        $settings=Read-Json $sourceFile
        if($settings.PSObject.Properties['preview']){throw 'Use the original runtime configuration, not a snapshot configuration.'}
        foreach($name in @('sharedDirectory','sopSharedConfig','quicklookSourceBase')){$null=Source-Path $settings.$name}
        if(-not(Test-Path -LiteralPath (Source-Path $settings.sharedDirectory) -PathType Container)){throw 'Prepare the shared data directory first.'}
        if('sop' -in $manifest.applications -and -not(Test-Path -LiteralPath (Source-Path $settings.sopSharedConfig) -PathType Leaf)){throw 'Provide the real shared_config.py before startup.'}
        if(Test-Path -LiteralPath $derived){Native 'stop' $source}
        $settings.publicOrigin='http://127.0.0.1:4173';$settings.listenAddress='127.0.0.1';$settings.port=4173
        $settings|Add-Member -NotePropertyName preview -NotePropertyValue ([pscustomobject]@{schemaVersion=1;mode='direct';user=(Actor);sourceDirectory=$source;sourceConfigHash=(Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash;createdAt=[DateTime]::UtcNow.ToString('o')})
        Save-Json $derived $settings
        Save-Json $marker @{schemaVersion=1;mayBeRunning=$true}
        Native 'start' $source
        Write-Host ('Reading and saving live data in: '+$source)
        Write-Host 'Open http://127.0.0.1:4173/. Shared updates follow each application refresh cycle.'
        return
    }finally{if($null -ne $directLock){$directLock.Dispose()}}
}
if($Action -eq 'Stop' -and -not(Test-Path -LiteralPath $previewRoot -PathType Container)){Write-Host 'No local preview has been prepared.';return}
[void][IO.Directory]::CreateDirectory($previewRoot)
$lock=$null;$sourceLock=$null
try{
    No-Link (Join-Path $previewRoot 'preview.lock')
    try{$lock=[IO.File]::Open((Join-Path $previewRoot 'preview.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Another local preview command is running.'}
    $stateFile=Join-Path $previewRoot 'active.json';No-Link $stateFile
    $state=$null;$runtime=$null
    if(Test-Path -LiteralPath $stateFile){
        $state=Read-Json $stateFile
        if($state.schemaVersion -ne 1 -or $state.snapshot -cnotmatch '^snapshot-[a-f0-9]{32}$' -or $state.sourceDirectory -ine $source){throw 'Preview state does not match this source directory.'}
        $runtime=Join-Path $previewRoot $state.snapshot;Assert-CopyTree $runtime
        No-Link (Join-Path $runtime 'config.json')
        $previewConfig=Read-Json (Join-Path $runtime 'config.json')
        if($previewConfig.preview.sourceDirectory -ine $source){throw 'Snapshot source identity differs.'}
    }
    if($Action -eq 'Stop'){
        if($null -eq $state){Write-Host 'No local preview is running.';return}
        Native 'stop' $runtime
        Write-Host 'Local preview stopped. Snapshot data retained; formal data was not changed.';return
    }
    $user=Actor
    if($null -ne $state -and $ChooseUpdate -and -not $RefreshSnapshot -and $UpdateMode -eq 'Keep'){
        Write-Host '1. 只更新程序，保留当前试运行的数据、共享文件和配置（默认）。'
        Write-Host '2. 从 planhub-runtime 的数据、共享文件和配置新建试运行副本，保留旧副本。'
        do{$choice=Read-Host '输入 1 或 2，直接回车选择 1'}while($choice -notin @('','1','2'))
        if($choice -eq '2'){$UpdateMode='Refresh'}
    }
    if($null -ne $state -and -not $RefreshSnapshot -and $UpdateMode -eq 'Keep'){
        if((@($state.applications|Sort-Object) -join ',') -cne (@($manifest.applications|Sort-Object) -join ',')){throw 'The enabled applications changed. Existing trial data was retained. Explicitly choose 2 / -RefreshSnapshot to create a separate snapshot.'}
        foreach($name in @('sharedDirectory','sopSharedConfig','quicklookSourceBase')){Relative-Path ([string]$previewConfig.$name)}
        Snapshot-Contract $state $manifest $runtime
        Write-Host ('Reusing local snapshot: '+$runtime)
        $legacyPort=$previewConfig.port -eq 4174 -and $previewConfig.publicOrigin -ceq 'http://127.0.0.1:4174'
        $newActor=$previewConfig.preview.user -cne $user
        $signature=Program-Signature $manifest
        $newPackage=$null -eq $state.PSObject.Properties['packageDirectory'] -or $state.packageDirectory -ine $package -or $null -eq $state.PSObject.Properties['programSignature'] -or $state.programSignature -cne $signature
        if($legacyPort -or $newActor -or $newPackage){Native 'stop' $runtime}
        if($legacyPort){
            $previewConfig.port=4173;$previewConfig.publicOrigin='http://127.0.0.1:4173'
            Write-Host 'Local preview now uses port 4173. Existing trial data retained.'
        }
        if($newActor){$previewConfig.preview.user=$user}
        if($legacyPort -or $newActor){Save-Json (Join-Path $runtime 'config.json') $previewConfig}
        Adopt-Package $state $manifest
        Save-Json $stateFile $state
    }else{
        $sourceConfig=Join-Path $source 'config.json';No-Link $sourceConfig
        if(-not(Test-Path -LiteralPath $sourceConfig -PathType Leaf)){throw 'Run prepare.cmd, then place shared rules and data as described in step 3 before local preview.'}
        $settings=Read-Json $sourceConfig
        if($null -ne $settings.PSObject.Properties['preview']){throw 'The snapshot source must be the original formal runtime configuration.'}
        $sourceHash=(Get-FileHash -LiteralPath $sourceConfig).Hash
        if($null -ne $state){
            Native 'stop' $runtime
        }
        No-Link (Join-Path $source 'deployment.lock')
        try{$sourceLock=[IO.File]::Open((Join-Path $source 'deployment.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)}catch{throw 'Source runtime is busy or not prepared. Complete step 3 Prepare and wait for any deployment to finish.'}
        if((Get-FileHash -LiteralPath $sourceConfig).Hash -cne $sourceHash){throw 'Source configuration changed during snapshot preparation. Retry preview.cmd.'}
        $directMarker=Join-Path $source 'native-direct.json';No-Link $directMarker
        if(Test-Path -LiteralPath $directMarker){if((Read-Json $directMarker).mayBeRunning -cne $false){throw 'Stop direct local services before copying a snapshot.'}}
        $activeMarker=Join-Path $source 'deployment-active.json';No-Link $activeMarker
        if(Test-Path -LiteralPath $activeMarker){
            $active=Read-Json $activeMarker
            if($active.schemaVersion -ne 1 -or $active.mayBeRunning -cne $false){throw 'Formal services may still be running. Complete a full stop.cmd before copying their data.'}
        }
        $deploymentState=Join-Path $source 'deployment-state.json';No-Link $deploymentState
        if(Test-Path -LiteralPath $deploymentState){
            $deployment=Read-Json $deploymentState
            if($null -eq $deployment.PSObject.Properties['running'] -or $deployment.running -cne $false){throw 'Stop formal Docker services with their stop.cmd before copying data. Native preview does not require Docker.'}
        }
        $shared=Source-Path $settings.sharedDirectory;$rules=Source-Path $settings.sopSharedConfig
        $null=Source-Path $settings.quicklookSourceBase
        $base=[string]$settings.quicklookSourceBase
        $databaseDirectory=if($null -ne $settings.PSObject.Properties['databaseDirectory']){[string]$settings.databaseDirectory}else{'data'}
        Source-Path $databaseDirectory | Out-Null
        if($base -cne $settings.sharedDirectory -and -not $base.StartsWith(([string]$settings.sharedDirectory)+'/',[StringComparison]::Ordinal) -and $base -cne $databaseDirectory -and -not $base.StartsWith($databaseDirectory+'/',[StringComparison]::Ordinal)){throw 'quicklookSourceBase must stay within the copied sharedDirectory or databaseDirectory (legacy default: data) for native preview.'}
        if(-not(Test-Path -LiteralPath $rules -PathType Leaf)){throw 'Place the real shared_config.py at the configured source path before preview.'}
        if(-not(Test-Path -LiteralPath $shared -PathType Container)){throw 'Prepare the shared data directory before preview.'}
        $data=Join-Path $source $databaseDirectory
        Assert-CopyTree $shared;Assert-CopyTree $data;No-Link $rules
        $snapshotName='snapshot-'+[Guid]::NewGuid().ToString('N')
        $runtime=Join-Path $previewRoot $snapshotName
        [void][IO.Directory]::CreateDirectory($runtime)
        Write-Host 'Copying rules, shared inputs and application data into a local test snapshot...'
        Copy-Tree $shared (Join-Path $runtime $settings.sharedDirectory)
        Copy-Tree $data (Join-Path $runtime $databaseDirectory)
        $targetRules=Join-Path $runtime $settings.sopSharedConfig
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $targetRules))
        Copy-Item -LiteralPath $rules -Destination $targetRules -Force
        $settings.publicOrigin='http://127.0.0.1:4173';$settings.listenAddress='127.0.0.1';$settings.port=4173
        $settings.proxySecret=Secret;$settings.sopSecret=Secret;$settings.vehicleSecret=Secret
        $settings|Add-Member -NotePropertyName preview -NotePropertyValue ([pscustomobject]@{schemaVersion=1;user=$user;sourceDirectory=$source;createdAt=[DateTime]::UtcNow.ToString('o')})
        Save-Json (Join-Path $runtime 'config.json') $settings
        $state=[pscustomobject][ordered]@{schemaVersion=1;snapshot=$snapshotName;sourceDirectory=$source;sourceConfigHash=$sourceHash;contractHash=$manifest.contractHash;applications=@($manifest.applications)}
        Adopt-Package $state $manifest
        Save-Json $stateFile $state
        $sourceLock.Dispose();$sourceLock=$null
    }
    Native 'start' $runtime
    Write-Host 'Open http://127.0.0.1:4173/ in the browser on this computer.'
    Write-Host 'Use stop-preview.cmd to stop. Trial edits remain in the snapshot only.'
}finally{
    if($null -ne $sourceLock){$sourceLock.Dispose()}
    if($null -ne $lock){$lock.Dispose()}
}
