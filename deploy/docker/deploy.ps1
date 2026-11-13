#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Prepare','Start','Stop','Status','Logs')][string]$Action='Start',
    [string]$AppId='',
    [string]$RuntimeDirectory=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Invoke-Docker {
    param([string[]]$Arguments,[switch]$Capture)
    if($Capture){$result=& docker @Arguments;if($LASTEXITCODE -ne 0){throw 'Docker command failed.'};return ($result -join "`n")}
    & docker @Arguments
    if($LASTEXITCODE -ne 0){throw 'Docker command failed. Check the output above; deployment is not complete.'}
}
function Write-Json($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30)+"`n",(New-Object Text.UTF8Encoding($false)))}
function New-Secret {
    $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
    return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
}
function Private-Path([string]$Value){
    if(-not $Value -or $Value -match '[\\:]' -or $Value.StartsWith('/') -or @($Value.Split('/')|Where-Object { -not $_ -or $_.StartsWith('.') }).Count){throw 'Runtime paths must stay below the external runtime directory.'}
    return Join-Path $runtime $Value
}
function Assert-NoLink([string]$Path){
    $current=$Path
    while($current){
        if(Test-Path -LiteralPath $current){$item=Get-Item -LiteralPath $current -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime and delivery paths cannot contain links.'}}
        $parent=Split-Path -Parent $current;if($parent -eq $current){break};$current=$parent
    }
}
$package=(Get-Item -LiteralPath $PSScriptRoot).FullName
if(-not $RuntimeDirectory){$RuntimeDirectory=Join-Path (Split-Path -Parent $package) 'planhub-runtime'}
$runtime=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDirectory).TrimEnd('\','/')
if($runtime -eq [IO.Path]::GetPathRoot($runtime).TrimEnd('\','/')){throw 'Runtime directory must be below a filesystem root.'}
if($runtime -eq $package -or $runtime.StartsWith($package+'\',[StringComparison]::OrdinalIgnoreCase) -or $package.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime data must be outside the delivery directory.'}
Assert-NoLink $runtime
$manifest=Get-Content -LiteralPath (Join-Path $package 'delivery.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'linux/amd64'){throw 'Unsupported delivery manifest.'}
$expectedFiles=@('compose.json','images.tar','README.md','deploy.ps1','start.cmd','stop.cmd','runtime.example.json')
if(@($manifest.files.PSObject.Properties).Count -ne $expectedFiles.Count){throw 'Unexpected delivery file manifest.'}
foreach($name in $expectedFiles){
    if($null -eq $manifest.files.PSObject.Properties[$name]){throw "Missing delivery checksum: $name"}
    $file=Join-Path $package $name;Assert-NoLink $file
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.files.$name){throw "Delivery file is damaged: $name"}
}
foreach($id in $manifest.applications){if($id -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $id -eq 'network'){throw 'Invalid application ID.'}}
[void][IO.Directory]::CreateDirectory($runtime)
$lock=$null
try {
try{$lock=[IO.File]::Open((Join-Path $runtime 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Another deployment is using this runtime directory. Wait for it to finish.'}
$configFile=Join-Path $runtime 'config.json'
if(-not(Test-Path -LiteralPath $configFile)){
    $config=Get-Content -LiteralPath (Join-Path $package 'runtime.example.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $config.proxySecret=New-Secret;$config.sopSecret=New-Secret;$config.vehicleSecret=New-Secret
    Write-Json $configFile $config
    foreach($dir in @('config','data','shared')){[void][IO.Directory]::CreateDirectory((Join-Path $runtime $dir))}
    Write-Host "Created external configuration: $configFile"
}
if($Action -eq 'Prepare'){Write-Host 'Set publicOrigin, supply real shared rules/data, then run start.cmd.';return}
$config=Get-Content -LiteralPath $configFile -Raw -Encoding UTF8|ConvertFrom-Json
if($Action -eq 'Start'){
$origin=[Uri]$config.publicOrigin
if($config.schemaVersion -ne 1 -or $origin.Scheme -notin @('http','https') -or $origin.Authority -eq '' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/' -or $config.publicOrigin.EndsWith('/') -or $origin.Host.EndsWith('.invalid')){throw "Set the real company publicOrigin in $configFile (without a path or trailing slash)."}
foreach($name in @('proxySecret','sopSecret','vehicleSecret')){if($config.$name -cnotmatch '^[A-Za-z0-9_-]{32,}$'){throw "Invalid external secret: $name"}}
foreach($name in @('sharedDirectory','sopSharedConfig','quicklookSourceBase')){Assert-NoLink (Private-Path $config.$name)}
if($Action -eq 'Start' -and 'sop' -in $manifest.applications -and -not(Test-Path -LiteralPath (Private-Path $config.sopSharedConfig) -PathType Leaf)){throw 'Provide the real shared_config.py at the configured external path before starting SOP.'}
}
if($config.port -isnot [int] -or $config.port -lt 1 -or $config.port -gt 65535){throw 'Invalid public port.'}
$listen=$null;if(-not [Net.IPAddress]::TryParse($config.listenAddress,[ref]$listen)){throw 'listenAddress must be an IP address.'}
$engine=Invoke-Docker -Arguments @('info','--format','{{.OSType}}/{{.Architecture}}') -Capture
if($engine -notmatch '^linux/(x86_64|amd64)$'){throw 'Start Docker using Linux containers on x86_64/amd64.'}
$composeVersion=Invoke-Docker -Arguments @('compose','version','--short') -Capture
if($composeVersion -notmatch '^v?(\d+)\.(\d+)\.' -or [int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 20)){throw 'Docker Compose 2.20 or newer is required.'}
$env:PLANHUB_RUNTIME=$runtime.Replace('\','/');$env:PLANHUB_PORT=[string]$config.port;$env:PLANHUB_BIND=[string]$config.listenAddress
$compose=@('compose','--project-name','planhub','--file',(Join-Path $package 'compose.json'))
Invoke-Docker -Arguments ($compose+@('config','--quiet'))
$existingIds=Invoke-Docker -Arguments @('ps','-aq','--filter','label=com.docker.compose.project=planhub') -Capture
foreach($existingId in @($existingIds -split "`n" | Where-Object {$_})){
    $existing=@((Invoke-Docker -Arguments @('inspect',$existingId) -Capture)|ConvertFrom-Json)[0]
    if($null -eq $existing.Config.Labels.PSObject.Properties['planhub.runtime'] -or $existing.Config.Labels.'planhub.runtime' -cne $env:PLANHUB_RUNTIME){throw 'Compose project planhub contains containers not owned by this runtime directory.'}
}
$networkId=Invoke-Docker -Arguments @('ps','-aq','--filter','label=com.docker.compose.project=planhub','--filter','label=com.docker.compose.service=network') -Capture
if($networkId){
    $network=@((Invoke-Docker -Arguments @('inspect',$networkId) -Capture)|ConvertFrom-Json)[0]
    if($network.Config.Labels.'planhub.runtime' -cne $env:PLANHUB_RUNTIME){throw 'An existing PlanHub uses a different data directory. Keep its verified runtime path.'}
}
$stateFile=Join-Path $runtime 'deployment-state.json'
$configHash=(Get-FileHash -LiteralPath $configFile).Hash
if($Action -eq 'Status'){Invoke-Docker -Arguments ($compose+@('ps','-a'));return}
if($Action -eq 'Logs'){
    if($AppId -and $AppId -notin $manifest.applications){throw 'AppId is not included in this delivery.'}
    $selected=if($AppId){@($AppId)}else{@($manifest.applications)}
    Invoke-Docker -Arguments ($compose+@('logs','--tail','100')+$selected);return
}
if($Action -eq 'Stop'){
    Invoke-Docker -Arguments ($compose+@('stop')+@($manifest.applications))
    if($manifest.complete){Invoke-Docker -Arguments ($compose+@('stop','network'))}
    Write-Host 'Selected services stopped. Persistent data retained.';return
}
if(-not $manifest.complete){
    if(-not $networkId -or -not $network.State.Running -or -not(Test-Path -LiteralPath $stateFile)){throw 'First deployment requires a complete package (selection 0 on A).'}
    $state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($state.configHash -cne $configHash){throw 'Runtime configuration changed. Use a complete package to restart the whole stack consistently.'}
    if($state.contractHash -cne $manifest.contractHash){throw 'Application ports or startup contracts changed. Use a complete package.'}
    if($network.Image -cne $manifest.images.network.id){throw 'Network runtime changed. Use a complete package.'}
}
Invoke-Docker -Arguments @('image','load','--input',(Join-Path $package 'images.tar'))
foreach($property in $manifest.images.PSObject.Properties){
    $image=$property.Value
    $actual=Invoke-Docker -Arguments @('image','inspect','--format','{{.Id}}',$image.tag) -Capture
    if($actual -cne $image.id){throw 'Loaded image differs from the delivery manifest.'}
}
# No service is stopped until package, data paths and images have passed preflight.
if($manifest.complete -and (Test-Path -LiteralPath $stateFile)){
    $previous=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json
    if(@($previous.applications|Where-Object {$_ -notin $manifest.applications}).Count){throw 'Removing an installed application requires an explicit retirement procedure.'}
}
Invoke-Docker -Arguments ($compose+@('stop')+@($manifest.applications))
try{
    if($manifest.complete){
        Invoke-Docker -Arguments ($compose+@('stop','network'))
        Invoke-Docker -Arguments ($compose+@('up','-d','--wait','--wait-timeout','180'))
    }else{Invoke-Docker -Arguments ($compose+@('up','-d','--no-deps','--wait','--wait-timeout','180')+@($manifest.applications))}
}catch{
    $stopArguments=$compose+@('stop')+@($manifest.applications)
    & docker @stopArguments | Out-Host
    throw
}
Invoke-Docker -Arguments ($compose+@('ps'))
$installed=if($manifest.complete){@($manifest.applications)}else{@($state.applications)+@($manifest.applications)|Select-Object -Unique}
Write-Json $stateFile ([ordered]@{configHash=$configHash;contractHash=$manifest.contractHash;applications=@($installed);lastDelivery=$package;updatedAt=[DateTime]::UtcNow.ToString('o')})
Write-Host 'Containers are healthy. Finish the company gateway connection and browser acceptance.'
Write-Host ('Public URL: '+$config.publicOrigin)
}finally{if($null -ne $lock){$lock.Dispose()}}
