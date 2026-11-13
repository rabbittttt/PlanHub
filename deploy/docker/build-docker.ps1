#requires -Version 5.1
[CmdletBinding()]
param([string]$RuntimeDirectory='')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'delivery-common.ps1')
$package=(Get-Item -LiteralPath $PSScriptRoot).FullName
$manifest=Read-Delivery $package
$runtime=Get-DeliveryRuntime $package $RuntimeDirectory
Assert-DeliveryDocker
if(-not(Test-Path -LiteralPath (Join-Path $runtime 'config.json') -PathType Leaf)){throw 'Run prepare.cmd before building Docker images.'}
$lock=$null
try{
    $lock=[IO.File]::Open((Join-Path $runtime 'deployment.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $images=[ordered]@{}
    foreach($entry in $manifest.images.PSObject.Properties){
        $image=$entry.Value
        $hasImage=$false;$existing=$null
        try{$existing=& docker image inspect $image.tag 2>$null;$hasImage=$LASTEXITCODE -eq 0}catch{$hasImage=$false}
        if($hasImage){
            $actual=@(($existing -join "`n")|ConvertFrom-Json)[0]
            if($actual.Config.Labels.'planhub.fingerprint' -cne $image.fingerprint){throw ('Immutable image tag already contains different content: '+$image.tag)}
        }else{
            Invoke-DeliveryDocker -Arguments @('build','--platform','linux/amd64','--label',('planhub.fingerprint='+$image.fingerprint),'--tag',$image.tag,'--file',(Join-Path $package $image.dockerfile),$package)
            $actual=@((Invoke-DeliveryDocker -Arguments @('image','inspect',$image.tag) -Capture)|ConvertFrom-Json)[0]
        }
        if($actual.Os -cne 'linux' -or $actual.Architecture -cne 'amd64' -or $actual.Id -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'Unexpected Docker image platform or ID.'}
        $images[$entry.Name]=[ordered]@{tag=$image.tag;id=$actual.Id;fingerprint=$image.fingerprint}
    }
    $recordRoot=Join-Path $runtime 'docker-images';Assert-DeliveryNoLink $recordRoot
    [void][IO.Directory]::CreateDirectory($recordRoot)
    $deliveryHash=(Get-FileHash -LiteralPath (Join-Path $package 'delivery.json')).Hash.ToLowerInvariant()
    $record=Join-Path $recordRoot ($deliveryHash+'.json');Assert-DeliveryNoLink $record
    Write-DeliveryJson $record ([ordered]@{schemaVersion=1;deliveryHash=$deliveryHash;images=$images;createdAt=[DateTime]::UtcNow.ToString('o')})
    Write-Host 'Docker images are ready. Configure the company address, then run start.cmd. No services were started.'
}finally{if($null -ne $lock){$lock.Dispose()}}
