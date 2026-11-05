#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $deploy
. (Join-Path $deploy 'Quicklook.Common.ps1')
. (Join-Path $deploy 'Quicklook.Proxy.ps1')
$scratch = Join-Path $project ('artifacts\quicklook-deployment-' + [Guid]::NewGuid().ToString('N'))
$release = Join-Path $scratch 'release'
$external = Join-Path $scratch 'quicklook-project'
$utf8 = New-Object Text.UTF8Encoding($false)
$script:checks = 0
function Assert-True { param([bool]$Value, [string]$Message); $script:checks++; if (-not $Value) { throw $Message } }
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message)
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected $Message
}
function Save-Json {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 15), $utf8)
}
New-Item -ItemType Directory -Force -Path (Join-Path $release 'config'), (Join-Path $release 'portal'), (Join-Path $external 'web'), (Join-Path $scratch 'shared-data') | Out-Null
try {
    $configPath = Join-Path $release 'config\quicklook.json'
    $raw = Get-Content -LiteralPath (Join-Path $deploy 'quicklook.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $raw.ProjectRoot = '../quicklook-project'
    $raw.SharedDataRoot = '../shared-data'
    Save-Json $configPath $raw
    $config = Read-QuicklookConfig -Path $configPath
    Assert-True ($config.DeploymentRoot -eq $release) 'DeploymentRoot must resolve relative to the configuration file.'
    Assert-True ($config.ProjectRoot -eq $external) 'ProjectRoot must resolve relative to DeploymentRoot.'
    Assert-True ($config.BackendPort -eq 8765) 'The existing child service must retain its fixed loopback port.'
    foreach ($value in @('portal/quicklook', 'apps/quicklook', 'proxy/quicklook', '\\server\share\quicklook', 'C:relative')) {
        $bad = $raw | ConvertTo-Json | ConvertFrom-Json
        $bad.ProjectRoot = $value
        Save-Json (Join-Path $release 'config\bad.json') $bad
        Assert-Rejected { Read-QuicklookConfig -Path (Join-Path $release 'config\bad.json') } "Unsafe project location accepted: $value"
    }
    $proxyPath = Join-Path $release 'config\quicklook-iis.json'
    $proxyRaw = Get-Content -LiteralPath (Join-Path $deploy 'quicklook-iis.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Save-Json $proxyPath $proxyRaw
    $proxy = Read-QuicklookIisConfig -Path $proxyPath
    $http = [Uri]$proxy.PublicOrigin
    $bad = $proxyRaw | ConvertTo-Json | ConvertFrom-Json
    $bad.PublicOrigin = 'https://data.example.internal'
    Save-Json (Join-Path $release 'config\bad-proxy.json') $bad
    Assert-Rejected { Read-QuicklookIisConfig -Path (Join-Path $release 'config\bad-proxy.json') } 'HTTPS writes cannot be supported by rewriting or dropping the original Origin header.'
    $document = New-Object Xml.XmlDocument
    $document.Load((Join-Path $deploy 'portal.web.config'))
    $original = $document.OuterXml
    $updated = New-QuicklookProxyWebConfig -Document $document -Config $proxy
    Assert-True ($document.OuterXml -eq $original) 'Proxy planning must not mutate its input document.'
    $rules = @($updated.SelectNodes('/configuration/location[@path="."]/system.webServer/rewrite/rules/rule'))
    Assert-True ($rules.Count -eq 3) 'Only the three owned prefix/API proxy rules should be installed.'
    $paths = @(Get-QuicklookRootApiPaths)
    Assert-True ($paths.Count -eq 11 -and $paths -contains '/api/import') 'The existing precise API allowlist must be complete.'
    $apiRule = @($rules | Where-Object { $_.match.url -match 'catalog' })
    Assert-True ($apiRule.Count -eq 1) 'Expected one exact API allowlist rewrite rule.'
    $pattern = [string]$apiRule[0].match.url
    foreach ($api in $paths) { Assert-True ($api.TrimStart('/') -cmatch $pattern) "Missing existing API: $api" }
    foreach ($api in @('api/portal/health', 'api/portal/stop', 'api/secret', 'api/import/extra', 'api/catalogue', 'api/catalog/')) {
        Assert-True ($api -cnotmatch $pattern) "Unregistered API was proxied: $api"
    }
    Assert-True (-not $updated.SelectNodes('//outboundRules|//serverVariables').Count) 'The portal must not rewrite responses or forge request headers.'
    Assert-True ($updated.SelectNodes('//customHeaders').OuterXml -eq $document.SelectNodes('//customHeaders').OuterXml) 'Child security response headers must not be altered.'
    $again = New-QuicklookProxyWebConfig -Document $updated -Config $proxy
    Assert-True ($again.OuterXml -eq $updated.OuterXml) 'Reapplying owned proxy configuration must be idempotent.'
    $foreign = New-Object Xml.XmlDocument
    $foreign.LoadXml('<configuration><location path="." inheritInChildApplications="false"><system.webServer><rewrite><rules><rule name="foreign"><match url=".*"/><action type="None"/></rule></rules></rewrite></system.webServer></location></configuration>')
    Assert-Rejected { New-QuicklookProxyWebConfig -Document $foreign -Config $proxy } 'Unknown existing rewrite rules must not be silently overwritten.'
    $proxyBefore = [IO.File]::ReadAllText($proxyPath)
    $plan = & (Join-Path $deploy 'Configure-QuicklookProxy.ps1') -ConfigPath $proxyPath -PlanOnly
    Assert-True ([IO.File]::ReadAllText($proxyPath) -eq $proxyBefore) 'Offline IIS planning changed the configuration.'
    $requirements = Join-Path $external 'requirements.txt'
    [IO.File]::WriteAllText($requirements, "openpyxl==3.1.5`n", $utf8)
    foreach ($relative in @('server.py', 'warehouse.py', 'source_paths.py', 'web\index.html')) {
        [IO.File]::WriteAllText((Join-Path $external $relative), 'deployment test fixture', $utf8)
    }
    $wheelRoot = Join-Path $release 'offline\quicklook-wheels'
    New-Item -ItemType Directory -Force -Path $wheelRoot | Out-Null
    $wheel = Join-Path $wheelRoot 'fixture-1.0-py3-none-any.whl'
    [IO.File]::WriteAllText($wheel, 'not installed by this offline test', $utf8)
    $digest = (Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestPath = Join-Path $wheelRoot 'SHA256SUMS'
    [IO.File]::WriteAllText($manifestPath, ($digest + '  fixture-1.0-py3-none-any.whl'), $utf8)
    Assert-QuicklookWheels -Path $wheelRoot
    & (Join-Path $deploy 'Install-QuicklookDependencies.ps1') -ConfigPath $configPath -PythonPath 'intentionally-not-a-python' -WhatIf | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $config.RuntimePath)) 'Dependency WhatIf must not create an environment or invoke Python.'
    [IO.File]::AppendAllText($wheel, 'tamper')
    Assert-Rejected { Assert-QuicklookWheels -Path $wheelRoot } 'A tampered wheel must be rejected before creating any runtime.'
    [IO.File]::WriteAllText($wheel, 'not installed by this offline test', $utf8)
    $extraWheel = Join-Path $wheelRoot 'unlisted-1.0-py3-none-any.whl'
    [IO.File]::WriteAllText($extraWheel, 'extra', $utf8)
    Assert-Rejected { Assert-QuicklookWheels -Path $wheelRoot } 'Unlisted wheel dependencies must be rejected.'
    Remove-Item -LiteralPath $extraWheel
    $launcherDirectory = Join-Path $release 'deploy'
    New-Item -ItemType Directory -Force -Path $launcherDirectory | Out-Null
    [IO.File]::WriteAllText((Join-Path $launcherDirectory 'Start-QuicklookService.ps1'), '# fixture; never invoked', $utf8)
    $taskPlan = & (Join-Path $deploy 'Register-QuicklookTask.ps1') -ConfigPath $configPath -ServiceAccount 'DOMAIN\deployment-fixture'
    Assert-True (($taskPlan -join "`n") -match 'Plan only') 'Default task registration must remain a plan and avoid scheduler APIs.'
    Assert-Rejected { & (Join-Path $deploy 'Register-QuicklookTask.ps1') -ConfigPath $configPath -ServiceAccount 'NT AUTHORITY\SYSTEM' } 'Built-in privileged task identities must be rejected.'
    $wheelDestination = Join-Path $scratch 'wheel-plan'
    & (Join-Path $deploy 'New-OfflineWheelhouse.ps1') -RequirementsPath $requirements -Destination $wheelDestination -PythonPath 'intentionally-not-a-python' -WhatIf | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $wheelDestination)) 'Wheelhouse WhatIf must not create directories or run Python.'
    Assert-Rejected { & (Join-Path $deploy 'New-OfflineWheelhouse.ps1') -RequirementsPath $requirements -Destination $external -WhatIf } 'Existing wheel destinations must not be mixed or overwritten.'
    $packConfig = Get-Content -LiteralPath (Join-Path $deploy 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $packConfig.StaticApplications = @()
    $packConfigPath = Join-Path $scratch 'package-config.json'
    Save-Json $packConfigPath $packConfig
    $package = Join-Path $scratch 'package'
    & (Join-Path $deploy 'New-DeploymentPackage.ps1') -ConfigPath $packConfigPath -Destination $package | Out-Null
    foreach ($name in @('quicklook.example.json', 'quicklook-iis.example.json')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $package ('config\' + $name)) -PathType Leaf) "Missing packaged server template: $name"
    }
    foreach ($name in @('Configure-QuicklookProxy.ps1', 'Install-QuicklookDependencies.ps1', 'Register-QuicklookTask.ps1', 'Start-QuicklookService.ps1', 'New-OfflineWheelhouse.ps1')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $package ('deploy\' + $name)) -PathType Leaf) "Missing packaged deployment tool: $name"
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $package 'services\quicklook'))) 'Independent child source must not be copied into the portal package.'
    Write-Output "Quicklook deployment checks passed: $script:checks assertions. No IIS, scheduled tasks, Python environments or business data were changed."
} finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $prefix = [IO.Path]::GetFullPath((Join-Path $project 'artifacts')).TrimEnd('\') + '\quicklook-deployment-'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
