Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Read-SopIisConfig {
    param([string]$Path)
    $configPath = (Get-Item -LiteralPath $Path).FullName
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return Resolve-SopIisSettings -Config $config -BasePath (Split-Path -Parent $configPath)
}

function Resolve-SopIisSettings {
    param([object]$Config, [string]$BasePath)
    foreach ($name in @('SiteName', 'DeploymentRoot', 'ApplicationPool', 'BackendPort', 'PublicOrigin', 'AllowWrites', 'ProxySecretPath')) {
        if ($null -eq $config.PSObject.Properties[$name]) { throw "Missing SOP IIS configuration property: $name" }
    }
    foreach ($name in @('SiteName', 'ApplicationPool')) {
        if ([string]$config.$name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw "Invalid $name" }
    }
    foreach ($name in @('DeploymentRoot', 'ProxySecretPath')) {
        if ($config.$name -isnot [string]) { throw "$name must be a path string." }
    }
    $config.DeploymentRoot = Resolve-LocalDeploymentPath -Value $config.DeploymentRoot -BasePath $BasePath -Name 'DeploymentRoot'
    $config.ProxySecretPath = Resolve-LocalDeploymentPath -Value $config.ProxySecretPath -BasePath $config.DeploymentRoot -Name 'ProxySecretPath'
    if (-not $config.ProxySecretPath.StartsWith($config.DeploymentRoot + '\config\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ProxySecretPath must be under DeploymentRoot\config, outside the web roots.' }
    if (($config.BackendPort -isnot [int] -and $config.BackendPort -isnot [long]) -or $config.BackendPort -lt 1 -or $config.BackendPort -gt 65535) { throw 'BackendPort must be an integer in 1..65535.' }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$config.PublicOrigin, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) { throw 'PublicOrigin must be a canonical HTTP(S) origin, without a path.' }
    if ([string]$config.PublicOrigin -cne $uri.GetLeftPart([UriPartial]::Authority)) { throw 'PublicOrigin must use the canonical origin form, without trailing slash or default port.' }
    if ($null -ne $config.PSObject.Properties['WriteGroups']) { throw 'WriteGroups is obsolete. Review the department access boundary, remove WriteGroups and explicitly set AllowWrites for all members.' }
    if ($config.AllowWrites -isnot [bool]) { throw 'AllowWrites must be a boolean global switch, not a per-user role.' }
    return $config
}

function Resolve-SopGatewayTemplate {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$DeploymentRoot)
    if ($DeploymentRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'Resolve the deployment root before generating gateway configuration.' }
    $root = Resolve-LocalDeploymentPath -Value $DeploymentRoot -BasePath $DeploymentRoot -Name 'DeploymentRoot'
    $gateway = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    # Portal-only template metadata. The child receives only its existing absolute path fields.
    $storageRoot = $root
    if ($null -ne $gateway.PSObject.Properties['storage_root']) {
        if ($gateway.storage_root -isnot [string]) { throw 'storage_root must be a path string.' }
        $storageRoot = Resolve-LocalDeploymentPath -Value $gateway.storage_root -BasePath $root -Name 'storage_root'
        $gateway.PSObject.Properties.Remove('storage_root')
    }
    foreach ($name in @('data_dir', 'source_dir', 'shared_config', 'plan_file')) {
        if ($null -eq $gateway.PSObject.Properties[$name]) { throw "Missing gateway template path: $name" }
        if ($gateway.$name -isnot [string]) { throw "$name must be a path string." }
        $value = [string]$gateway.$name
        $resolved = Resolve-LocalDeploymentPath -Value $value -BasePath $storageRoot -Name $name
        if ($value -notmatch '^[A-Za-z]:[\\/]' -and -not $resolved.StartsWith($storageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Relative $name must stay inside the configured storage root." }
        foreach ($folder in @('portal', 'apps', 'proxy')) {
            $webRoot = Join-Path $root $folder
            if ($resolved -eq $webRoot -or $resolved.StartsWith($webRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "$name must stay outside web roots." }
        }
        $gateway.$name = $resolved
    }
    return $gateway
}

function Write-SopJson {
    param([string]$Path, [object]$Value)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $utf8)
}

function New-SopProxySecret {
    $random = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($random)
        return [BitConverter]::ToString($random).Replace('-', '').ToLowerInvariant()
    }
    finally { $rng.Dispose(); [Array]::Clear($random, 0, $random.Length) }
}

