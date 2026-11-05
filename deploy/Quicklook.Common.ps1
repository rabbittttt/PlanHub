Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Resolve-QuicklookPath {
    param([string]$Value, [string]$BasePath, [string]$Name)
    if ($Value -match '["\x00-\x1f]') { throw "$Name contains an unsafe path character." }
    return Resolve-LocalDeploymentPath -Value $Value -BasePath $BasePath -Name $Name
}

function Assert-QuicklookExistingAncestor {
    param([string]$Path)
    $ancestor = $Path
    while (-not (Test-Path -LiteralPath $ancestor)) {
        $parent = Split-Path -Parent $ancestor
        if (-not $parent -or $parent -eq $ancestor) { throw "No existing ancestor for path: $Path" }
        $ancestor = $parent
    }
    Assert-NoReparsePoint -Path $ancestor
}

function Read-QuicklookConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $configPath = (Get-Item -LiteralPath $Path).FullName
    Assert-NoReparsePoint -Path $configPath
    if ($configPath -match '["\x00-\x1f]') { throw 'Unsafe configuration path.' }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('DeploymentRoot', 'ProjectRoot', 'SharedDataRoot', 'RuntimePath')) {
        if ($null -eq $config.PSObject.Properties[$name] -or $config.$name -isnot [string]) { throw "Missing or non-string QuickLook configuration property: $name" }
    }
    foreach ($property in $config.PSObject.Properties.Name) {
        if ($property -notin @('DeploymentRoot', 'ProjectRoot', 'SharedDataRoot', 'RuntimePath')) { throw "Unknown QuickLook configuration property: $property" }
    }
    $config.DeploymentRoot = Resolve-QuicklookPath $config.DeploymentRoot (Split-Path -Parent $configPath) 'DeploymentRoot'
    $config.ProjectRoot = Resolve-QuicklookPath $config.ProjectRoot $config.DeploymentRoot 'ProjectRoot'
    $config.RuntimePath = Resolve-QuicklookPath $config.RuntimePath $config.DeploymentRoot 'RuntimePath'
    if ($config.SharedDataRoot) { $config.SharedDataRoot = Resolve-QuicklookPath $config.SharedDataRoot $config.DeploymentRoot 'SharedDataRoot' }
    $runtimeParent = Join-Path $config.DeploymentRoot 'runtime'
    if (-not $config.RuntimePath.StartsWith($runtimeParent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RuntimePath must be below DeploymentRoot/runtime.' }
    foreach ($path in @($config.ProjectRoot, $config.SharedDataRoot)) {
        if (-not $path) { continue }
        foreach ($folder in @('portal', 'apps', 'proxy')) {
            $webRoot = Join-Path $config.DeploymentRoot $folder
            if ($path -eq $webRoot -or $path.StartsWith($webRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'QuickLook project and shared data must stay outside web roots.' }
        }
    }
    foreach ($path in @($config.DeploymentRoot, $config.ProjectRoot, $config.RuntimePath, $config.SharedDataRoot)) {
        if ($path) { Assert-QuicklookExistingAncestor -Path $path }
    }
    $config | Add-Member -NotePropertyName ConfigPath -NotePropertyValue $configPath
    $config | Add-Member -NotePropertyName BackendPort -NotePropertyValue 8765
    $config | Add-Member -NotePropertyName LogDirectory -NotePropertyValue (Join-Path $config.DeploymentRoot 'logs\quicklook')
    $config | Add-Member -NotePropertyName PythonPath -NotePropertyValue (Join-Path $config.RuntimePath 'Scripts\python.exe')
    return $config
}

function Assert-QuicklookProject {
    param([Parameter(Mandatory = $true)][object]$Config)
    foreach ($relative in @('server.py', 'warehouse.py', 'source_paths.py', 'requirements.txt', 'web\index.html')) {
        $path = Join-Path $Config.ProjectRoot $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Independent QuickLook project input is missing: $path" }
        Assert-NoReparsePoint -Path $path
    }
    # The application owns output_file and any saved workspace.json. Never seed,
    # migrate, replace, or rewrite its business data from the portal launcher.
    foreach ($relative in @('output_file', 'output_file\workspace.json', 'output_file\warehouse.db', 'output_file\recognition.json')) {
        Assert-QuicklookExistingAncestor -Path (Join-Path $Config.ProjectRoot $relative)
    }
}

function Assert-QuicklookWheels {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-NoReparsePoint -Path $Path
    $manifest = Join-Path $Path 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Missing offline wheel checksum manifest: $manifest" }
    Assert-NoReparsePoint -Path $manifest
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath $manifest -Encoding UTF8) {
        if ($line -notmatch '^([a-fA-F0-9]{64})  ([A-Za-z0-9_.-]+\.whl)$') { throw 'Invalid QuickLook SHA256SUMS line.' }
        if ($expected.ContainsKey($matches[2])) { throw 'Duplicate QuickLook wheel checksum entry.' }
        $expected[$matches[2]] = $matches[1].ToLowerInvariant()
    }
    if (-not $expected.Count) { throw 'QuickLook offline wheel checksum manifest is empty.' }
    foreach ($wheel in Get-ChildItem -LiteralPath $Path -File -Filter '*.whl') {
        if (-not $expected.ContainsKey($wheel.Name)) { throw "Undeclared offline QuickLook wheel: $($wheel.Name)" }
    }
    foreach ($name in $expected.Keys) {
        $wheel = Join-Path $Path $name
        if (-not (Test-Path -LiteralPath $wheel -PathType Leaf)) { throw "Missing offline QuickLook wheel: $name" }
        Assert-NoReparsePoint -Path $wheel
        if ((Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$name]) { throw "QuickLook wheel checksum mismatch: $name" }
    }
}
