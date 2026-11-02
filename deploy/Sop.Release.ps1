Set-StrictMode -Version Latest

function Get-SopFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Test-SopReleaseRelativePath {
    param([string]$Path)
    if ($Path -cnotmatch '^[A-Za-z0-9_./-]+$') { return $false }
    $parts = $Path.Split('/')
    foreach ($part in $parts) {
        if (-not $part -or $part.StartsWith('.') -or $part -in @('data', 'input_file', 'output_file', 'tests', 'node_modules', '__pycache__')) { return $false }
    }
    $extension = [IO.Path]::GetExtension($Path)
    if ($parts.Count -eq 1) {
        return ($extension -ceq '.py' -or $Path -cin @('requirements.txt', 'requirements-intranet.txt', 'README.md', 'PORTAL-INTEGRATION.md'))
    }
    return (($parts[0] -ceq 'web' -and $extension.ToLowerInvariant() -in @('.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2')) -or
        ($parts.Count -eq 2 -and $parts[0] -ceq 'scripts' -and $extension -ceq '.mjs') -or
        ($parts.Count -eq 3 -and $parts[0] -ceq 'integration' -and $parts[1] -ceq 'iis' -and $extension -ceq '.cs'))
}

function Assert-SopRelease {
    param([Parameter(Mandatory = $true)][string]$Path)
    $root = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'The explicit SOP release directory does not exist.' }
    Assert-NoReparsePoint -Path $root
    $manifestPath = Join-Path $root 'sop-release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Missing sop-release.json. Build the SOP release in its original project first.' }
    Assert-NoReparsePoint -Path $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('schemaVersion', 'appId', 'sourceCommit', 'sourceDirty', 'files')) {
        if ($null -eq $manifest.PSObject.Properties[$name]) { throw "SOP release manifest is missing: $name" }
    }
    if (($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or $manifest.schemaVersion -ne 1 -or $manifest.appId -cne 'hima-sop' -or $manifest.files -isnot [Array] -or $manifest.files.Count -lt 1) { throw 'Unsupported SOP release manifest.' }
    if ($null -ne $manifest.sourceCommit -and ([string]$manifest.sourceCommit -cnotmatch '^[0-9a-f]{40}$')) { throw 'Invalid SOP source commit in manifest.' }
    if ($null -ne $manifest.sourceDirty -and $manifest.sourceDirty -isnot [bool]) { throw 'Invalid SOP source status in manifest.' }
    $listed = @{}
    foreach ($entry in $manifest.files) {
        foreach ($name in @('path', 'sha256', 'bytes')) {
            if ($null -eq $entry.PSObject.Properties[$name]) { throw "SOP release entry is missing: $name" }
        }
        if ($entry.path -isnot [string] -or -not (Test-SopReleaseRelativePath -Path $entry.path)) { throw 'SOP release contains an unsafe or non-public path.' }
        if ($listed.ContainsKey($entry.path)) { throw 'Duplicate SOP release manifest path.' }
        if ($entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $entry.bytes -lt 0 -or ($entry.bytes -isnot [int] -and $entry.bytes -isnot [long])) { throw 'Invalid SOP release checksum or length.' }
        $file = Join-Path $root ($entry.path.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "SOP release file is missing: $($entry.path)" }
        Assert-NoReparsePoint -Path $file
        if ((Get-Item -LiteralPath $file).Length -ne $entry.bytes -or (Get-SopFileSha256 -Path $file) -cne $entry.sha256) { throw "SOP release file differs from manifest: $($entry.path)" }
        $listed[$entry.path] = $file
    }
    foreach ($required in @('server.py', 'sop_gateway.py', 'requirements.txt', 'requirements-intranet.txt', 'web/index.html', 'integration/iis/SopIdentityBridge.cs')) {
        if (-not $listed.ContainsKey($required)) { throw "SOP runtime release is incomplete: $required" }
    }
    # Check every entry, not only files listed by the manifest. A release cannot
    # carry undeclared data, secrets, runtimes or reparse directories.
    foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SOP release contains a reparse point.' }
        $relative = $item.FullName.Substring($root.Length + 1).Replace('\', '/')
        if ($item.PSIsContainer) {
            if (-not ($listed.Keys | Where-Object { $_.StartsWith($relative + '/', [StringComparison]::OrdinalIgnoreCase) })) { throw "Unexpected directory in SOP release: $relative" }
        } elseif ($relative -cne 'sop-release.json' -and -not $listed.ContainsKey($relative)) { throw "Undeclared file in SOP release: $relative" }
    }
    return [pscustomobject]@{ Root = $root; Manifest = $manifest; Files = $listed }
}
