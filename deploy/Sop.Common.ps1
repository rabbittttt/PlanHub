Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Read-SopIisConfig {
    param([string]$Path)
    $configPath = (Get-Item -LiteralPath $Path).FullName
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('SiteName', 'DeploymentRoot', 'ApplicationPool', 'BackendPort', 'PublicOrigin', 'AllowWrites', 'ProxySecretPath')) {
        if ($null -eq $config.PSObject.Properties[$name]) { throw "Missing SOP IIS configuration property: $name" }
    }
    foreach ($name in @('SiteName', 'ApplicationPool')) {
        if ([string]$config.$name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw "Invalid $name" }
    }
    foreach ($name in @('DeploymentRoot', 'ProxySecretPath')) {
        if ($config.$name -isnot [string]) { throw "$name must be a path string." }
    }
    $config.DeploymentRoot = Resolve-LocalDeploymentPath -Value $config.DeploymentRoot -BasePath (Split-Path -Parent $configPath) -Name 'DeploymentRoot'
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
