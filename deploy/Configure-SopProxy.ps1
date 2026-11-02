#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = '',
    [string]$ServiceAccount = '',
    [switch]$PlanOnly,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'sop-iis.example.json' }
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Common.ps1')
. (Join-Path $PSScriptRoot 'Sop.Release.ps1')
if ($PlanOnly -and $Apply) { throw 'PlanOnly and Apply cannot be combined.' }
$config = Read-SopIisConfig -Path $ConfigPath
$proxyRoot = Join-Path $config.DeploymentRoot 'proxy\sop'
$configRoot = Join-Path $config.DeploymentRoot 'config'
$gatewayPath = Join-Path $configRoot 'sop.json'
$authPath = Join-Path $configRoot 'sop-auth.json'
$allowWrites = $config.WriteGroups.Count -gt 0
Write-Output "SOP proxy: $($config.SiteName)/sop -> http://127.0.0.1:$($config.BackendPort)/sop/ (prefix preserved)"
Write-Output "Dedicated .NET v4 Integrated pool: $($config.ApplicationPool)"
Write-Output "Public origin: $($config.PublicOrigin); write group count: $($config.WriteGroups.Count); writes enabled: $allowWrites"
Write-Output 'Identity is stamped after Windows Authentication. No LOGON_USER rewrite variable is used.'
Write-Output 'Secrets are generated only by Apply, never printed, and shared via an ACL-protected file outside web roots.'
if ($PlanOnly) { Write-Output 'Offline plan validated; IIS and domain accounts were not contacted.'; return }
if (-not [Environment]::Is64BitProcess) { throw 'Run 64-bit Windows PowerShell.' }
$mwa = Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
if (-not (Test-Path -LiteralPath $mwa)) { throw 'IIS management API is missing.' }
Add-Type -Path $mwa
$manager = New-Object Microsoft.Web.Administration.ServerManager
try {
    $sites = $manager.Sites
    if ($null -eq $sites) { throw 'Cannot read IIS configuration. Run on the target server as administrator.' }
    $site = $sites[$config.SiteName]
    if ($null -eq $site) { throw 'The target site does not exist. Install the new portal site first.' }
    $appHost = $manager.GetApplicationHostConfiguration()
    $modules = @($appHost.GetSection('system.webServer/globalModules').GetCollection() | ForEach-Object { [string]$_.GetAttributeValue('name') })
    foreach ($name in @('RewriteModule', 'ApplicationRequestRouting', 'WindowsAuthenticationModule', 'ManagedEngineV4.0_64bit')) {
        if ($name -notin $modules) { throw "Required IIS module missing: $name. Install IIS ASP.NET 4.x, Windows Authentication, Rewrite and ARR first." }
    }
    if (-not [bool]$appHost.GetSection('system.webServer/proxy').GetAttributeValue('enabled')) { throw 'Server ARR proxy is disabled. Review and enable it separately; this script does not change global ARR settings.' }
    $release = Assert-SopRelease -Path (Join-Path $config.DeploymentRoot 'services\sop')
    if (Test-Path -LiteralPath $config.ProxySecretPath) {
        $existingSecret = [IO.File]::ReadAllText($config.ProxySecretPath).Trim()
        if ($existingSecret -cnotmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'The existing proxy secret has an invalid format. Do not silently rotate a live key.' }
        $existingSecret = $null
    }
    Assert-NoReparsePoint -Path $config.DeploymentRoot
    foreach ($path in @($configRoot, (Join-Path $config.DeploymentRoot 'proxy'), $proxyRoot, $config.ProxySecretPath, $gatewayPath, $authPath)) {
        if (Test-Path -LiteralPath $path) { Assert-NoReparsePoint -Path $path }
    }
    $existingApp = $site.Applications['/sop']
    $existingPool = $manager.ApplicationPools[$config.ApplicationPool]
    if ($existingApp -or $existingPool) {
        if (-not $existingApp -or -not $existingPool -or $existingApp.ApplicationPoolName -ne $config.ApplicationPool -or
            $existingApp.VirtualDirectories['/'].PhysicalPath -ne $proxyRoot -or -not (Test-Path -LiteralPath (Join-Path $proxyRoot 'web.config'))) {
            throw 'An unrelated /sop application or pool exists. No settings will be replaced.'
        }
        [xml]$prior = Get-Content -LiteralPath (Join-Path $proxyRoot 'web.config') -Raw -Encoding UTF8
        if (-not $prior.SelectSingleNode('/configuration/appSettings/add[@key="SopIdentityBridgeOwner"][@value="DataPlatform-SOP-v1"]')) { throw 'Existing /sop application is not owned by this deployment script.' }
        if ($existingPool.ManagedRuntimeVersion -ne 'v4.0' -or $existingPool.ManagedPipelineMode.ToString() -ne 'Integrated') { throw 'The existing SOP pool runtime differs from the required .NET v4 Integrated configuration.' }
    }
    Write-Output 'Target site, proxy modules and application ownership preflight passed.'
    if (-not $Apply) { Write-Output 'Read-only preflight complete. Apply is required to change the owned SOP application.'; return }
    if (-not $ServiceAccount -or $ServiceAccount -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$') { throw 'Apply requires the explicit DOMAIN\ServiceAccount used to run Python; it receives read access to the secret.' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply requires administrator rights.' }
    if ($config.PublicOrigin -like '*example.internal*') { throw 'Replace the example public origin with the real intranet origin first.' }
    if (-not $PSCmdlet.ShouldProcess($config.SiteName + '/sop', 'Install or update owned post-authentication proxy application and protected SOP configuration')) { return }
    New-Item -ItemType Directory -Force -Path $configRoot, $proxyRoot | Out-Null
    foreach ($entry in @(Get-ChildItem -LiteralPath $proxyRoot -Recurse -Force)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SOP proxy directory contains a reparse point.' }
    }
    $poolIdentity = 'IIS AppPool\' + $config.ApplicationPool
    if (-not $existingPool) {
        $existingPool = $manager.ApplicationPools.Add($config.ApplicationPool)
        $existingPool.ManagedRuntimeVersion = 'v4.0'
        $existingPool.ManagedPipelineMode = [Microsoft.Web.Administration.ManagedPipelineMode]::Integrated
    }
    if (-not $existingApp) {
        $existingApp = $site.Applications.Add('/sop', $proxyRoot)
        $existingApp.ApplicationPoolName = $config.ApplicationPool
    }
    # Pool identity must exist before adding its virtual account to file ACLs.
    # Keep the parent site stopped during initial installation.
    $location = $config.SiteName + '/sop'
    $appHost.GetSection('system.webServer/security/authentication/anonymousAuthentication', $location).SetAttributeValue('enabled', $false)
    $appHost.GetSection('system.webServer/security/authentication/windowsAuthentication', $location).SetAttributeValue('enabled', $true)
    $manager.CommitChanges()
    $gateway = if (Test-Path -LiteralPath $gatewayPath) { Get-Content -LiteralPath $gatewayPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sop.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
    # Disable writes while applying the pair of authorization configurations.
    $gateway.allow_writes = $false
    $gateway.public_origin = $config.PublicOrigin
    $gateway.base_path = '/sop'
    $gateway.proxy_secret_env = 'SOP_PROXY_SECRET'
    if (-not (Test-Path -LiteralPath $gatewayPath)) {
        $gateway.data_dir = Join-Path $config.DeploymentRoot 'data\sop'
        $gateway.source_dir = Join-Path $config.DeploymentRoot 'data\sop\input_file'
        $gateway.shared_config = Join-Path $config.DeploymentRoot 'config\shared_config.py'
        $gateway.plan_file = Join-Path $config.DeploymentRoot 'data\sop\SOP计划维护.xlsx'
    }
    Write-SopJson -Path $gatewayPath -Value $gateway
    if (-not (Test-Path -LiteralPath $config.ProxySecretPath)) {
        $newSecret = New-SopProxySecret
        [IO.File]::WriteAllText($config.ProxySecretPath, $newSecret, (New-Object Text.UTF8Encoding($false)))
        $newSecret = $null
    }
    Set-SopRestrictedAcl -Path $config.ProxySecretPath -ReadAccounts @($poolIdentity, $ServiceAccount)
    $auth = [ordered]@{ WriteGroups = @($config.WriteGroups); ProxySecretPath = $config.ProxySecretPath; PublicOrigin = $config.PublicOrigin; BackendPort = $config.BackendPort }
    Write-SopJson -Path $authPath -Value $auth
    Set-SopRestrictedAcl -Path $authPath -ReadAccounts @($poolIdentity, $ServiceAccount)
    Set-SopRestrictedAcl -Path $gatewayPath -ReadAccounts @($ServiceAccount)
    & (Join-Path $PSScriptRoot 'Build-SopIdentityBridge.ps1') -OutputDirectory (Join-Path $proxyRoot 'bin') -SourcePath (Join-Path $release.Root 'integration\iis\SopIdentityBridge.cs')
    $escapedAuth = [Security.SecurityElement]::Escape($authPath)
    $backend = 'http://127.0.0.1:' + $config.BackendPort + '/sop/{R:1}'
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="SopIdentityBridgeOwner" value="DataPlatform-SOP-v1" />
    <add key="SopProxyConfigPath" value="$escapedAuth" />
  </appSettings>
  <system.web><authentication mode="Windows" /><httpRuntime targetFramework="4.0" /></system.web>
  <system.webServer>
    <modules runAllManagedModulesForAllRequests="true">
      <add name="SopIdentityBridge" type="DataPlatform.SopIdentityBridge, SopIdentityBridge" />
    </modules>
    <directoryBrowse enabled="false" />
    <rewrite><rules><clear />
      <rule name="SOP trailing slash" stopProcessing="true">
        <match url="^`$" />
        <conditions><add input="{URL}" pattern="^/sop`$" /></conditions>
        <action type="Redirect" url="/sop/" redirectType="Temporary" appendQueryString="true" />
      </rule>
      <rule name="SOP loopback service" stopProcessing="true">
        <match url="^(.*)$" />
        <action type="Rewrite" url="$backend" appendQueryString="true" />
      </rule>
    </rules></rewrite>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
"@
    [IO.File]::WriteAllText((Join-Path $proxyRoot 'web.config'), $xml, (New-Object Text.UTF8Encoding($false)))
    $gateway.allow_writes = $allowWrites
    Write-SopJson -Path $gatewayPath -Value $gateway
    Set-SopRestrictedAcl -Path $gatewayPath -ReadAccounts @($ServiceAccount)
    Write-Output 'Owned SOP proxy configured. Secret values were not printed or placed in command arguments.'
    Write-Output 'Restart the Python task after configuration changes. Keep writes closed until domain group acceptance succeeds.'
}
finally { $manager.Dispose() }
