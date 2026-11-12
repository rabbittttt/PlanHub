#requires -Version 5.1
# Keep this file in UTF-8 with BOM: Windows PowerShell 5.1 reads -File as ANSI otherwise.
[CmdletBinding()]
param([string]$ReleasePath='', [string]$ConfigPath='')
$ErrorActionPreference='Stop'
if(-not $ConfigPath){$ConfigPath=Join-Path $PSScriptRoot '..\config.local\deployment.json'}
if(-not(Test-Path -LiteralPath $ConfigPath)){
    $directory=Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deployment.example.json') -Destination $ConfigPath
    Write-Host ('已生成部署电脑配置：'+$ConfigPath)
    Write-Host '首次请按本机目录、域名和运行账号填写。IIS/ARR、运行环境、业务数据和 SOP 身份接入需要先完成初始化。'
    return
}
if(-not $ReleasePath){$ReleasePath=Read-Host '请粘贴收到的版本文件夹路径（包含 app-release.json）'}
$ReleasePath=$ReleasePath.Trim('"')
& (Join-Path $PSScriptRoot 'Install-AppVersion.ps1') -ReleasePath $ReleasePath -ConfigPath $ConfigPath -PlanOnly
Write-Host '请确认上方是部署电脑，当前应用的保存、导入和后台写入已结束。'
$answer=Read-Host '现在发布此版本？输入 Y 继续'
if($answer -ine 'Y'){Write-Host '未执行发布。';return}
& (Join-Path $PSScriptRoot 'Install-AppVersion.ps1') -ReleasePath $ReleasePath -ConfigPath $ConfigPath -Apply
