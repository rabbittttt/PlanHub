#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppId='',
    [string]$Version='',
    [string]$ReleasePath='',
    [string]$ConfigPath='',
    [ValidateSet('','Package','Send','Deploy','SendExisting','DeployExisting')][string]$Action='',
    [switch]$NonInteractive
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Publish.Common.ps1')
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (-not $ConfigPath) { $ConfigPath=Join-Path $root 'config.local/publish.json' }
$ConfigPath=Resolve-PublishPath $ConfigPath $root
if (-not(Test-Path -LiteralPath $ConfigPath)) {
    if($NonInteractive) { throw 'Create config.local/publish.json from deploy/publish.example.json before running unattended.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'publish.example.json') -Destination $ConfigPath
    Write-Host "已创建本机发布配置：$ConfigPath"
}
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$registry=Get-Content -LiteralPath (Join-Path $root 'portal/config/apps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$apps=@([pscustomobject]@{id='planhub';name='计划工作台门户'})
$apps+=@($registry.groups | ForEach-Object {$_.apps} | Where-Object {$_.enabled})
if (-not $AppId) {
    if($NonInteractive){throw 'AppId is required.'}
    for($i=0;$i -lt $apps.Count;$i++){Write-Host ("{0}. {1} ({2})" -f ($i+1),$apps[$i].name,$apps[$i].id)}
    $selected=Read-Host '选择需要发布的应用编号'
    $number=0
    if(-not[int]::TryParse($selected,[ref]$number) -or $number -lt 1 -or $number -gt $apps.Count){throw 'Invalid selection.'}
    $AppId=$apps[$number-1].id
}
Assert-PublishId $AppId
if(-not @($apps | Where-Object {$_.id -ceq $AppId}).Count){throw 'Register the application before publishing it.'}
if(-not $Action) {
    $Action='Package'
}
if($Action -ne 'Package' -and -not(Get-PublishValue $config 'inbox' '')) {
    if($NonInteractive){throw 'Set inbox in the private publish config before sending.'}
    $inbox=Read-Host 'B 电脑收件共享目录，或本机中转目录（可以是相对路径）'
    $null=Resolve-PublishPath $inbox $root
    $config | Add-Member -NotePropertyName inbox -NotePropertyValue $inbox -Force
    Write-AppReleaseJson $ConfigPath $config
}
if($Action -in @('Deploy','DeployExisting')) {
    $remote=Get-PublishValue $config 'remote'
    foreach($field in @('computerName','toolsRoot','configPath','inboxLocalPath')) {
        if(-not(Get-PublishValue $remote $field '')){throw "Configure remote.$field first. This tool never enables WinRM."}
    }
    if(-not $NonInteractive) {
        Write-Host '将使用当前 Windows 身份在 B 电脑切换此应用。请先等正在进行的保存、上传及后台写入结束。'
        if((Read-Host '确认执行远程部署？输入 Y') -cne 'Y'){throw 'Deployment cancelled.'}
    }
}
if($Action -in @('SendExisting','DeployExisting')){
    if(-not $ReleasePath){
        if($NonInteractive){throw 'ReleasePath is required when sending an existing package.'}
        $ReleasePath=Read-Host '已有发布包目录（例如 staging/releases/leads-版本号）'
    }
    $existing=Assert-AppRelease (Resolve-PublishPath $ReleasePath $root)
    if($existing.Manifest.appId -cne $AppId){throw 'Selected package belongs to a different application.'}
    if($Version -and $existing.Manifest.version -cne $Version){throw 'Requested version differs from the selected package.'}
    return & (Join-Path $PSScriptRoot 'Send-AppRelease.ps1') -ReleasePath $existing.Root -ConfigPath $ConfigPath -ApplyRemote:($Action -eq 'DeployExisting')
}
$explicitVersion=!!$Version
if(-not $Version){$Version=Get-Date -Format 'yyyyMMdd-HHmmss-fff'}
Assert-PublishVersion $Version
$profile=Get-PublishValue (Get-PublishValue $config 'applications') $AppId ([pscustomobject]@{})
$kind=[string](Get-PublishValue $profile 'kind' '')
if(-not $ReleasePath){$ReleasePath=[string](Get-PublishValue $profile 'releasePath' '')}
if(-not $ReleasePath -and -not $kind){
    # New static apps can use the registered collector; dynamic apps need a source-owned release.
    $integration=Get-Content -LiteralPath (Join-Path $root 'integration/apps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $binding=Get-PublishValue $integration.applications $AppId
    $type=Get-PublishValue $binding 'type' ''
    $localMap=Join-Path $root 'config.local/apps.json'
    if(Test-Path -LiteralPath $localMap){
        $local=Get-Content -LiteralPath $localMap -Raw -Encoding UTF8 | ConvertFrom-Json
        $localBinding=Get-PublishValue $local.applications $AppId
        $type=Get-PublishValue $localBinding 'type' $type
    }
    if($type -eq 'static'){$kind='static'}
    elseif($NonInteractive){throw 'Configure applications.<id>.releasePath or a source-owned build command in publish.json.'}
    else{$ReleasePath=Read-Host '请输入原项目已生成的发布包目录（不选择整个源码目录）'}
}
$built=$null
if($ReleasePath){
    $prepared=Resolve-PublishPath $ReleasePath $root
    if(Test-Path -LiteralPath (Join-Path $prepared 'app-release.json')){$kind='release'}
    elseif(Test-Path -LiteralPath (Join-Path $prepared 'sop-release.json')){$kind='sop'}
    elseif($kind -ne 'payload'){throw 'Missing release manifest. Configure an explicitly prepared payload with kind=payload.'}
} elseif($kind -eq 'portal') {
    if($AppId -ne 'planhub'){throw 'Only planhub can use the portal profile.'}
    $sourcePortal=Join-Path $root 'portal'
    $prepared=Join-Path $root ("staging/build/planhub-"+$Version)
    if(Test-Path -LiteralPath $prepared){throw 'Portal build output exists. Use a new version.'}
    $portalFiles=Get-AppPayloadFiles $sourcePortal
    foreach($relative in $portalFiles.Keys){
        $target=Join-Path $prepared $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $portalFiles[$relative] -Destination $target
    }
    # Only the portal's own reviewed baseline is added. Host-specific proxy/auth stays on B.
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portal.web.config') -Destination (Join-Path $prepared 'web.config')
} elseif($kind -eq 'static') {
    & node (Join-Path $root 'scripts/prepare-apps.mjs') $AppId | Out-Host
    if($LASTEXITCODE -ne 0){throw 'Static application collection failed.'}
    $prepared=Join-Path $root ("apps/"+$AppId)
} else {
    $builder=Get-PublishValue $profile 'build'
    if(-not $builder){throw 'Provide a prepared releasePath or configure the original project build command.'}
    $command=Resolve-PublishPath ([string]$builder.command) $root
    $cwdValue=[string](Get-PublishValue $builder 'cwd' (Get-PublishValue $profile 'sourceRoot' ''))
    $cwd=Resolve-PublishPath $cwdValue $root
    if(-not(Test-Path -LiteralPath $command -PathType Leaf)){throw 'Configured build executable is missing.'}
    Assert-NoReparsePoint $cwd
    $prepared=Join-Path $root ("staging/build/"+$AppId+"-"+$Version)
    if(Test-Path -LiteralPath $prepared){throw 'Build output exists. Use a new version.'}
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $prepared) | Out-Null
    $arguments=@($builder.args | ForEach-Object {([string]$_).Replace('{version}',$Version).Replace('{output}',$prepared)})
    Push-Location -LiteralPath $cwd
    try {
        $global:LASTEXITCODE=0
        & $command @arguments | Out-Host
        if($LASTEXITCODE -ne 0){throw 'The original project build failed. Nothing has been sent or deployed.'}
    } finally {Pop-Location}
}
if($kind -eq 'release'){
    $built=Assert-AppRelease $prepared
    if($built.Manifest.appId -cne $AppId){throw 'Selected release belongs to a different application.'}
    if($explicitVersion -and $built.Manifest.version -cne $Version){throw 'Requested version differs from the immutable release manifest.'}
    $Version=$built.Manifest.version
}
$destination=Join-Path $root ("staging/releases/"+$AppId+"-"+$Version)
if(Test-Path -LiteralPath $destination){throw 'Packaged version already exists. Send it with Send-AppRelease.ps1 or choose a new version.'}
if($kind -eq 'release'){
    $final=Copy-ValidatedRelease $built $destination
} else {
    if($kind -eq 'sop') {
        if($AppId -ne 'sop'){throw 'SOP format is only valid for sop.'}
        $sop=Assert-SopRelease $prepared
        $payload=Join-Path $destination 'payload'
        foreach($relative in $sop.Files.Keys){
            $to=Join-Path $payload $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
            Copy-Item -LiteralPath $sop.Files[$relative] -Destination $to
        }
        $revision=if($sop.Manifest.sourceCommit){[string]$sop.Manifest.sourceCommit+$(if($sop.Manifest.sourceDirty){'-dirty'}else{''})}else{'sop-prepared-'+$Version}
        $manifest=New-AppManifest -PayloadPath $payload -AppId $AppId -Version $Version -Type service -EntryPoint server.py -SourceRevision $revision -DataMode external -HealthPath ([string](Get-PublishValue $profile 'healthPath' '/api/health'))
        Write-AppReleaseJson (Join-Path $destination 'app-release.json') $manifest
        $final=Assert-AppRelease $destination
    } else {
        $static=$kind -in @('portal','static')
        $type=if($static){'static'}else{[string](Get-PublishValue $profile 'type' 'service')}
        $entry=if($static){'index.html'}else{[string](Get-PublishValue $profile 'entryPoint' '')}
        $mode=if($static){'stateless'}else{[string](Get-PublishValue $profile 'dataMode' '')}
        $health=if($static){'/'}else{[string](Get-PublishValue $profile 'healthPath' '')}
        $revision=[string](Get-PublishValue $profile 'sourceRevision' '')
        if(-not $revision){
            $source=[string](Get-PublishValue $profile 'sourceRoot' '')
            if($kind -eq 'portal'){$source=$root}
            if($source){$revision=Get-PublishRevision (Resolve-PublishPath $source $root)}
            else{$revision='prepared-entry-sha256:'+(Get-FileHash -LiteralPath (Join-Path $prepared $entry) -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        & (Join-Path $PSScriptRoot 'New-AppRelease.ps1') -PayloadPath $prepared -Destination $destination -AppId $AppId -Version $Version -Type $type -EntryPoint $entry -SourceRevision $revision -DataMode $mode -HealthPath $health | Out-Host
        $final=Assert-AppRelease $destination
    }
}
Write-Host "发布包已生成：$destination"
if($Action -ne 'Package'){
    & (Join-Path $PSScriptRoot 'Send-AppRelease.ps1') -ReleasePath $destination -ConfigPath $ConfigPath -ApplyRemote:($Action -eq 'Deploy') | Out-Host
} else { Write-Host '尚未部署。正式数据、机器配置和运行环境不在此包中。' }
[pscustomobject]@{appId=$AppId;version=$Version;releasePath=$destination;action=$Action}
