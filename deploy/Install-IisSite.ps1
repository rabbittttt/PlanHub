#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = '',
    [switch]$PlanOnly,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'config.example.json' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
if ($PlanOnly -and $Apply) { throw 'PlanOnly and Apply cannot be combined.' }
$config = Read-DeploymentConfig -Path $ConfigPath
$portal = Join-Path $config.DeploymentRoot 'portal'
$binding = '*:' + $config.Port + ':' + $config.HostName
$activeApps = @($config.StaticApplications | Where-Object { $_.Enabled })
Write-Output "NEW site: $($config.SiteName); HTTP binding: $binding"
Write-Output "NEW pool: $($config.ApplicationPool); no managed runtime"
Write-Output "Web root: $portal"
Write-Output 'Authentication: Windows enabled, Anonymous disabled; site is created STOPPED.'
foreach ($app in $activeApps) { Write-Output "Application: /$($app.Name)/ -> $($config.DeploymentRoot)\apps\$($app.Name)" }
Write-Output "ARR preflight required: $($config.RequireReverseProxy); global proxy settings will NOT be changed."
if ($PlanOnly) {
    Write-Output 'Offline configuration validation passed. IIS, filesystem deployment and authentication have not been tested.'
    return
}
if (-not [Environment]::Is64BitProcess) { throw 'Run in 64-bit Windows PowerShell to inspect or configure IIS.' }
$assembly = Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { throw 'IIS management API is not installed.' }
Add-Type -Path $assembly
$manager = New-Object Microsoft.Web.Administration.ServerManager
try {
    try {
        $siteCollection = $manager.Sites
        $poolCollection = $manager.ApplicationPools
        if ($null -eq $siteCollection -or $null -eq $poolCollection) {
            throw 'IIS returned no site or application pool collection; configuration access is unavailable.'
        }
        $existingSites = @($siteCollection)
        $existingPools = @($poolCollection)
    }
    catch { throw "Cannot inspect IIS configuration. Use an administrator PowerShell on the target server. Original error: $($_.Exception.Message)" }
    if ($existingSites | Where-Object { $_.Name -eq $config.SiteName }) { throw "Site already exists: $($config.SiteName). This script only creates new sites." }
    if ($existingPools | Where-Object { $_.Name -eq $config.ApplicationPool }) { throw "Application pool already exists: $($config.ApplicationPool). Use a new name." }
    foreach ($site in $existingSites) {
        foreach ($existingBinding in $site.Bindings) {
            # The new binding uses all IP addresses. Fail conservatively for HTTP
            # bindings on the same port with overlapping or wildcard hosts.
            if ($existingBinding.Protocol -eq 'http' -and $existingBinding.EndPoint.Port -eq $config.Port) {
                if (-not $existingBinding.Host -or -not $config.HostName -or $existingBinding.Host -eq $config.HostName -or $existingBinding.Host.Contains('*')) {
                    throw "Binding conflict with site '$($site.Name)': $($existingBinding.BindingInformation)"
                }
            }
        }
    }
    $appHost = $manager.GetApplicationHostConfiguration()
    $modules = @($appHost.GetSection('system.webServer/globalModules').GetCollection() | ForEach-Object { [string]$_.GetAttributeValue('name') })
    foreach ($moduleName in @('StaticFileModule', 'DefaultDocumentModule', 'WindowsAuthenticationModule')) {
        if ($moduleName -notin $modules) { throw "Required IIS module is missing: $moduleName" }
    }
    if ($config.RequireReverseProxy) {
        foreach ($moduleName in @('RewriteModule', 'ApplicationRequestRouting')) {
            if ($moduleName -notin $modules) { throw "Reverse proxy module is missing: $moduleName" }
        }
        if (-not [bool]$appHost.GetSection('system.webServer/proxy').GetAttributeValue('enabled')) {
            throw 'ARR proxy is disabled at server level. Review and enable it separately; this script will not change global settings.'
        }
    }
    foreach ($folder in @($portal) + @($activeApps | ForEach-Object { Join-Path $config.DeploymentRoot ('apps\' + $_.Name) })) {
        if (-not (Test-Path -LiteralPath (Join-Path $folder 'index.html') -PathType Leaf)) { throw "Deployment is missing index.html: $folder" }
        Assert-NoReparsePoint -Path $folder
    }
    if (-not (Test-Path -LiteralPath (Join-Path $portal 'web.config') -PathType Leaf)) { throw 'Portal web.config is missing. Build the deployment package first.' }
    [xml]$portalConfig = Get-Content -LiteralPath (Join-Path $portal 'web.config') -Raw -Encoding UTF8
    if (-not $portalConfig.SelectSingleNode('/configuration/location[@path="."][@inheritInChildApplications="false"]')) {
        throw 'Portal web.config must isolate its configuration with inheritInChildApplications=false.'
    }
    Write-Output 'IIS configuration, module, binding and deployment file preflight passed.'
    Write-Output 'Filesystem ACLs, domain login, app authorization and network reachability still require acceptance checks.'
    if (-not $Apply) { Write-Output 'Read-only preflight complete. Use -Apply to create this new stopped site.'; return }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply requires an elevated administrator PowerShell.' }
    if (-not $PSCmdlet.ShouldProcess($config.SiteName, 'Create new IIS pool and STOPPED Windows-authenticated site')) { return }
    $pool = $manager.ApplicationPools.Add($config.ApplicationPool)
    $pool.ManagedRuntimeVersion = ''
    $pool.ProcessModel.IdentityType = [Microsoft.Web.Administration.ProcessModelIdentityType]::ApplicationPoolIdentity
    $site = $manager.Sites.Add($config.SiteName, 'http', $binding, $portal)
    $site.ServerAutoStart = $false
    $site.Applications['/'].ApplicationPoolName = $config.ApplicationPool
    foreach ($app in $activeApps) {
        $application = $site.Applications.Add('/' + $app.Name, (Join-Path $config.DeploymentRoot ('apps\' + $app.Name)))
        $application.ApplicationPoolName = $config.ApplicationPool
    }
    # These location-specific settings are committed to applicationHost.config,
    # not web.config. No global unlocking or anonymous development mode is used.
    foreach ($location in @($config.SiteName) + @($activeApps | ForEach-Object { $config.SiteName + '/' + $_.Name })) {
        $appHost.GetSection('system.webServer/security/authentication/anonymousAuthentication', $location).SetAttributeValue('enabled', $false)
        $appHost.GetSection('system.webServer/security/authentication/windowsAuthentication', $location).SetAttributeValue('enabled', $true)
    }
    $manager.CommitChanges()
    Write-Output 'Created the new site and pool. The site remains stopped; no existing site, DNS, ACL or global ARR setting was changed.'
    Write-Output 'Review filesystem permissions and app authorization, then start the new site in IIS Manager for acceptance testing.'
}
finally { $manager.Dispose() }
