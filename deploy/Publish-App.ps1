#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppId='',
    [string]$Version='',
    [string]$ReleasePath='',
    [string]$ConfigPath='',
    [ValidateSet('','Package')][string]$Action='',
    [switch]$NonInteractive,
    [switch]$All,
    [switch]$BuildOnly
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
$runtimePython=Resolve-PublishPath ([string](Get-PublishValue $config 'runtimePython' '../.venv/Scripts/python.exe')) $root
$registry=Get-Content -LiteralPath (Join-Path $root 'portal/config/apps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$apps=@([pscustomobject]@{id='planhub';name='计划工作台门户'})
$apps+=@($registry.groups | ForEach-Object {$_.apps} | Where-Object {$_.enabled})
if (-not $AppId -and -not $All) {
    if($NonInteractive){throw 'AppId is required.'}
    Write-Host '0. 打包全部应用及 Windows 运行环境（首次交付选此项）'
    Write-Host '其他编号用于单个应用更新：'
    for($i=0;$i -lt $apps.Count;$i++){Write-Host ("{0}. {1} ({2})" -f ($i+1),$apps[$i].name,$apps[$i].id)}
    $selected=Read-Host '选择需要发布的应用编号'
    $number=0
    if(-not[int]::TryParse($selected,[ref]$number) -or $number -lt 0 -or $number -gt $apps.Count){throw 'Invalid selection.'}
    if($number -eq 0){$All=$true}else{$AppId=$apps[$number-1].id}
}
if($All) {
    if($AppId -or $ReleasePath){throw 'All cannot be combined with AppId or ReleasePath.'}
    if($Action -and $Action -ne 'Package'){throw 'All supports packaging only. Send or deploy packages individually.'}
    if($Version){Assert-PublishVersion $Version}
    $completed=@()
    $failures=@()
    foreach($app in $apps) {
        Write-Host ("`n正在打包：{0} ({1})" -f $app.name,$app.id)
        $parameters=@{AppId=$app.id;ConfigPath=$ConfigPath;Action='Package';NonInteractive=$true;BuildOnly=$true}
        # Prepared immutable releases retain their own version unless one is requested.
        if($Version){$parameters.Version=$Version}
        try {
            $completed+=& $PSCommandPath @parameters
        } catch {
            $message=$_.Exception.Message
            $failures+=[pscustomobject]@{appId=$app.id;message=$message}
            Write-Host ("打包失败：{0}；{1}" -f $app.id,$message)
        }
    }
    Write-Host ("`n打包汇总：成功 {0}，失败 {1}。" -f $completed.Count,$failures.Count)
    foreach($item in $completed){Write-Host ("已校验 {0} {1}" -f $item.appId,$item.version)}
    foreach($item in $failures){Write-Host ("失败 {0}：{1}" -f $item.appId,$item.message)}
    if($failures.Count){throw 'Some applications could not be packaged. See the summary above; this batch is incomplete.'}
    Write-Host '正在整理应用及 Windows 运行环境；此步骤不需要 Docker。'
    $bundleDestination=Join-Path $root ('release/planhub-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    & node (Join-Path $root 'scripts/build-delivery.mjs') --complete --python $runtimePython $bundleDestination @($completed.releasePath) | Out-Host
    if($LASTEXITCODE -ne 0){throw 'Delivery packaging failed. No completed delivery folder was published.'}
    Write-Host "`n打包完成。只需把下面这一个文件夹完整复制到电脑 B："
    Write-Host $bundleDestination
    Write-Host 'B 无需安装 Python、Node.js 或 Docker：按 README.md 准备数据后运行 preview.cmd。Docker 部署交给同事。'
    if($NonInteractive){return [pscustomobject]@{deliveryPath=$bundleDestination}}
    Open-PublishDeliveryFolder -Path $bundleDestination
    return
}
Assert-PublishId $AppId
if(-not @($apps | Where-Object {$_.id -ceq $AppId}).Count){throw 'Register the application before publishing it.'}
if(-not $Action) {
    $Action='Package'
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
if(Test-Path -LiteralPath $destination){throw 'Packaged version already exists. Choose a new version.'}
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
        & (Join-Path $PSScriptRoot 'New-AppRelease.ps1') -PayloadPath $prepared -Destination $destination -AppId $AppId -Version $Version -Type $type -EntryPoint $entry -SourceRevision $revision -DataMode $mode -HealthPath $health | Out-Null
        $final=Assert-AppRelease $destination
    }
}
Write-Host ("应用校验通过：{0} {1}" -f $AppId,$Version)
if($BuildOnly){return [pscustomobject]@{appId=$AppId;version=$Version;releasePath=$destination;action=$Action}}
$delivery=Join-Path $root ('release/'+$AppId+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
& node (Join-Path $root 'scripts/build-delivery.mjs') --python $runtimePython $delivery $destination | Out-Host
if($LASTEXITCODE -ne 0){throw 'Delivery packaging failed. No completed delivery folder was published.'}
Write-Host ('只复制此文件夹到 B：'+$delivery)
if($NonInteractive){return [pscustomobject]@{deliveryPath=$delivery}}
Open-PublishDeliveryFolder -Path $delivery
