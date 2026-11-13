#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Start','Stop')][string]$Action='Start',
    [switch]$Snapshot,
    [switch]$RefreshSnapshot,
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
    if($LASTEXITCODE -ne 0){throw 'Native preview failed. Check the output and snapshot logs above.'}
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
if(-not $manifest.complete){throw 'Use a complete package built with selection 0 for local preview.'}
$node=Join-Path $package 'runtime/node/node.exe';No-Link $node
if(-not(Test-Path -LiteralPath $node -PathType Leaf)){throw 'Bundled Windows Node.js is missing. Copy the complete delivery folder again.'}
if($Action -eq 'Start' -and -not $Snapshot){throw 'Local preview requires the explicit -Snapshot option. Use preview.cmd.'}
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
    $sourceConfig=Join-Path $source 'config.json';No-Link $sourceConfig
    if(-not(Test-Path -LiteralPath $sourceConfig -PathType Leaf)){throw 'Run prepare.cmd, then place shared rules and data as described in step 3 before local preview.'}
    $user=Actor
    $settings=Read-Json $sourceConfig
    if($null -ne $settings.PSObject.Properties['preview']){throw 'The snapshot source must be the original formal runtime configuration.'}
    $sourceHash=(Get-FileHash -LiteralPath $sourceConfig).Hash
    if($null -ne $state -and -not $RefreshSnapshot){
        if($state.sourceConfigHash -cne $sourceHash -or $state.contractHash -cne $manifest.contractHash -or (@($state.applications|Sort-Object) -join ',') -cne (@($manifest.applications|Sort-Object) -join ',')){throw 'Source configuration or applications changed. Run preview.cmd -RefreshSnapshot.'}
        Write-Host ('Reusing local snapshot: '+$runtime)
        if($previewConfig.port -eq 4174 -and $previewConfig.publicOrigin -ceq 'http://127.0.0.1:4174'){
            Native 'stop' $runtime
            $previewConfig.port=4173;$previewConfig.publicOrigin='http://127.0.0.1:4173'
            Save-Json (Join-Path $runtime 'config.json') $previewConfig
            Write-Host 'Local preview now uses port 4173. Existing trial data retained.'
        }
        if($previewConfig.preview.user -cne $user){Native 'stop' $runtime;$previewConfig.preview.user=$user;Save-Json (Join-Path $runtime 'config.json') $previewConfig}
    }else{
        if($null -ne $state){
            Native 'stop' $runtime
        }
        No-Link (Join-Path $source 'deployment.lock')
        try{$sourceLock=[IO.File]::Open((Join-Path $source 'deployment.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)}catch{throw 'Source runtime is busy or not prepared. Complete step 3 Prepare and wait for any deployment to finish.'}
        if((Get-FileHash -LiteralPath $sourceConfig).Hash -cne $sourceHash){throw 'Source configuration changed during snapshot preparation. Retry preview.cmd.'}
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
        if($base -cne $settings.sharedDirectory -and -not $base.StartsWith(([string]$settings.sharedDirectory)+'/',[StringComparison]::Ordinal) -and $base -cne 'data' -and -not $base.StartsWith('data/',[StringComparison]::Ordinal)){throw 'quicklookSourceBase must stay within the copied shared directory or data directory for native preview.'}
        if(-not(Test-Path -LiteralPath $rules -PathType Leaf)){throw 'Place the real shared_config.py at the configured source path before preview.'}
        if(-not(Test-Path -LiteralPath $shared -PathType Container)){throw 'Prepare the shared data directory before preview.'}
        $data=Join-Path $source 'data'
        Assert-CopyTree $shared;Assert-CopyTree $data;No-Link $rules
        $snapshotName='snapshot-'+[Guid]::NewGuid().ToString('N')
        $runtime=Join-Path $previewRoot $snapshotName
        [void][IO.Directory]::CreateDirectory($runtime)
        Write-Host 'Copying rules, shared inputs and application data into a local test snapshot...'
        Copy-Tree $shared (Join-Path $runtime $settings.sharedDirectory)
        Copy-Tree $data (Join-Path $runtime 'data')
        $targetRules=Join-Path $runtime $settings.sopSharedConfig
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $targetRules))
        Copy-Item -LiteralPath $rules -Destination $targetRules -Force
        $settings.publicOrigin='http://127.0.0.1:4173';$settings.listenAddress='127.0.0.1';$settings.port=4173
        $settings.proxySecret=Secret;$settings.sopSecret=Secret;$settings.vehicleSecret=Secret
        $settings|Add-Member -NotePropertyName preview -NotePropertyValue ([pscustomobject]@{schemaVersion=1;user=$user;sourceDirectory=$source;createdAt=[DateTime]::UtcNow.ToString('o')})
        Save-Json (Join-Path $runtime 'config.json') $settings
        $state=[ordered]@{schemaVersion=1;snapshot=$snapshotName;sourceDirectory=$source;sourceConfigHash=$sourceHash;contractHash=$manifest.contractHash;applications=@($manifest.applications)}
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
