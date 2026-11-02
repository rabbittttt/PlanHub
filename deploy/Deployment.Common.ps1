Set-StrictMode -Version Latest

function Read-DeploymentConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('SiteName', 'ApplicationPool', 'DeploymentRoot', 'HostName', 'Port', 'RequireReverseProxy', 'StaticApplications')) {
        if ($null -eq $config.PSObject.Properties[$name]) { throw "Missing configuration property: $name" }
    }
    foreach ($name in @('SiteName', 'ApplicationPool')) {
        if ([string]$config.$name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw "Invalid $name. Use letters, numbers, hyphens and underscores." }
    }
    if ([string]$config.DeploymentRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'DeploymentRoot must be an absolute local drive path.' }
    $root = [IO.Path]::GetFullPath([string]$config.DeploymentRoot).TrimEnd('\', '/')
    if ($root.Length -le 3) { throw 'DeploymentRoot must not be a drive root.' }
    $config.DeploymentRoot = $root
    if ($config.Port -isnot [int] -and $config.Port -isnot [long]) { throw 'Port must be an integer.' }
    if ($config.Port -lt 1 -or $config.Port -gt 65535) { throw 'Port must be in 1..65535.' }
    if ([string]$config.HostName -notmatch '^$|^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw 'HostName must be empty or a DNS hostname, without scheme or port.' }
    if ($config.RequireReverseProxy -isnot [bool]) { throw 'RequireReverseProxy must be true or false.' }
    if ($config.StaticApplications -isnot [Array]) { throw 'StaticApplications must be an array.' }
    $names = @{}
    foreach ($app in $config.StaticApplications) {
        if ($null -eq $app.PSObject.Properties['Name'] -or $null -eq $app.PSObject.Properties['Enabled']) { throw 'Each static application needs Name and Enabled.' }
        if ([string]$app.Name -notmatch '^[a-z][a-z0-9-]{0,39}$' -or $app.Name -in @('config', 'css', 'js', 'data', 'logs', 'services', 'api')) { throw "Invalid or reserved application name: $($app.Name)" }
        if ($names.ContainsKey($app.Name)) { throw "Duplicate application name: $($app.Name)" }
        $names[$app.Name] = $true
        if ($app.Enabled -isnot [bool]) { throw "Enabled must be boolean for $($app.Name)." }
    }
    return $config
}

function Assert-NoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not supported: $($item.FullName)" }
        $item = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
    }
}
