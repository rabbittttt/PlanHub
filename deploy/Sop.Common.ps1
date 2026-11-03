Set-StrictMode -Version Latest

function Read-SopIisConfig {
    param([string]$Path)
    $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('SiteName', 'DeploymentRoot', 'ApplicationPool', 'BackendPort', 'PublicOrigin', 'AllowWrites', 'ProxySecretPath')) {
        if ($null -eq $config.PSObject.Properties[$name]) { throw "Missing SOP IIS configuration property: $name" }
    }
    foreach ($name in @('SiteName', 'ApplicationPool')) {
        if ([string]$config.$name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw "Invalid $name" }
    }
    foreach ($name in @('DeploymentRoot', 'ProxySecretPath')) {
        if ([string]$config.$name -notmatch '^[A-Za-z]:[\\/]') { throw "$name must be an absolute local drive path." }
        $config.$name = [IO.Path]::GetFullPath([string]$config.$name).TrimEnd('\', '/')
    }
    if ($config.DeploymentRoot.Length -le 3) { throw 'DeploymentRoot must not be a drive root.' }
    if (-not $config.ProxySecretPath.StartsWith($config.DeploymentRoot + '\config\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ProxySecretPath must be under DeploymentRoot\config, outside the web roots.' }
    if (($config.BackendPort -isnot [int] -and $config.BackendPort -isnot [long]) -or $config.BackendPort -lt 1 -or $config.BackendPort -gt 65535) { throw 'BackendPort must be an integer in 1..65535.' }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$config.PublicOrigin, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) { throw 'PublicOrigin must be a canonical HTTP(S) origin, without a path.' }
    if ([string]$config.PublicOrigin -cne $uri.GetLeftPart([UriPartial]::Authority)) { throw 'PublicOrigin must use the canonical origin form, without trailing slash or default port.' }
    if ($null -ne $config.PSObject.Properties['WriteGroups']) { throw 'WriteGroups is obsolete. Review the department access boundary, remove WriteGroups and explicitly set AllowWrites for all members.' }
    if ($config.AllowWrites -isnot [bool]) { throw 'AllowWrites must be a boolean global switch, not a per-user role.' }
    return $config
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
