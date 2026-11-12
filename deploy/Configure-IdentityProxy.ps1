#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$AppId,
    [string]$DeploymentConfigPath='',
    [switch]$PlanOnly,
    [switch]$Apply
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Identity.Proxy.ps1')
. (Join-Path $PSScriptRoot 'Sop.Common.ps1')
if($PlanOnly -and $Apply){throw 'PlanOnly and Apply cannot be combined.'}
if(-not $DeploymentConfigPath){$DeploymentConfigPath=Join-Path $PSScriptRoot '..\config.local\deployment.json'}
$binding=Read-IdentityProxyBinding -AppId $AppId -DeploymentConfigPath $DeploymentConfigPath
$source=Join-Path $PSScriptRoot 'TrustedIdentityBridge.cs'
if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw 'The generic identity module source is missing from the deployment tools.'}
Write-Output ('Identity proxy: '+$binding.SiteName+'/'+$AppId+'; backend port: '+$binding.Config.BackendPort+'; strip prefix: '+$binding.Config.StripPrefix)
Write-Output ('Service account: '+$binding.ServiceAccount+'; IIS pool: '+$binding.ApplicationPool)
Write-Output ('Public origin: '+$binding.Config.PublicOrigin)
Write-Output ('Protected identity configuration: '+$binding.ConfigPath)
Write-Output ('Secret file: '+$binding.SecretPath+' (values are never printed)')
Write-Output ('Trusted headers: '+$binding.Config.UserHeader+', '+$binding.Config.KeyHeader+'; stamped after Windows authentication.')
if($PlanOnly){Write-Output 'Offline identity plan validated. No IIS, accounts, files, secrets or services were changed.';return}
if(-not [Environment]::Is64BitProcess){throw 'Use 64-bit Windows PowerShell.'}
$assembly=Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
if(-not(Test-Path -LiteralPath $assembly -PathType Leaf)){throw 'IIS management API is missing.'}
Add-Type -Path $assembly
$manager=New-Object Microsoft.Web.Administration.ServerManager
try {
    $site=$manager.Sites[$binding.SiteName]
    if($null -eq $site){throw 'The target IIS site does not exist. Complete initial site setup first.'}
    $appHost=$manager.GetApplicationHostConfiguration()
    $modules=@($appHost.GetSection('system.webServer/globalModules').GetCollection()|ForEach-Object{[string]$_.GetAttributeValue('name')})
    foreach($name in @('RewriteModule','ApplicationRequestRouting','WindowsAuthenticationModule','ManagedEngineV4.0_64bit')){
        if($name -notin $modules){throw "Required IIS module is missing: $name"}
    }
    $arr=$appHost.GetSection('system.webServer/proxy')
    if(-not [bool]$arr.GetAttributeValue('enabled') -or -not [bool]$arr.GetAttributeValue('preserveHostHeader')){throw 'ARR must already be enabled with preserveHostHeader. This tool does not change global settings.'}
    $app=$site.Applications['/'+$AppId]
    $pool=$manager.ApplicationPools[$binding.ApplicationPool]
    if($app -or $pool){
        if(-not $app -or -not $pool -or $app.ApplicationPoolName -cne $binding.ApplicationPool -or $app.VirtualDirectories['/'].PhysicalPath -ine $binding.ProxyRoot){throw 'An unrelated application or pool exists. No settings will be replaced.'}
        Assert-IdentityProxyConsistency -Root $binding.Root -Id $AppId -Definition $binding.Definition -AllowDerivedUpdate
        if(-not(Test-Path -LiteralPath (Join-Path $binding.ProxyRoot 'web.config') -PathType Leaf)){throw 'Existing proxy ownership could not be verified.'}
        if($pool.ManagedRuntimeVersion -ne 'v4.0' -or $pool.ManagedPipelineMode.ToString() -ne 'Integrated'){throw 'Existing identity application pool is not .NET v4 Integrated.'}
    }
    foreach($path in @($binding.Root,$binding.ProxyRoot,(Join-Path $binding.Root 'proxy'),(Join-Path $binding.Root 'config'))){
        if(Test-Path -LiteralPath $path){Assert-NoReparsePoint -Path $path}
    }
    Write-Output 'IIS module, application ownership and existing key preflight passed.'
    if(-not $Apply){Write-Output 'Read-only preflight complete. Apply is required to configure the owned application.';return}
    $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Apply requires administrator rights.'}
    if(-not $PSCmdlet.ShouldProcess($binding.SiteName+'/'+$AppId,'Configure the owned Windows-authenticated identity proxy and restricted external key')){return}
    if(-not $pool){
        $pool=$manager.ApplicationPools.Add($binding.ApplicationPool)
        $pool.ManagedRuntimeVersion='v4.0'
        $pool.ManagedPipelineMode=[Microsoft.Web.Administration.ManagedPipelineMode]::Integrated
        $pool.ProcessModel.IdentityType=[Microsoft.Web.Administration.ProcessModelIdentityType]::ApplicationPoolIdentity
    }
    New-Item -ItemType Directory -Path $binding.ProxyRoot,(Split-Path -Parent $binding.ConfigPath),(Split-Path -Parent $binding.SecretPath) -Force|Out-Null
    foreach($item in @(Get-ChildItem -LiteralPath $binding.ProxyRoot -Recurse -Force)){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The proxy contains a directory link or reparse point.'}
    }
    & (Join-Path $PSScriptRoot 'Build-IdentityBridge.ps1') -OutputDirectory (Join-Path $binding.ProxyRoot 'bin')|Out-Host
    if(-not $app){$app=$site.Applications.Add('/'+$AppId,$binding.ProxyRoot);$app.ApplicationPoolName=$binding.ApplicationPool}
    $location=$binding.SiteName+'/'+$AppId
    $appHost.GetSection('system.webServer/security/authentication/anonymousAuthentication',$location).SetAttributeValue('enabled',$false)
    $appHost.GetSection('system.webServer/security/authentication/windowsAuthentication',$location).SetAttributeValue('enabled',$true)
    # The pool virtual account must exist before its restricted file ACL can be applied.
    $manager.CommitChanges()
    if(-not(Test-Path -LiteralPath $binding.SecretPath)){
        $secret=New-SopProxySecret
        [IO.File]::WriteAllText($binding.SecretPath,$secret,(New-Object Text.UTF8Encoding($false)))
        $secret=$null
    }
    $poolIdentity='IIS AppPool\'+$binding.ApplicationPool
    Set-SopRestrictedAcl -Path $binding.SecretPath -ReadAccounts @($poolIdentity,$binding.ServiceAccount)
    Write-SopJson -Path $binding.ConfigPath -Value $binding.Config
    Set-SopRestrictedAcl -Path $binding.ConfigPath -ReadAccounts @($poolIdentity,$binding.ServiceAccount)
    [IO.File]::WriteAllText((Join-Path $binding.ProxyRoot 'web.config'),(Get-IdentityProxyXml $binding),(New-Object Text.UTF8Encoding($false)))
    Assert-IdentityProxyConsistency -Root $binding.Root -Id $AppId -Definition $binding.Definition -RequireInitialized
    Write-Output 'Owned identity proxy configured. No business data was read or changed. Publish/restart the application separately and verify real Windows identity on the target machine.'
}
finally{$manager.Dispose()}
