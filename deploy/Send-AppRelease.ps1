#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ReleasePath,
    [string]$ConfigPath='',
    [string]$Inbox='',
    [switch]$ApplyRemote
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Publish.Common.ps1')
$root=Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath=Join-Path $root 'config.local/publish.json' }
$config = if(Test-Path -LiteralPath $ConfigPath) { Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $Inbox) { $Inbox=[string](Get-PublishValue $config 'inbox' '') }
$inboxPath=Resolve-PublishPath $Inbox $root
if ($inboxPath -eq [IO.Path]::GetPathRoot($inboxPath).TrimEnd('\')) { throw 'Inbox must be a dedicated directory, not a drive/share root.' }
$release=Assert-AppRelease (Resolve-PublishPath $ReleasePath $root)
$id=$release.Manifest.appId
$version=$release.Manifest.version
$parent=Join-Path $inboxPath $id
$destination=Join-Path $parent $version
if ($destination -eq $release.Root -or $destination.StartsWith($release.Root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Inbox must be outside the source release.' }
# Validate remote configuration before copying. This never enables WinRM or changes credentials.
if ($ApplyRemote) {
    $remote=Get-PublishValue $config 'remote'
    foreach($field in @('computerName','toolsRoot','configPath','inboxLocalPath')) {
        if (-not (Get-PublishValue $remote $field '')) { throw "Remote publishing requires remote.$field in the private local config." }
    }
    if ($remote.computerName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$') { throw 'Invalid remote computer name.' }
}
New-Item -ItemType Directory -Path $parent -Force | Out-Null
Assert-NoReparsePoint $parent
if (Test-Path -LiteralPath $destination) {
    $received=Assert-AppRelease $destination
    $sourceHash=(Get-FileHash -LiteralPath (Join-Path $release.Root 'app-release.json') -Algorithm SHA256).Hash
    $receivedHash=(Get-FileHash -LiteralPath (Join-Path $destination 'app-release.json') -Algorithm SHA256).Hash
    if($sourceHash -cne $receivedHash){throw 'A different package already uses this version. Nothing was overwritten.'}
    Write-Host '收件目录已有完全一致的版本，沿用已校验的包。'
} else {
    $partial=Join-Path $parent ('.partial-'+$version+'-'+[Guid]::NewGuid().ToString('N'))
    $null=Copy-ValidatedRelease $release $partial
    # Directory.Move rejects a destination created concurrently; it never nests into another version.
    [IO.Directory]::Move($partial,$destination)
    $received=Assert-AppRelease $destination
}
Write-Host "已送达：$destination"
if ($ApplyRemote) {
    $expectedHash=(Get-FileHash -LiteralPath (Join-Path $destination 'app-release.json') -Algorithm SHA256).Hash
    $remoteRelease=Join-Path (Join-Path ([string]$remote.inboxLocalPath) $id) $version
    $result=Invoke-Command -ComputerName $remote.computerName -ErrorAction Stop -ArgumentList @($remote.toolsRoot,$remote.configPath,$remoteRelease,$expectedHash) -ScriptBlock {
        param($toolsRoot,$configPath,$releasePath,$expectedHash)
        $ErrorActionPreference='Stop'
        if(-not [IO.Path]::IsPathRooted($toolsRoot)){throw 'remote.toolsRoot must name the installed tools by absolute path on B.'}
        if(-not [IO.Path]::IsPathRooted($configPath)){$configPath=Join-Path $toolsRoot $configPath}
        if(-not [IO.Path]::IsPathRooted($releasePath)){$releasePath=Join-Path $toolsRoot $releasePath}
        $manifest=Join-Path $releasePath 'app-release.json'
        if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -cne $expectedHash) { throw 'Remote inbox mapping differs from the transmitted release.' }
        $installer=Join-Path $toolsRoot 'deploy/Install-AppVersion.ps1'
        if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'The remote deployment tool is not installed at toolsRoot.'}
        & $installer -ReleasePath $releasePath -ConfigPath $configPath -Apply
    }
    $result | Write-Output
    Write-Host "远程部署命令已成功完成，请按返回的健康检查结果核对入口。"
} else {
    Write-Host '仅完成传送，尚未上线。请在部署电脑 B 双击“部署新版本.bat”。'
}
[pscustomobject]@{appId=$id;version=$version;receivedPath=$destination;remoteApplied=[bool]$ApplyRemote}