function Set-SopRestrictedAcl {
    param([string]$Path, [string[]]$ReadAccounts)
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
    }
    foreach ($account in $ReadAccounts) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($account, 'Read', 'Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}


function Get-SopValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function Resolve-SopBoundPath {
    param([string]$Root, [string]$Value, [string]$Name)
    $path = Resolve-LocalDeploymentPath -Value $Value -BasePath $Root -Name $Name
    foreach ($folder in @('portal', 'apps', 'proxy', 'releases')) {
        $web = Join-Path $Root $folder
        if ($path -ieq $web -or $path.StartsWith($web + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Name must stay outside published version and web directories."
        }
    }
    return $path
}

function Get-SopBindingOrigin {
    param($Definition, [string]$PublicOrigin)
    if ($PublicOrigin) { return $PublicOrigin }
    $health = Get-SopValue $Definition 'healthUrl' ''
    $uri = $null
    if (-not [Uri]::TryCreate([string]$health, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo) {
        throw 'SOP needs publicOrigin or an absolute public healthUrl.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Assert-SopRuntimeConsistency {
    param([string]$Root, $Definition, [string]$PublicOrigin = '', [switch]$RequireInitialized, [switch]$AllowIdentityUpdate)
    $origin = Get-SopBindingOrigin -Definition $Definition -PublicOrigin $PublicOrigin
    $data = Resolve-SopBoundPath -Root $Root -Value ([string]$Definition.dataDirectory) -Name 'SOP dataDirectory'
    $secretValue = Get-SopValue (Get-SopValue $Definition 'secretEnvironmentFiles') 'SOP_PROXY_SECRET' ''
    if (-not $secretValue) { throw 'SOP needs secretEnvironmentFiles.SOP_PROXY_SECRET.' }
    $secret = Resolve-LocalDeploymentPath -Value $secretValue -BasePath $Root -Name 'SOP secret file'
    $gatewayPath = Join-Path $Root 'config\sop.json'
    $arguments = Get-SopValue $Definition 'arguments'
    if ($arguments -isnot [Array]) { throw 'SOP requires arguments with the canonical --gateway-config path.' }
    $gatewayIndices = @(for ($i = 0; $i -lt $arguments.Count; $i++) { if ($arguments[$i] -ceq '--gateway-config') { $i } })
    if ($gatewayIndices.Count -ne 1 -or $gatewayIndices[0] + 1 -ge $arguments.Count) { throw 'SOP requires exactly one --gateway-config path.' }
    $argumentPath = [string]$arguments[$gatewayIndices[0] + 1]
    $argumentPath = $argumentPath.Replace('{deployment}', $Root)
    $actualGateway = Resolve-LocalDeploymentPath -Value $argumentPath -BasePath $Root -Name 'SOP --gateway-config'
    if ($actualGateway -ine $gatewayPath) { throw 'SOP --gateway-config must use the validated deployment config/sop.json. No service was started.' }
    $authPath = Join-Path $Root 'config\sop-auth.json'
    $proxyPath = Join-Path $Root 'proxy\sop\web.config'
    if ($RequireInitialized) {
        foreach ($path in @($gatewayPath, $authPath, $proxyPath)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'SOP first-time identity initialization is incomplete. Run Configure-SopProxy with the same deployment config before publishing.' }
        }
    }
    $gateway = $null
    if (Test-Path -LiteralPath $gatewayPath) {
        Assert-NoReparsePoint -Path $gatewayPath
        $gateway = Get-Content -LiteralPath $gatewayPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Get-SopValue $gateway 'data_dir' '') -ine $data) { throw 'SOP gateway data_dir differs from deployment dataDirectory. Align the configuration with the existing data; no data was moved.' }
        if ((Get-SopValue $gateway 'base_path' '') -cne '/sop' -or (Get-SopValue $gateway 'proxy_secret_env' '') -cne 'SOP_PROXY_SECRET') { throw 'Existing SOP gateway prefix or secret environment binding differs.' }
        if (-not $AllowIdentityUpdate -and (Get-SopValue $gateway 'public_origin' '') -cne $origin) { throw 'SOP gateway public_origin differs from the deployment public origin. Reconfigure the owned identity bridge before publishing.' }
        # Only explicit business path overrides are compared. Existing legacy paths are retained otherwise.
        $paths = Get-SopValue $Definition 'gatewayPaths'
        foreach ($name in @('source_dir', 'shared_config', 'plan_file')) {
            $value = Get-SopValue $paths $name ''
            if ($value) {
                $expected = Resolve-SopBoundPath -Root $Root -Value $value -Name ('SOP ' + $name)
                if ((Get-SopValue $gateway $name '') -ine $expected) { throw "Existing SOP gateway $name differs from the explicit deployment binding. Review the actual business path; it was not changed." }
            }
        }
    }
    if (Test-Path -LiteralPath $authPath) {
        Assert-NoReparsePoint -Path $authPath
        $auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Get-SopValue $auth 'ProxySecretPath' '') -ine $secret) { throw 'SOP identity secret path differs from the runtime binding. Review key migration separately; no key was rotated.' }
        if (-not $AllowIdentityUpdate) {
            if ((Get-SopValue $auth 'BackendPort' 0) -ne $Definition.port -or (Get-SopValue $auth 'PublicOrigin' '') -cne $origin) { throw 'SOP identity origin or backend port differs from the runtime binding. Reconfigure the owned bridge before publishing.' }
            if ($null -ne $gateway -and (Get-SopValue $auth 'AllowWrites') -ne (Get-SopValue $gateway 'allow_writes')) { throw 'SOP identity and gateway maintenance switches differ.' }
            if ($null -ne $Definition.PSObject.Properties['allowWrites'] -and (Get-SopValue $auth 'AllowWrites') -ne $Definition.allowWrites) { throw 'SOP maintenance switch differs from the explicit deployment binding.' }
        }
    }
    if (Test-Path -LiteralPath $proxyPath) {
        Assert-NoReparsePoint -Path $proxyPath
        [xml]$proxy = Get-Content -LiteralPath $proxyPath -Raw -Encoding UTF8
        if (-not $proxy.SelectSingleNode('/configuration/appSettings/add[@key="SopIdentityBridgeOwner"][@value="DataPlatform-SOP-v1"]')) { throw 'Existing SOP proxy is not owned by this integration tool.' }
        $configNode = $proxy.SelectSingleNode('/configuration/appSettings/add[@key="SopProxyConfigPath"]')
        if ($null -eq $configNode -or [string]$configNode.GetAttribute('value') -ine $authPath) { throw 'Existing SOP proxy reads a different identity configuration.' }
        if (-not $AllowIdentityUpdate) {
            $actions = @($proxy.SelectNodes('/configuration/system.webServer/rewrite/rules/rule/action[@type="Rewrite"]'))
            $expectedTarget = 'http://127.0.0.1:' + $Definition.port + '/sop/{R:1}'
            if ($actions.Count -ne 1 -or [string]$actions[0].GetAttribute('url') -cne $expectedTarget) { throw 'SOP proxy target differs from the runtime backend port. Reconfigure the owned bridge before publishing.' }
        }
    }
}

