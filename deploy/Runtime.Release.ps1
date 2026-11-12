# Shared validation for offline deployment. Never run child business code here.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'App.Release.ps1')
. (Join-Path $PSScriptRoot 'Environment.Config.ps1')
. (Join-Path $PSScriptRoot 'Sop.Common.ps1')
. (Join-Path $PSScriptRoot 'Identity.Proxy.ps1')
function Test-Within([string]$Root, [string]$Path) {
    return $Path.Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Assert-LocalPath([string]$Path) {
    if ($Path -match '["\r\n]' -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.Length -le 3) { throw 'Expected a local directory below a drive root.' }
    $ancestor = $Path
    while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
    Assert-NoReparsePoint $ancestor
}
function Read-InstallPlan([string]$ReleasePath, [string]$ConfigPath) {
    $release = Assert-AppRelease $ReleasePath
    $settings = Read-RuntimeSettings $ConfigPath
    $configFile = $settings.ConfigFile
    $config = $settings.Config
    $root = $settings.Root
    Assert-LocalPath $root
    $id = $release.Manifest.appId
    $definition = Get-Setting $config.applications $id
    if ($null -eq $definition) { throw "No local deployment binding for $id." }
    $kind = [string]$definition.kind
    if ($kind -notin @('portal','static','service') -or ($kind -eq 'service') -ne ($release.Manifest.type -eq 'service')) { throw 'Release type and deployment kind differ.' }
    if (($id -eq 'planhub') -ne ($kind -eq 'portal')) { throw 'planhub is reserved for the site root.' }
    $destination = Join-Path $root ('releases\'+$id+'\'+$release.Manifest.version)
    if (Test-Within $release.Root $destination) { throw 'Installed release must be outside the incoming release.' }
    if (Test-Within (Join-Path $root 'releases') $configFile) { throw 'Machine configuration must be outside version directories.' }
    $healthUrl = [uri]([string]$definition.healthUrl)
    if (-not $healthUrl.IsAbsoluteUri -or $healthUrl.Scheme -notin @('http','https') -or $healthUrl.UserInfo -or $healthUrl.Fragment) { throw 'healthUrl must be a public HTTP(S) URL without credentials.' }
    $prefix = if ($kind -eq 'portal') { '/' } else { '/'+$id+'/' }
    if (-not $healthUrl.AbsolutePath.StartsWith($prefix,[StringComparison]::Ordinal)) { throw 'healthUrl must stay inside the application prefix.' }
    if ($kind -eq 'service') {
        foreach ($field in @('command','arguments','environment','dataDirectory','port','taskName','serviceAccount','backendHealthPath','proxyMode')) {
            if ($null -eq $definition.PSObject.Properties[$field]) { throw "Missing service setting: $field" }
        }
        if ($definition.arguments -isnot [Array] -or @($definition.arguments | Where-Object { $_ -isnot [string] }).Count) { throw 'arguments must be a string array.' }
        if ($definition.port -isnot [int] -or $definition.port -lt 1 -or $definition.port -gt 65535) { throw 'Invalid port.' }
        if ($definition.taskName -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid taskName.' }
        if ($definition.serviceAccount -notmatch '^[^\\\x00-\x1f]+\\[^\\\x00-\x1f]+$' -or $definition.serviceAccount -match '(?i)(^|\\)(SYSTEM|LocalSystem|Administrators)$') { throw 'Set an explicit local/domain serviceAccount.' }
        if ($definition.backendHealthPath -notmatch '^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*$') { throw 'Invalid backendHealthPath.' }
        if ($definition.proxyMode -notin @('prefix','existing')) { throw 'proxyMode must be prefix or existing.' }
        if ((Get-Setting $definition 'backendHealthMode' 'direct') -notin @('direct','public')) { throw 'backendHealthMode must be direct or public.' }
        if ($id -eq 'sop' -and ((Get-Setting $definition 'backendHealthMode' 'direct') -ne 'public')) { throw 'SOP health must use its authenticated public IIS endpoint.' }
        if ($id -eq 'sop' -and $definition.proxyMode -ne 'existing') { throw 'SOP requires its separately installed authenticated IIS bridge.' }
        $data = Resolve-LocalDeploymentPath $definition.dataDirectory $root 'dataDirectory'
        $command = Resolve-LocalDeploymentPath $definition.command $root 'command'
        foreach ($item in @($data,$command)) {
            Assert-LocalPath $item
            if ((Test-Within (Join-Path $root 'releases') $item) -or (Test-Within (Join-Path $root 'proxy') $item)) { throw 'Runtime and data must live outside versions and proxy web roots.' }
        }
        if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { throw "Runtime missing: $command. Prepare runtime and dependencies on the deployment computer." }
        if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw "Persistent directory missing: $data. Initialize or migrate it before publishing." }
        foreach ($name in @('environment','secretEnvironmentFiles')) {
            $map = Get-Setting $definition $name ([pscustomobject]@{})
            if ($map -isnot [pscustomobject]) { throw "$name must be an object." }
            foreach ($property in $map.PSObject.Properties) {
                if ($property.Name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $property.Value -isnot [string]) { throw "Invalid $name item." }
                if ($property.Name -match '^(?i:PATH|PATHEXT|COMSPEC|WINDIR|SYSTEMROOT|PSMODULEPATH|HOME|USERPROFILE|CODEX_HOME)$') { throw "Reserved environment variable: $($property.Name)" }
                if ($name -eq 'secretEnvironmentFiles') {
                    $secret = Resolve-LocalDeploymentPath $property.Value $root 'secret file'
                    Assert-LocalPath $secret
                    if ((Test-Within (Join-Path $root 'releases') $secret) -or (Test-Within (Join-Path $root 'proxy') $secret)) { throw 'Secrets must be outside versions and proxy web roots.' }
                    if (-not (Test-Path -LiteralPath $secret -PathType Leaf)) { throw 'A secret file is missing.' }
                }
            }
        }
        if ($null -ne (Get-Setting $definition 'identityProxy')) { Assert-IdentityProxyConsistency -Root $root -Id $id -Definition $definition -RequireInitialized }
        if ($id -eq 'sop') {
            if ('--gateway-config' -notin $definition.arguments -or $null -eq (Get-Setting (Get-Setting $definition 'secretEnvironmentFiles') 'SOP_PROXY_SECRET')) { throw 'SOP needs --gateway-config and its existing SOP_PROXY_SECRET file binding.' }
            Assert-SopRuntimeConsistency -Root $root -Definition $definition -PublicOrigin $settings.PublicOrigin -RequireInitialized
        }
    }
    return [pscustomobject]@{Release=$release;Root=$root;Definition=$definition;Kind=$kind;SiteName=$config.siteName;Destination=$destination;Id=$id;ConfigFile=$configFile;StateRoot=(Join-Path $root ('state\'+$id));HealthUrl=$healthUrl.AbsoluteUri}
}
function Write-AtomicJson([string]$Path, $Value) {
    $temporary = $Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    Write-AppReleaseJson $temporary $Value
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}
function Expand-RunValue([string]$Value, $Runtime) {
    return $Value.Replace('{payload}',[string]$Runtime.payload).Replace('{deployment}',[string]$Runtime.root).Replace('{data}',[string]$Runtime.dataDirectory).Replace('{port}',[string]$Runtime.definition.port)
}
function Test-PublicHealth([string]$Url) {
    try { $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -UseDefaultCredentials -TimeoutSec 5 -MaximumRedirection 0; return ($response.StatusCode -eq 200) } catch { return $false }
}
function Test-BackendHealth($Definition) {
    try {
        if ((Get-Setting $Definition 'backendHealthMode' 'direct') -eq 'public') {
            $response = Invoke-WebRequest -Uri $Definition.healthUrl -UseBasicParsing -UseDefaultCredentials -TimeoutSec 5 -MaximumRedirection 0
        } else {
            $response = Invoke-WebRequest -Uri ('http://127.0.0.1:'+$Definition.port+$Definition.backendHealthPath) -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
        }
        if ($response.StatusCode -ne 200) { return $false }
        $expected = Get-Setting $Definition 'healthExpected' ([pscustomobject]@{})
        if (@($expected.PSObject.Properties).Count) {
            $body = $response.Content | ConvertFrom-Json
            foreach ($item in $expected.PSObject.Properties) { if ((Get-Setting $body $item.Name) -cne $item.Value) { return $false } }
        }
        return $true
    } catch { return $false }
}
function Test-PortFree([int]$Port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$Port)
    try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}
function Assert-OwnedTask($Task, [string]$Id, [string]$Root) {
    if ($Task.Description -cne ('PlanHub managed '+$Id+' '+$Root)) { throw 'Refusing to replace or stop an unrelated scheduled task.' }
}

function Wait-DeploymentHealth {
    param($Definition, [string]$HealthUrl, [ValidateRange(1,600)][int]$TimeoutSeconds = 60, [ValidateRange(1,1000)][int]$IntervalMilliseconds = 500)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (($null -eq $Definition -or (Test-BackendHealth $Definition)) -and (Test-PublicHealth $HealthUrl)) { return $true }
        $remaining = $TimeoutSeconds * 1000 - $watch.Elapsed.TotalMilliseconds
        if ($remaining -le 0) { break }
        Start-Sleep -Milliseconds ([int][Math]::Min($IntervalMilliseconds,$remaining))
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    return $false
}
