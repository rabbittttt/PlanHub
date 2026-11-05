#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$ConfigPath = '', [switch]$PlanOnly, [switch]$Apply)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Quicklook.Proxy.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'quicklook-iis.example.json' }
if ($PlanOnly -and $Apply) { throw 'PlanOnly and Apply cannot be combined.' }
$config = Read-QuicklookIisConfig -Path $ConfigPath
$requirements = Get-QuicklookProxyRequirements
$portalRoot = Join-Path $config.DeploymentRoot 'portal'
$webConfig = Join-Path $portalRoot 'web.config'
Write-Output "Quicklook proxy: $($config.SiteName)/quicklook/ -> http://127.0.0.1:$($config.BackendPort)/ (prefix stripped)."
Write-Output ('Exact root APIs: ' + ((Get-QuicklookRootApiPaths) -join ', '))
Write-Output "Public origin: $($config.PublicOrigin). HTTP only: the existing child service rejects HTTPS POST origins."
Write-Output 'Host, Origin, response bodies and security headers are preserved. No serverVariables, outbound rules, identity forgery or all-API wildcard.'
Write-Output "Prerequisites: Windows Authentication enabled, Anonymous disabled; ARR enabled, preserveHostHeader=true, timeout at least $($requirements.MinimumTimeoutSeconds) seconds."
Write-Output "Import request limit: $($requirements.MaxAllowedContentLength) bytes (256 MiB file plus 1 MiB headroom); backend file limit remains 256 MiB."
Write-Output 'ARR and authentication settings are inspected only. Review server-wide changes separately; no allowedServerVariables additions are required.'
if ($PlanOnly) { Write-Output 'Offline plan validated; IIS, deployed files, bindings and authentication were not inspected or changed.'; return }
if (-not [Environment]::Is64BitProcess) { throw 'Run 64-bit Windows PowerShell on the target server.' }
if (-not (Test-Path -LiteralPath $webConfig -PathType Leaf)) { throw 'Deployed portal/web.config is missing. Build and install the portal package first.' }
Assert-NoReparsePoint -Path $webConfig
$originalBytes = [IO.File]::ReadAllBytes($webConfig)
$sha = [Security.Cryptography.SHA256]::Create()
try { $originalHash = [Convert]::ToBase64String($sha.ComputeHash($originalBytes)) } finally { $sha.Dispose() }
$document = New-Object Xml.XmlDocument
$document.PreserveWhitespace = $true
$readerSettings = New-Object Xml.XmlReaderSettings
$readerSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
$readerSettings.XmlResolver = $null
$reader = [Xml.XmlReader]::Create($webConfig, $readerSettings)
try { $document.Load($reader) } finally { $reader.Dispose() }
$candidate = New-QuicklookProxyWebConfig -Document $document -Config $config
$assembly = Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { throw 'IIS management API is missing.' }
Add-Type -Path $assembly
$manager = New-Object Microsoft.Web.Administration.ServerManager
try {
    $site = $manager.Sites[$config.SiteName]
    if (-not $site) { throw 'Target portal site does not exist.' }
    $physical = [Environment]::ExpandEnvironmentVariables($site.Applications['/'].VirtualDirectories['/'].PhysicalPath)
    if ([IO.Path]::GetFullPath($physical).TrimEnd('\') -ine $portalRoot.TrimEnd('\')) { throw 'The target site root is not DeploymentRoot/portal.' }
    $origin = [Uri]$config.PublicOrigin
    $bindings = @($site.Bindings | Where-Object { $_.Protocol -eq 'http' -and $_.EndPoint.Port -eq $origin.Port -and (-not $_.Host -or $_.Host -ieq $origin.Host) })
    if ($bindings.Count -eq 0) { throw 'The target site has no HTTP binding matching PublicOrigin.' }
    foreach ($app in $site.Applications) {
        if ($app.Path -match '^/(quicklook|api)(/|$)') { throw "An unrelated IIS application occupies a required route: $($app.Path)" }
        foreach ($directory in $app.VirtualDirectories) {
            $fullPath = if ($app.Path -eq '/') { $directory.Path } else { $app.Path.TrimEnd('/') + $directory.Path }
            if ($fullPath -match '^/(quicklook|api)(/|$)') { throw "An unrelated IIS virtual directory occupies a required route: $fullPath" }
        }
    }
    foreach ($folder in @('quicklook', 'api')) {
        if (Test-Path -LiteralPath (Join-Path $portalRoot $folder)) { throw "A physical portal/$folder path already exists; review ownership separately." }
    }
    $appHost = $manager.GetApplicationHostConfiguration()
    $modules = @($appHost.GetSection('system.webServer/globalModules').GetCollection() | ForEach-Object { [string]$_.GetAttributeValue('name') })
    foreach ($name in @('RewriteModule', 'ApplicationRequestRouting', 'WindowsAuthenticationModule')) {
        if ($name -notin $modules) { throw "Required IIS module is missing: $name" }
    }
    $globalRules = @($appHost.GetSection('system.webServer/rewrite/globalRules').GetCollection())
    if ($globalRules.Count -gt 0) { throw 'Server-wide rewrite rules exist. Review their interaction separately; this tool does not override global rules.' }
    $effective = $manager.GetWebConfiguration($config.SiteName, '/')
    $ruleNames = @($effective.GetSection('system.webServer/rewrite/rules').GetCollection() | ForEach-Object { [string]$_.GetAttributeValue('name') })
    foreach ($name in $ruleNames) {
        if ($name -cnotin @("$($requirements.Owner) trailing slash", "$($requirements.Owner) assets", "$($requirements.Owner) exact root APIs")) { throw "Unowned effective rewrite rule exists: $name. Review it separately." }
    }
    $proxy = $effective.GetSection('system.webServer/proxy')
    if (-not [bool]$proxy.GetAttributeValue('enabled')) { throw 'ARR proxy is disabled. An administrator must review and enable it separately; no global setting was changed.' }
    if (-not [bool]$proxy.GetAttributeValue('preserveHostHeader')) { throw 'ARR preserveHostHeader must be true for Quicklook Origin validation. Review the effective site/server setting separately; this script will not change global ARR.' }
    $timeout = [TimeSpan]$proxy.GetAttributeValue('timeout')
    if ($timeout.TotalSeconds -lt $requirements.MinimumTimeoutSeconds) { throw 'ARR timeout must be at least 300 seconds for large imports. Review site/server impact and configure it separately; no global timeout was changed.' }
    foreach ($path in @('/') + @('/quicklook/') + @(Get-QuicklookRootApiPaths)) {
        $scoped = $manager.GetWebConfiguration($config.SiteName, $path)
        if (-not [bool]$scoped.GetSection('system.webServer/security/authentication/windowsAuthentication').GetAttributeValue('enabled') -or
            [bool]$scoped.GetSection('system.webServer/security/authentication/anonymousAuthentication').GetAttributeValue('enabled')) {
            throw "Windows Authentication must be enabled and Anonymous disabled at $path. Authentication is not changed by this script."
        }
    }
    Write-Output 'Read-only IIS route, ownership, binding, authentication and ARR preflight passed. Backend health and department access still require acceptance testing.'
    if (-not $Apply) { Write-Output 'Use -Apply to write only the owned Quicklook sections in portal/web.config.'; return }
    if ($origin.Host -like '*.example.internal') { throw 'Replace the example PublicOrigin with the real intranet HTTP origin.' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply requires administrator rights.' }
    if (-not $PSCmdlet.ShouldProcess($webConfig, 'Back up portal web.config and add or update only owned Quicklook proxy rules and route limits')) { return }
    $backupDirectory = Join-Path $config.DeploymentRoot 'config\quicklook-proxy-backups'
    $ancestor = $backupDirectory
    while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
    Assert-NoReparsePoint -Path $ancestor
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Assert-NoReparsePoint -Path $backupDirectory
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
    $backupPath = Join-Path $backupDirectory ($suffix + '.web.config')
    $pendingPath = Join-Path $portalRoot ('.quicklook-' + $suffix + '.tmp')
    try {
        $settings = New-Object Xml.XmlWriterSettings
        $settings.Encoding = New-Object Text.UTF8Encoding($false)
        $settings.Indent = $true
        $writer = [Xml.XmlWriter]::Create($pendingPath, $settings)
        try { $candidate.Save($writer) } finally { $writer.Dispose() }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $currentHash = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($webConfig))) } finally { $sha.Dispose() }
        if ($currentHash -cne $originalHash) { throw 'portal/web.config changed during preflight. Nothing was replaced; rerun to review the current configuration.' }
        [IO.File]::Replace($pendingPath, $webConfig, $backupPath)
    }
    finally { if (Test-Path -LiteralPath $pendingPath -PathType Leaf) { Remove-Item -LiteralPath $pendingPath } }
    Write-Output "Owned Quicklook proxy configuration written. Original portal configuration retained at $backupPath"
    Write-Output 'No IIS application, authentication, global ARR, allowedServerVariables, service, ACL or firewall setting was changed. Verify authenticated routes, uploads and preserved Host/Origin on the target server.'
}
finally { $manager.Dispose() }