function Read-SopDeploymentBinding {
    param([string]$Path, [string]$ServiceAccount = '')
    . (Join-Path $PSScriptRoot 'Environment.Config.ps1')
    $settings = Read-RuntimeSettings -Path $Path
    $definition = Get-SopValue $settings.Config.applications 'sop'
    if ($null -eq $definition -or (Get-SopValue $definition 'kind' '') -cne 'service' -or (Get-SopValue $definition 'proxyMode' '') -cne 'existing') { throw 'The unified deployment config needs a SOP service with its existing identity proxy.' }
    $account = [string](Get-SopValue $definition 'serviceAccount' '')
    if ($account -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$') { throw 'SOP requires an explicit local/domain serviceAccount in deployment.json.' }
    if ($ServiceAccount -and $ServiceAccount -ine $account) { throw 'Explicit ServiceAccount differs from the unified SOP serviceAccount.' }
    $root = $settings.Root
    $origin = Get-SopBindingOrigin -Definition $definition -PublicOrigin $settings.PublicOrigin
    $secretValue = Get-SopValue (Get-SopValue $definition 'secretEnvironmentFiles') 'SOP_PROXY_SECRET' ''
    $data = Resolve-SopBoundPath -Root $root -Value ([string]$definition.dataDirectory) -Name 'SOP dataDirectory'
    $gatewayPath = Join-Path $root 'config\sop.json'
    $existing = if (Test-Path -LiteralPath $gatewayPath) { Get-Content -LiteralPath $gatewayPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $allowWrites = Get-SopValue $definition 'allowWrites' (Get-SopValue $existing 'allow_writes' $true)
    $config = [pscustomobject][ordered]@{
        SiteName = $settings.Config.siteName
        DeploymentRoot = $root
        ApplicationPool = [string](Get-SopValue $definition 'proxyApplicationPool' ($settings.Config.siteName + '-SopProxy'))
        BackendPort = $definition.port
        PublicOrigin = $origin
        AllowWrites = $allowWrites
        ProxySecretPath = $secretValue
    }
    $config = Resolve-SopIisSettings -Config $config -BasePath (Split-Path -Parent $settings.ConfigFile)
    $gateway = [pscustomobject][ordered]@{base_path='/sop';public_origin=$origin;proxy_secret_env='SOP_PROXY_SECRET';allow_writes=$allowWrites;data_dir=$data}
    $configuredPaths = Get-SopValue $definition 'gatewayPaths'
    $defaults = @{source_dir=(Join-Path $settings.SharedDirectory '订单汇总');shared_config=(Join-Path $root 'config\shared_config.py');plan_file=(Join-Path $settings.SharedDirectory 'SOP计划\SOP计划维护.xlsx')}
    foreach ($name in @('source_dir','shared_config','plan_file')) {
        $value = [string](Get-SopValue $configuredPaths $name $defaults[$name])
        $resolved = Resolve-SopBoundPath -Root $root -Value $value -Name ('SOP ' + $name)
        $gateway | Add-Member -NotePropertyName $name -NotePropertyValue $resolved
    }
    Assert-SopRuntimeConsistency -Root $root -Definition $definition -PublicOrigin $origin -AllowIdentityUpdate
    if ($null -ne $existing) { $gateway = $existing }
    return [pscustomobject]@{Settings=$settings;Definition=$definition;Config=$config;Gateway=$gateway;ServiceAccount=$account}
}
