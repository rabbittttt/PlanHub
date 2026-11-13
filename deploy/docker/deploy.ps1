#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Validate','Prepare','Start','Stop','Status','Logs')][string]$Action='Start',
    [string]$AppId='',
    [string]$RuntimeDirectory=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'delivery-common.ps1')
$package=(Get-Item -LiteralPath $PSScriptRoot).FullName
$manifest=Read-Delivery $package
if($Action -eq 'Validate'){return $manifest}
$runtime=Get-DeliveryRuntime $package $RuntimeDirectory
function New-Secret {
    $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
    return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
}
function Private-Path([string]$Value){
    if(-not $Value -or $Value -match '[\\:]' -or $Value.StartsWith('/') -or @($Value.Split('/')|Where-Object {-not $_ -or $_.StartsWith('.')}).Count){throw 'Runtime paths must stay below the external runtime directory.'}
    $result=Join-Path $runtime $Value;Assert-DeliveryNoLink $result;return $result
}
[void][IO.Directory]::CreateDirectory($runtime)
$lock=$null
try {
    $lockFile=Join-Path $runtime 'deployment.lock';Assert-DeliveryNoLink $lockFile
    try{$lock=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Another command is using this runtime. Wait for it to finish.'}
    $configFile=Join-Path $runtime 'config.json';Assert-DeliveryNoLink $configFile
    if(-not(Test-Path -LiteralPath $configFile)){
        if($Action -ne 'Prepare'){throw 'Run prepare.cmd and supply the real rules/data first.'}
        $config=Get-Content -LiteralPath (Join-Path $package 'runtime.example.json') -Raw -Encoding UTF8|ConvertFrom-Json
        $config.proxySecret=New-Secret;$config.sopSecret=New-Secret;$config.vehicleSecret=New-Secret
        Write-DeliveryJson $configFile $config
    }
    $config=Get-Content -LiteralPath $configFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($null -ne $config.PSObject.Properties['preview']){throw 'Preview snapshots cannot be used for formal deployment.'}
    foreach($name in @('sharedDirectory','sopSharedConfig','quicklookSourceBase')){$null=Private-Path $config.$name}
    if($Action -eq 'Prepare'){
        foreach($dir in @('config','data',$config.sharedDirectory)){[void][IO.Directory]::CreateDirectory((Join-Path $runtime $dir))}
        foreach($id in $manifest.applications){if($id -ne 'planhub' -and $id -ne 'leads'){[void][IO.Directory]::CreateDirectory((Join-Path $runtime ('data/'+$id)))}}
        Write-Host ('Data directory prepared: '+$runtime)
        Write-Host 'Supply rules and data, then use preview.cmd for local testing. Docker is not required.'
        return
    }
    if($AppId -and $AppId -notin $manifest.applications){throw 'AppId is not included in this delivery.'}
    $selected=if($AppId){@($AppId)}else{@($manifest.applications)}
    $wholeStack=$manifest.complete -and -not $AppId
    if($Action -eq 'Start'){
        $origin=[Uri]$config.publicOrigin
        if($config.schemaVersion -ne 1 -or $origin.Scheme -notin @('http','https') -or -not $origin.Authority -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/' -or $config.publicOrigin.EndsWith('/') -or $origin.Host.EndsWith('.invalid')){throw ('Set the real company publicOrigin in '+$configFile+' without a path or trailing slash.')}
        foreach($name in @('proxySecret','sopSecret','vehicleSecret')){if($config.$name -cnotmatch '^[A-Za-z0-9_-]{32,}$'){throw ('Invalid external secret: '+$name)}}
        if('sop' -in $selected -and -not(Test-Path -LiteralPath (Private-Path $config.sopSharedConfig) -PathType Leaf)){throw 'Provide the real shared_config.py at the configured external path before starting SOP.'}
    }
    if($config.port -isnot [int] -or $config.port -lt 1 -or $config.port -gt 65535){throw 'Invalid public port.'}
    $listen=$null;if(-not [Net.IPAddress]::TryParse($config.listenAddress,[ref]$listen)){throw 'listenAddress must be an IP address.'}
    Assert-DeliveryDocker
    $env:PLANHUB_RUNTIME=$runtime.Replace('\','/');$env:PLANHUB_PORT=[string]$config.port;$env:PLANHUB_BIND=[string]$config.listenAddress
    $compose=@('compose','--project-name','planhub','--file',(Join-Path $package 'compose.json'))
    Invoke-DeliveryDocker -Arguments ($compose+@('config','--quiet'))
    $existingIds=Invoke-DeliveryDocker -Arguments @('ps','-aq','--filter','label=com.docker.compose.project=planhub') -Capture
    foreach($existingId in @($existingIds -split "\n"|Where-Object {$_})){
        $existing=@((Invoke-DeliveryDocker -Arguments @('inspect',$existingId) -Capture)|ConvertFrom-Json)[0]
        if($null -eq $existing.Config.Labels.PSObject.Properties['planhub.runtime'] -or $existing.Config.Labels.'planhub.runtime' -cne $env:PLANHUB_RUNTIME){throw 'Compose project contains containers owned by another runtime.'}
    }
    $stateFile=Join-Path $runtime 'deployment-state.json';Assert-DeliveryNoLink $stateFile
    $activeFile=Join-Path $runtime 'deployment-active.json';Assert-DeliveryNoLink $activeFile
    if($Action -eq 'Status'){Invoke-DeliveryDocker -Arguments ($compose+@('ps','-a'));return}
    if($Action -eq 'Logs'){Invoke-DeliveryDocker -Arguments ($compose+@('logs','--tail','100')+$selected);return}
    if($Action -eq 'Stop'){
        Invoke-DeliveryDocker -Arguments ($compose+@('stop')+$selected)
        if($wholeStack){
            Invoke-DeliveryDocker -Arguments ($compose+@('stop','network'))
            # Older complete folders can coexist with a later installed app set.
            # Every project container above has already passed the runtime ownership check.
            $ownedIds=@($existingIds -split "\n"|Where-Object {$_})
            if($ownedIds.Count){Invoke-DeliveryDocker -Arguments (@('stop')+$ownedIds)}
            if(Test-Path -LiteralPath $stateFile){$state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json;$state|Add-Member -Force -NotePropertyName running -NotePropertyValue $false;Write-DeliveryJson $stateFile $state}
            Write-DeliveryJson $activeFile ([ordered]@{schemaVersion=1;mayBeRunning=$false;updatedAt=[DateTime]::UtcNow.ToString('o')})
        }
        Write-Host 'Selected services stopped. Persistent data retained.'
        return
    }
    $deliveryHash=(Get-FileHash -LiteralPath (Join-Path $package 'delivery.json')).Hash.ToLowerInvariant()
    $buildFile=Join-Path $runtime ('docker-images/'+$deliveryHash+'.json');Assert-DeliveryNoLink $buildFile
    if(-not(Test-Path -LiteralPath $buildFile -PathType Leaf)){throw 'The deployment colleague must run build-docker.cmd successfully before start.cmd.'}
    $build=Get-Content -LiteralPath $buildFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($build.schemaVersion -ne 1 -or $build.deliveryHash -cne $deliveryHash -or @($build.images.PSObject.Properties).Count -ne @($manifest.images.PSObject.Properties).Count){throw 'Docker build record does not match this delivery.'}
    foreach($entry in $manifest.images.PSObject.Properties){
        $image=$entry.Value;$built=$build.images.PSObject.Properties[$entry.Name]
        if($null -eq $built -or $built.Value.tag -cne $image.tag -or $built.Value.fingerprint -cne $image.fingerprint){throw 'Docker build record has different image content.'}
        $actual=@((Invoke-DeliveryDocker -Arguments @('image','inspect',$image.tag) -Capture)|ConvertFrom-Json)[0]
        if($actual.Id -cne $built.Value.id -or $actual.Config.Labels.'planhub.fingerprint' -cne $image.fingerprint -or $actual.Os -cne 'linux' -or $actual.Architecture -cne 'amd64'){throw 'Docker image differs from the successful build. Run build-docker.cmd again.'}
    }
    $configHash=(Get-FileHash -LiteralPath $configFile).Hash
    $state=$null;if(Test-Path -LiteralPath $stateFile){$state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json}
    if(-not $wholeStack){
        if($null -eq $state -or -not $state.running){throw 'First deployment requires a complete package (selection 0 on A).'}
        if($state.configHash -cne $configHash -or $state.contractHash -cne $manifest.contractHash){throw 'Runtime configuration or startup contracts changed. Use a complete package.'}
        $networkId=Invoke-DeliveryDocker -Arguments @('ps','-aq','--filter','label=com.docker.compose.project=planhub','--filter','label=com.docker.compose.service=network') -Capture
        if(-not $networkId){throw 'The shared network service is not running. Use a complete package.'}
        $network=@((Invoke-DeliveryDocker -Arguments @('inspect',$networkId) -Capture)|ConvertFrom-Json)[0]
        if(-not $network.State.Running -or $network.Image -cne $build.images.network.id){throw 'Network runtime changed or is stopped. Use a complete package.'}
    }
    if($wholeStack -and $null -ne $state -and @($state.applications|Where-Object {$_ -notin $manifest.applications}).Count){throw 'Removing an installed application requires an explicit retirement procedure.'}
    # Image, ownership and configuration checks finish before any service is stopped.
    # This conservative marker survives an interrupted first startup, before a success record exists.
    Write-DeliveryJson $activeFile ([ordered]@{schemaVersion=1;mayBeRunning=$true;updatedAt=[DateTime]::UtcNow.ToString('o')})
    Invoke-DeliveryDocker -Arguments ($compose+@('stop')+$selected)
    try{
        if($wholeStack){
            Invoke-DeliveryDocker -Arguments ($compose+@('stop','network'))
            Invoke-DeliveryDocker -Arguments ($compose+@('up','-d','--wait','--wait-timeout','180'))
        }else{Invoke-DeliveryDocker -Arguments ($compose+@('up','-d','--no-deps','--wait','--wait-timeout','180')+$selected)}
    }catch{
        $stopArguments=$compose+@('stop')+$selected;& docker @stopArguments|Out-Host
        throw
    }
    Invoke-DeliveryDocker -Arguments ($compose+@('ps'))
    $installed=if($wholeStack){@($manifest.applications)}else{@($state.applications)+$selected|Select-Object -Unique}
    Write-DeliveryJson $stateFile ([ordered]@{running=$true;configHash=$configHash;contractHash=$manifest.contractHash;applications=@($installed);lastDelivery=$package;updatedAt=[DateTime]::UtcNow.ToString('o')})
    Write-Host 'Containers are healthy. Finish the company gateway connection and browser acceptance.'
    Write-Host ('Public URL: '+$config.publicOrigin)
}finally{if($null -ne $lock){$lock.Dispose()}}
