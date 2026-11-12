# Generic Windows-authenticated header proxy. Application code remains source-owned.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Environment.Config.ps1')

function Assert-IdentityHeaderName([string]$Name) {
    if ($Name -cnotmatch '^X-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$' -or $Name.Length -gt 80 -or $Name -match '^(?i:X-Forwarded-|X-Original-)') { throw 'Identity headers must be distinct X- prefixed application headers.' }
}
function Resolve-IdentityProxyBinding([string]$Root, [string]$Id, $Definition, [string]$SiteName, [string]$PublicOrigin) {
    if ($Id -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $Id -in @('sop','planhub','api','config','data','portal','assets','css','js','deploy','logs','services')) { throw 'Invalid application ID for a generic identity proxy.' }
    if ((Get-Setting $Definition 'kind') -cne 'service' -or (Get-Setting $Definition 'proxyMode') -cne 'existing') { throw 'A trusted identity proxy requires a service using proxyMode=existing.' }
    $identity = Get-Setting $Definition 'identityProxy'
    if ($identity -isnot [pscustomobject]) { throw 'identityProxy must declare userHeader, keyHeader and secretEnvironment.' }
    $userHeader = Get-Setting $identity 'userHeader' ''
    $keyHeader = Get-Setting $identity 'keyHeader' ''
    Assert-IdentityHeaderName $userHeader
    Assert-IdentityHeaderName $keyHeader
    if ($userHeader -ieq $keyHeader) { throw 'User and key headers must differ.' }
    $secretEnvironment = Get-Setting $identity 'secretEnvironment' ''
    if ($secretEnvironment -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'Invalid identity secret environment name.' }
    $secretValue = Get-Setting (Get-Setting $Definition 'secretEnvironmentFiles') $secretEnvironment ''
    if ($secretValue -isnot [string] -or -not $secretValue) { throw 'Identity secret must be supplied through secretEnvironmentFiles.' }
    $secret = Resolve-EnvironmentPath $secretValue $Root 'identity secret file'
    $privateRoot = Join-Path $Root 'config'
    if (-not $secret.StartsWith($privateRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Identity secret must be below the deployment config directory, outside web roots and versions.' }
    $port = Get-Setting $Definition 'port'
    if ($port -isnot [int] -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid identity backend port.' }
    $strip = Get-Setting $Definition 'stripPrefix' $true
    if ($strip -isnot [bool]) { throw 'stripPrefix must be boolean.' }
    $limit = Get-Setting $Definition 'maxRequestBytes' 269484032
    if ($limit -isnot [int] -or $limit -lt 1024 -or $limit -gt 2147483647) { throw 'Invalid maxRequestBytes.' }
    $account = Get-Setting $Definition 'serviceAccount' ''
    if ($account -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$' -or $account -match '(?i)(^|\\)(SYSTEM|LocalSystem|Administrators)$') { throw 'An explicit local/domain service account is required.' }
    if (-not $PublicOrigin) {
        $health = [uri]([string](Get-Setting $Definition 'healthUrl' ''))
        if (-not $health.IsAbsoluteUri -or $health.Scheme -notin @('http','https') -or $health.UserInfo) { throw 'A publicOrigin or absolute healthUrl is required.' }
        $PublicOrigin = $health.GetLeftPart([UriPartial]::Authority)
    }
    $origin = $null
    if (-not [uri]::TryCreate($PublicOrigin,[UriKind]::Absolute,[ref]$origin) -or $origin.Scheme -notin @('http','https') -or $origin.UserInfo -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $PublicOrigin -cne $origin.GetLeftPart([UriPartial]::Authority)) { throw 'Invalid identity public origin.' }
    $pool = Get-Setting $identity 'applicationPool' ($SiteName+'-'+$Id+'Proxy')
    if ($pool -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid identity application pool; set identityProxy.applicationPool if the generated name is too long.' }
    $proxyRoot = Join-Path $Root ('proxy\'+$Id)
    $configPath = Join-Path $privateRoot ($Id+'-identity.json')
    if ($secret -ieq $configPath) { throw 'Secret file and identity configuration must be different files.' }
    $config = [pscustomobject][ordered]@{SchemaVersion=1;AppId=$Id;UserHeader=$userHeader;KeyHeader=$keyHeader;ProxySecretPath=$secret;SecretEnvironment=$secretEnvironment;PublicOrigin=$PublicOrigin;BackendPort=$port;StripPrefix=$strip;ServiceAccount=$account}
    return [pscustomobject]@{Root=$Root;Id=$Id;Definition=$Definition;SiteName=$SiteName;ApplicationPool=$pool;ServiceAccount=$account;ProxyRoot=$proxyRoot;ConfigPath=$configPath;SecretPath=$secret;Config=$config;MaxRequestBytes=$limit}
}
function Read-IdentityProxyBinding([string]$AppId, [string]$DeploymentConfigPath) {
    $settings = Read-RuntimeSettings $DeploymentConfigPath
    $definition = Get-Setting $settings.Config.applications $AppId
    if ($null -eq $definition) { throw 'The application is not registered in the deployment configuration.' }
    $binding = Resolve-IdentityProxyBinding $settings.Root $AppId $definition $settings.Config.siteName $settings.PublicOrigin
    Assert-IdentityProxyConsistency -Root $binding.Root -Id $binding.Id -Definition $definition -AllowDerivedUpdate
    return $binding
}
function Get-IdentityProxyXml($Binding) {
    $id = $Binding.Id
    $config = [Security.SecurityElement]::Escape($Binding.ConfigPath)
    $target = 'http://127.0.0.1:'+$Binding.Config.BackendPort+'/'
    if (-not $Binding.Config.StripPrefix) { $target += $id+'/' }
    $target += '{R:1}'
    return @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="PlanHubIdentityOwner" value="PlanHub-Identity-v1" />
    <add key="PlanHubIdentityAppId" value="$id" />
    <add key="PlanHubIdentityConfigPath" value="$config" />
  </appSettings>
  <system.web><authentication mode="Windows" /><httpRuntime targetFramework="4.0" /></system.web>
  <system.webServer>
    <modules runAllManagedModulesForAllRequests="true"><add name="PlanHubTrustedIdentity" type="PlanHub.TrustedIdentityBridge" /></modules>
    <directoryBrowse enabled="false" />
    <security><requestFiltering><requestLimits maxAllowedContentLength="$($Binding.MaxRequestBytes)" /></requestFiltering></security>
    <rewrite><rules><clear />
      <rule name="PlanHub identity trailing slash" stopProcessing="true"><match url="^`$" /><conditions><add input="{URL}" pattern="^/$id`$" /></conditions><action type="Redirect" url="/$id/" redirectType="Temporary" appendQueryString="true" /></rule>
      <rule name="PlanHub identity loopback" stopProcessing="true"><match url="^(.*)$" /><action type="Rewrite" url="$target" appendQueryString="true" /></rule>
    </rules></rewrite>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
"@
}
function Assert-IdentityProxyConsistency {
    param([string]$Root,[string]$Id,$Definition,[switch]$RequireInitialized,[switch]$AllowDerivedUpdate)
    # Site/pool names are irrelevant to file consistency; the actual installer validates them separately.
    $binding = Resolve-IdentityProxyBinding $Root $Id $Definition 'PlanHub' ''
    $proxyFile = Join-Path $binding.ProxyRoot 'web.config'
    $dll = Join-Path $binding.ProxyRoot 'bin\PlanHub.TrustedIdentityBridge.dll'
    if ($RequireInitialized) {
        foreach ($path in @($binding.ConfigPath,$binding.SecretPath,$proxyFile,$dll)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Trusted identity proxy is not initialized. Run Configure-IdentityProxy with the same deployment configuration before publishing.' }
        }
    }
    foreach ($path in @($binding.ConfigPath,$binding.SecretPath,$proxyFile,$dll)) {
        if (Test-Path -LiteralPath $path) { Assert-NoReparsePoint -Path $path }
    }
    if (Test-Path -LiteralPath $binding.ConfigPath) {
        $prior = Get-Content -LiteralPath $binding.ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Get-Setting $prior 'SchemaVersion') -ne 1 -or (Get-Setting $prior 'AppId') -cne $Id) { throw 'Existing identity configuration has a different owner or schema.' }
        if ((Get-Setting $prior 'ProxySecretPath' '') -ine $binding.SecretPath) { throw 'Identity secret path differs. Review key migration separately; no secret was rotated.' }
        if (-not $AllowDerivedUpdate) {
            foreach ($name in @('UserHeader','KeyHeader','SecretEnvironment','PublicOrigin','BackendPort','StripPrefix','ServiceAccount')) {
                if ((Get-Setting $prior $name) -cne $binding.Config.$name) { throw "Identity configuration $name differs from the runtime binding. Reconfigure the owned proxy before publishing." }
            }
        }
    }
    if (Test-Path -LiteralPath $binding.SecretPath) {
        $secret = [IO.File]::ReadAllText($binding.SecretPath).Trim()
        if ($secret -cnotmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'The existing identity secret has an invalid format. It was not changed.' }
        $secret = $null
    }
    if (Test-Path -LiteralPath $proxyFile) {
        [xml]$proxy = Get-Content -LiteralPath $proxyFile -Raw -Encoding UTF8
        $owner = $proxy.SelectSingleNode('/configuration/appSettings/add[@key="PlanHubIdentityOwner"]')
        $app = $proxy.SelectSingleNode('/configuration/appSettings/add[@key="PlanHubIdentityAppId"]')
        $config = $proxy.SelectSingleNode('/configuration/appSettings/add[@key="PlanHubIdentityConfigPath"]')
        if ($null -eq $owner -or $owner.GetAttribute('value') -cne 'PlanHub-Identity-v1' -or $null -eq $app -or $app.GetAttribute('value') -cne $Id -or $null -eq $config -or $config.GetAttribute('value') -ine $binding.ConfigPath) { throw 'Existing application is not this tool-owned identity proxy or reads another identity configuration.' }
        if (-not $AllowDerivedUpdate) {
            $actions = @($proxy.SelectNodes('/configuration/system.webServer/rewrite/rules/rule/action[@type="Rewrite"]'))
            $expected = 'http://127.0.0.1:'+$binding.Config.BackendPort+'/'
            if (-not $binding.Config.StripPrefix) { $expected += $Id+'/' }
            if ($actions.Count -ne 1 -or $actions[0].GetAttribute('url') -cne ($expected+'{R:1}')) { throw 'Trusted proxy backend target differs from its runtime binding.' }
            $module = $proxy.SelectSingleNode('/configuration/system.webServer/modules/add[@name="PlanHubTrustedIdentity"]')
            if ($null -eq $module -or $module.GetAttribute('type') -cne 'PlanHub.TrustedIdentityBridge') { throw 'The trusted identity module is not configured.' }
        }
    }
}
