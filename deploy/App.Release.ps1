# Generic release envelopes. Application code is copied byte-for-byte and never executed here.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Write-AppReleaseJson {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 30) + "`n"), (New-Object Text.UTF8Encoding($false)))
}
function Test-AppReleasePath {
    param([string]$Path)
    if (-not $Path -or $Path -match '[\\:*?"<>|\x00-\x1f]' -or $Path.StartsWith('/')) { return $false }
    foreach ($part in $Path.Split('/')) {
        if (-not $part -or $part.StartsWith('.') -or $part -match '[. ]$' -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' -or
            $part -in @('data','input_file','output_file','logs','backups','node_modules','runtime','tests','__pycache__')) { return $false }
    }
    return ([IO.Path]::GetExtension($Path).ToLowerInvariant() -notin @('.db','.sqlite','.sqlite3','.xlsx','.xls','.xlsm','.secret','.pem','.key','.pfx','.p12','.pyc','.log','.db-wal','.db-shm','.sqlite-wal','.sqlite-shm','.sqlite3-wal','.sqlite3-shm'))
}
function Get-AppPayloadFiles {
    param([string]$Path)
    $root = (Get-Item -LiteralPath $Path -Force).FullName.TrimEnd('\', '/')
    Assert-NoReparsePoint -Path $root
    $files = @{}
    foreach ($item in Get-ChildItem -LiteralPath $root -Force -Recurse) {
        Assert-NoReparsePoint -Path $item.FullName
        $relative = $item.FullName.Substring($root.Length + 1).Replace('\','/')
        if (-not (Test-AppReleasePath $relative)) { throw "Non-release path in payload: $relative" }
        if (-not $item.PSIsContainer) { $files[$relative] = $item.FullName }
    }
    if (-not $files.Count) { throw 'Release payload is empty.' }
    return $files
}
function Assert-AppManifest {
    param($Manifest)
    foreach ($name in @('schemaVersion','appId','version','type','basePath','entryPoint','sourceRevision','dataMode','healthPath','files')) {
        if ($null -eq $Manifest.PSObject.Properties[$name]) { throw "Missing release field: $name" }
    }
    if ($Manifest.schemaVersion -ne 1 -or ($Manifest.schemaVersion -isnot [int] -and $Manifest.schemaVersion -isnot [long])) { throw 'Unsupported release schema.' }
    if ($Manifest.appId -isnot [string] -or $Manifest.appId -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or
        $Manifest.appId -in @('api','home','portal','config','assets','css','js','data','services','deploy','logs','tests')) { throw 'Invalid appId.' }
    if ($Manifest.version -isnot [string] -or $Manifest.version -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' -or $Manifest.version -match '[. ]$') { throw 'Invalid version.' }
    if ($Manifest.type -cnotin @('static','service') -or $Manifest.basePath -cne ('/' + $Manifest.appId + '/')) { throw 'Invalid release type or basePath.' }
    if ($Manifest.entryPoint -isnot [string] -or -not (Test-AppReleasePath $Manifest.entryPoint)) { throw 'Invalid release entryPoint.' }
    if ($Manifest.sourceRevision -isnot [string] -or -not $Manifest.sourceRevision.Trim() -or $Manifest.sourceRevision -match '[\x00-\x1f]') { throw 'sourceRevision is required.' }
    if ($Manifest.dataMode -cnotin @('external','stateless')) { throw 'Mutable data must be external to the release.' }
    if ($Manifest.type -ceq 'static') {
        if ($Manifest.entryPoint -cne 'index.html' -or $Manifest.dataMode -cne 'stateless' -or $Manifest.healthPath -cne '/') { throw 'Static releases require index.html, stateless and healthPath /.' }
    } elseif ($Manifest.healthPath -isnot [string] -or $Manifest.healthPath -cnotmatch '^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*$') { throw 'Use a fixed lightweight HTTP health path.' }
    if ($Manifest.files -isnot [Array] -or -not $Manifest.files.Count) { throw 'Release requires a nonempty files array.' }
    $seen = @{}
    foreach ($entry in $Manifest.files) {
        foreach ($name in @('path','sha256','bytes')) { if ($null -eq $entry.PSObject.Properties[$name]) { throw "Missing file field: $name" } }
        if ($entry.path -isnot [string] -or -not (Test-AppReleasePath $entry.path) -or $seen.ContainsKey($entry.path)) { throw 'Unsafe or duplicate release path.' }
        if ($entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            ($entry.bytes -isnot [int] -and $entry.bytes -isnot [long]) -or $entry.bytes -lt 0) { throw 'Invalid file checksum or length.' }
        if ($Manifest.type -ceq 'static' -and -not ($Manifest.appId -ceq 'planhub' -and $entry.path -ceq 'web.config') -and [IO.Path]::GetExtension($entry.path).ToLowerInvariant() -notin @('.html','.css','.js','.mjs','.json','.svg','.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.txt')) { throw 'Non-public file in static release.' }
        $seen[$entry.path] = $true
    }
    if (-not $seen.ContainsKey($Manifest.entryPoint)) { throw 'Release entryPoint is missing.' }
}
function New-AppManifest {
    param([string]$PayloadPath, [string]$AppId, [string]$Version, [string]$Type,
        [string]$EntryPoint, [string]$SourceRevision, [string]$DataMode, [string]$HealthPath = '/')
    $files = Get-AppPayloadFiles $PayloadPath
    $manifest = [pscustomobject][ordered]@{schemaVersion=1;appId=$AppId;version=$Version;type=$Type;basePath="/$AppId/";entryPoint=$EntryPoint;sourceRevision=$SourceRevision;dataMode=$DataMode;healthPath=$HealthPath;files=@()}
    foreach ($relative in ($files.Keys | Sort-Object)) {
        $file = $files[$relative]
        $manifest.files += [pscustomobject]@{path=$relative;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $file).Length}
    }
    Assert-AppManifest $manifest
    return $manifest
}
function Assert-AppPayload {
    param([string]$Path, $Manifest)
    Assert-AppManifest $Manifest
    $actual = Get-AppPayloadFiles $Path
    if ($actual.Count -ne $Manifest.files.Count) { throw 'Payload file set differs from the release manifest.' }
    foreach ($entry in $Manifest.files) {
        if (-not $actual.ContainsKey($entry.path)) { throw "Missing release file: $($entry.path)" }
        $file = $actual[$entry.path]
        if ((Get-Item -LiteralPath $file).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw "Release file changed: $($entry.path)" }
    }
    return $actual
}
function Assert-AppRelease {
    param([string]$Path)
    $root = (Get-Item -LiteralPath $Path -Force).FullName.TrimEnd('\','/')
    Assert-NoReparsePoint $root
    $entries = @(Get-ChildItem -LiteralPath $root -Force)
    if ($entries.Count -ne 2 -or @($entries | Where-Object { $_.Name -cnotin @('payload','app-release.json') }).Count) { throw 'A release envelope contains only payload/ and app-release.json.' }
    $manifestFile = Join-Path $root 'app-release.json'
    Assert-NoReparsePoint $manifestFile
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $files = Assert-AppPayload -Path (Join-Path $root 'payload') -Manifest $manifest
    return [pscustomobject]@{Root=$root;Manifest=$manifest;Files=$files}
}
function Copy-AppPayload {
    param($Release, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) { throw 'Release destination exists; never overwrite a running release.' }
    $target = [IO.Path]::GetFullPath($Destination)
    $ancestor = Split-Path -Parent $target
    while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
    Assert-NoReparsePoint $ancestor
    New-Item -ItemType Directory -Path $target | Out-Null
    foreach ($relative in $Release.Files.Keys) {
        $file = Join-Path $target ($relative.Replace('/','\'))
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
        Copy-Item -LiteralPath $Release.Files[$relative] -Destination $file
    }
    $null = Assert-AppPayload -Path $target -Manifest $Release.Manifest
}
