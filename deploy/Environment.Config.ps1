# Environment-owned values are resolved once before any service or IIS mutation.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Get-Setting($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}
function Test-EnvironmentPathWithin([string]$Root, [string]$Path) {
    return $Path.Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Resolve-EnvironmentPath([string]$Value, [string]$Base, [string]$Name) {
    if ($Value -match '["\x00-\x1f]' -or $Value -match '\{(?:publicOrigin|publicHost|basePath|shared|deployment|payload|data|port)\}') { throw "Invalid characters or unresolved placeholders in $Name." }
    $resolved = Resolve-LocalDeploymentPath -Value $Value -BasePath $Base -Name $Name
    $ancestor = $resolved
    while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
    Assert-NoReparsePoint -Path $ancestor
    return $resolved
}
function Expand-EnvironmentValue($Value, $Tokens) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        foreach ($token in $Tokens.Keys) {
            if ($Value.Contains($token)) {
                if ($null -eq $Tokens[$token]) { throw "A publicOrigin is required to resolve $token." }
                $Value = $Value.Replace($token,[string]$Tokens[$token])
            }
        }
        return $Value
    }
    if ($Value -is [Array]) {
        $result = @()
        foreach ($item in $Value) { $result += ,(Expand-EnvironmentValue $item $Tokens) }
        return ,$result
    }
    if ($Value -is [pscustomobject]) {
        $result = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = Expand-EnvironmentValue $property.Value $Tokens }
        return [pscustomobject]$result
    }
    return $Value
}
function Read-RuntimeSettings([string]$Path) {
    $configFile = (Get-Item -LiteralPath $Path -Force).FullName
    Assert-NoReparsePoint -Path $configFile
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config -isnot [pscustomobject] -or (Get-Setting $config 'applications') -isnot [pscustomobject]) { throw 'Deployment configuration requires an applications object.' }
    if ((Get-Setting $config 'siteName') -isnot [string] -or $config.siteName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid siteName.' }
    $rootValue = Get-Setting $config 'deploymentRoot'
    if ($rootValue -isnot [string]) { throw 'deploymentRoot must be a path string.' }
    $root = Resolve-EnvironmentPath $rootValue (Split-Path -Parent $configFile) 'deploymentRoot'
    $origin = Get-Setting $config 'publicOrigin'
    $publicUri = $null
    if ($null -ne $origin) {
        if ($origin -isnot [string] -or -not [Uri]::TryCreate($origin,[UriKind]::Absolute,[ref]$publicUri) -or
            $publicUri.Scheme -notin @('http','https') -or $publicUri.UserInfo -or $publicUri.AbsolutePath -ne '/' -or $publicUri.Query -or $publicUri.Fragment -or
            $origin -cne $publicUri.GetLeftPart([UriPartial]::Authority)) { throw 'publicOrigin must be a canonical HTTP(S) origin without path, credentials, query or trailing slash.' }
    }
    $sharedValue = Get-Setting $config 'sharedDirectory' 'shared'
    if ($sharedValue -isnot [string]) { throw 'sharedDirectory must be a path string.' }
    $shared = Resolve-EnvironmentPath $sharedValue $root 'sharedDirectory'
    foreach ($folder in @('portal','apps','proxy','releases')) {
        if (Test-EnvironmentPathWithin (Join-Path $root $folder) $shared) { throw 'Shared input must stay outside published application and version directories.' }
    }
    $account = Get-Setting $config 'serviceAccount'
    if ($null -ne $account -and ($account -isnot [string] -or $account -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$' -or $account -match '(?i)(^|\\)(SYSTEM|LocalSystem|Administrators)$')) { throw 'serviceAccount must be an explicit local/domain service account.' }
    foreach ($application in $config.applications.PSObject.Properties) {
        $id = $application.Name
        if ($id -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $application.Value -isnot [pscustomobject]) { throw 'Invalid application binding.' }
        $basePath = if ($id -eq 'planhub') { '/' } else { '/'+$id+'/' }
        $tokens = [ordered]@{'{publicOrigin}'=$origin;'{publicHost}'=$(if($publicUri){$publicUri.DnsSafeHost}else{$null});'{basePath}'=$basePath;'{shared}'=$shared;'{deployment}'=$root}
        $definition = Expand-EnvironmentValue $application.Value $tokens
        if ((Get-Setting $definition 'kind') -eq 'service' -and $null -eq (Get-Setting $definition 'serviceAccount') -and $null -ne $account) {
            $definition | Add-Member -NotePropertyName serviceAccount -NotePropertyValue $account
        }
        if ($null -eq (Get-Setting $definition 'healthUrl')) {
            if ($null -eq $origin) { throw 'healthUrl or a publicOrigin is required for every application.' }
            $healthPath = $basePath
            if ((Get-Setting $definition 'kind') -eq 'service') {
                $backend = Get-Setting $definition 'backendHealthPath'
                if ($backend -isnot [string] -or $backend -cnotmatch '^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*$') { throw 'A stable backendHealthPath is required to derive healthUrl.' }
                $healthPath = if ($backend.StartsWith($basePath,[StringComparison]::Ordinal)) { $backend } else { $basePath+$backend.TrimStart('/') }
            }
            $definition | Add-Member -NotePropertyName healthUrl -NotePropertyValue ($origin+$healthPath)
        }
        $config.applications.$id = $definition
    }
    return [pscustomobject]@{Config=$config;Root=$root;ConfigFile=$configFile;PublicOrigin=$origin;SharedDirectory=$shared}
}
