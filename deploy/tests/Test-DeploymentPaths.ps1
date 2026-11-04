#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
# Loading SOP helpers alone must also make the shared path resolver available.
. (Join-Path $deploy 'Sop.Common.ps1')
$artifacts = Join-Path (Split-Path -Parent $deploy) 'artifacts'
$scratch = Join-Path $artifacts ('deployment-paths-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$previousLocation = Get-Location
$previousDirectory = [Environment]::CurrentDirectory
$script:cases = 0
$script:assertions = 0

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    $script:assertions++
    if ($Actual -ne $Expected) { throw "$Message`nExpected: $Expected`nActual: $Actual" }
}
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message)
    $script:assertions++
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw $Message }
}
function Test-Case {
    param([string]$Name, [scriptblock]$Action)
    & $Action
    $script:cases++
    Write-Output "PASS: $Name"
}
function Read-Json {
    param([string]$Path)
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Save-Fixture {
    param([string]$Path, [object]$Value)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Write-SopJson -Path $Path -Value $Value
}

try {
    $null = Get-Command Resolve-LocalDeploymentPath -ErrorAction Stop
    $releaseA = Join-Path $scratch 'release-a'
    $releaseB = Join-Path $scratch 'release-b'
    $elsewhere = Join-Path $scratch 'different-working-directory'
    New-Item -ItemType Directory -Path $elsewhere | Out-Null
    Set-Location -LiteralPath $elsewhere
    [Environment]::CurrentDirectory = $elsewhere

    $deploymentPath = Join-Path $releaseA 'deploy\config.json'
    $deployment = Read-Json (Join-Path $deploy 'config.example.json')
    $deployment.DeploymentRoot = '..'
    Save-Fixture $deploymentPath $deployment
    $iisPath = Join-Path $releaseA 'deploy\sop-iis.json'
    $iis = Read-Json (Join-Path $deploy 'sop-iis.example.json')
    $iis.DeploymentRoot = '..'
    $iis.ProxySecretPath = 'config/sop-proxy.secret'
    Save-Fixture $iisPath $iis
    $gatewayPath = Join-Path $releaseA 'deploy\sop.json'
    $gateway = Read-Json (Join-Path $deploy 'sop.example.json')
    $gateway.data_dir = 'data/sop'
    $gateway.source_dir = 'data/sop/input_file'
    $gateway.shared_config = 'config/shared_config.py'
    $gateway.plan_file = 'data/sop/plan.xlsx'
    Save-Fixture $gatewayPath $gateway
    $gatewayFields = @('data_dir', 'source_dir', 'shared_config', 'plan_file')
    $unsafePaths = @('C:relative', '\root-relative', '/root-relative', '\\server\share\site', '//server/share/site', [IO.Path]::GetPathRoot($scratch))

    Test-Case 'Relative and absolute local paths are independent of the process working directory' {
        Assert-Equal (Resolve-LocalDeploymentPath -Value 'data/sop' -BasePath $releaseA -Name 'fixture') (Join-Path $releaseA 'data\sop') 'Relative path used the current directory.'
        $absolute = Join-Path $scratch 'absolute-storage'
        Assert-Equal (Resolve-LocalDeploymentPath -Value $absolute -BasePath $releaseA -Name 'fixture') $absolute 'Absolute local paths must remain compatible.'
    }
    Test-Case 'Ambiguous and nonlocal Windows path forms are rejected' {
        foreach ($value in $unsafePaths) {
            Assert-Rejected { Resolve-LocalDeploymentPath -Value $value -BasePath $releaseA -Name 'fixture' } "Unsafe local path accepted: $value"
        }
    }
    Test-Case 'DeploymentRoot resolves beside its config and follows a copied config' {
        Assert-Equal (Read-DeploymentConfig -Path $deploymentPath).DeploymentRoot $releaseA 'DeploymentRoot was not based on its config directory.'
        $copied = Join-Path $releaseB 'deploy\config.json'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copied) | Out-Null
        Copy-Item -LiteralPath $deploymentPath -Destination $copied
        Assert-Equal (Read-DeploymentConfig -Path $copied).DeploymentRoot $releaseB 'Copied relative config remained bound to the old release.'
        $absolute = Read-Json $deploymentPath
        $absolute.DeploymentRoot = Join-Path $scratch 'explicit-release'
        $path = Join-Path $scratch 'absolute-deployment.json'
        Save-Fixture $path $absolute
        Assert-Equal (Read-DeploymentConfig -Path $path).DeploymentRoot $absolute.DeploymentRoot 'Absolute DeploymentRoot changed.'
    }
    Test-Case 'Both deployment readers reject unsafe DeploymentRoot values' {
        foreach ($value in $unsafePaths) {
            $candidate = Read-Json $deploymentPath
            $candidate.DeploymentRoot = $value
            $path = Join-Path $scratch 'unsafe-deployment.json'
            Save-Fixture $path $candidate
            Assert-Rejected { Read-DeploymentConfig -Path $path } "Unsafe DeploymentRoot accepted: $value"
            $candidate = Read-Json $iisPath
            $candidate.DeploymentRoot = $value
            $path = Join-Path $scratch 'unsafe-iis.json'
            Save-Fixture $path $candidate
            Assert-Rejected { Read-SopIisConfig -Path $path } "Unsafe SOP DeploymentRoot accepted: $value"
        }
    }
    Test-Case 'SOP secret paths resolve from DeploymentRoot and follow a copied config' {
        $resolved = Read-SopIisConfig -Path $iisPath
        Assert-Equal $resolved.DeploymentRoot $releaseA 'SOP DeploymentRoot used the wrong base.'
        Assert-Equal $resolved.ProxySecretPath (Join-Path $releaseA 'config\sop-proxy.secret') 'Proxy secret was not based on the deployment root.'
        $copied = Join-Path $releaseB 'deploy\sop-iis.json'
        Copy-Item -LiteralPath $iisPath -Destination $copied
        Assert-Equal (Read-SopIisConfig -Path $copied).ProxySecretPath (Join-Path $releaseB 'config\sop-proxy.secret') 'Copied secret config retained the old release.'
        $absolute = Read-Json $iisPath
        $absolute.DeploymentRoot = $releaseA
        $absolute.ProxySecretPath = Join-Path $releaseA 'config\absolute.secret'
        $path = Join-Path $scratch 'absolute-iis.json'
        Save-Fixture $path $absolute
        Assert-Equal (Read-SopIisConfig -Path $path).ProxySecretPath $absolute.ProxySecretPath 'Absolute secret path changed.'
    }
    Test-Case 'Secret traversal and config-directory prefix lookalikes are rejected' {
        $values = @('../outside.secret', 'config/../portal/secret', 'config/../../outside.secret', 'config-extra/secret', 'config', (Join-Path $releaseA 'config-extra\secret'), ($releaseA + '-other\config\secret')) + $unsafePaths
        foreach ($value in $values) {
            $candidate = Read-Json $iisPath
            $candidate.DeploymentRoot = $releaseA
            $candidate.ProxySecretPath = $value
            $path = Join-Path $scratch 'unsafe-secret.json'
            Save-Fixture $path $candidate
            Assert-Rejected { Read-SopIisConfig -Path $path } "Secret escaped the config subtree: $value"
        }
    }
    Test-Case 'Gateway relative paths become absolute without rewriting the template' {
        $before = [IO.File]::ReadAllText($gatewayPath)
        $resolved = Resolve-SopGatewayTemplate -Path $gatewayPath -DeploymentRoot $releaseA
        foreach ($name in $gatewayFields) {
            Assert-Equal $resolved.$name ([IO.Path]::GetFullPath((Join-Path $releaseA $gateway.$name))) "Gateway field resolved from the wrong base: $name"
        }
        Assert-Equal $resolved.base_path $gateway.base_path 'Gateway URL prefix changed.'
        Assert-Equal $resolved.allow_writes $gateway.allow_writes 'Gateway write setting changed.'
        Assert-Equal ([IO.File]::ReadAllText($gatewayPath)) $before 'Resolving a template must not rewrite it.'
    }
    Test-Case 'Gateway templates follow the selected release after copying' {
        $copied = Join-Path $releaseB 'deploy\sop.json'
        Copy-Item -LiteralPath $gatewayPath -Destination $copied
        $resolved = Resolve-SopGatewayTemplate -Path $copied -DeploymentRoot $releaseB
        foreach ($name in $gatewayFields) {
            Assert-Equal $resolved.$name ([IO.Path]::GetFullPath((Join-Path $releaseB $gateway.$name))) "Copied gateway path retained the old release: $name"
        }
    }
    Test-Case 'Explicit absolute gateway storage paths remain compatible' {
        $candidate = Read-Json $gatewayPath
        foreach ($name in $gatewayFields) { $candidate.$name = Join-Path $scratch ('external-storage\' + $name) }
        $path = Join-Path $scratch 'absolute-gateway.json'
        Save-Fixture $path $candidate
        $resolved = Resolve-SopGatewayTemplate -Path $path -DeploymentRoot $releaseA
        foreach ($name in $gatewayFields) { Assert-Equal $resolved.$name $candidate.$name "Absolute gateway path changed: $name" }
    }
    Test-Case 'Every gateway field rejects relative escape and ambiguous Windows forms' {
        foreach ($name in $gatewayFields) {
            foreach ($value in (@('../outside', '../release-a-other/storage') + $unsafePaths)) {
                $candidate = Read-Json $gatewayPath
                $candidate.$name = $value
                $path = Join-Path $scratch 'unsafe-gateway.json'
                Save-Fixture $path $candidate
                Assert-Rejected { Resolve-SopGatewayTemplate -Path $path -DeploymentRoot $releaseA } "Unsafe gateway path accepted: $name = $value"
            }
        }
    }
    Test-Case 'Relative and absolute gateway paths cannot enter any published web tree' {
        foreach ($name in $gatewayFields) {
            foreach ($web in @('portal', 'apps', 'proxy')) {
                foreach ($value in @($web, ($web + '/private'), (Join-Path $releaseA $web), (Join-Path $releaseA ($web + '\private')))) {
                    $candidate = Read-Json $gatewayPath
                    $candidate.$name = $value
                    $path = Join-Path $scratch 'public-gateway.json'
                    Save-Fixture $path $candidate
                    Assert-Rejected { Resolve-SopGatewayTemplate -Path $path -DeploymentRoot $releaseA } "Gateway storage entered a web tree: $name = $value"
                }
            }
        }
    }
    Test-Case 'Web-directory checks do not reject private sibling prefixes' {
        foreach ($prefix in @('portal-private', 'apps-private', 'proxy-private')) {
            $candidate = Read-Json $gatewayPath
            $candidate.data_dir = $prefix + '/data'
            $path = Join-Path $scratch 'private-prefix-gateway.json'
            Save-Fixture $path $candidate
            $resolved = Resolve-SopGatewayTemplate -Path $path -DeploymentRoot $releaseA
            Assert-Equal $resolved.data_dir (Join-Path $releaseA ($prefix + '\data')) 'A private sibling was confused with a published web directory.'
        }
    }
    Write-Output "Deployment path checks passed: $script:cases cases, $script:assertions assertions. No IIS, tasks, services or application builds were used."
}
finally {
    Set-Location -LiteralPath $previousLocation.Path
    [Environment]::CurrentDirectory = $previousDirectory
    $resolved = [IO.Path]::GetFullPath($scratch).TrimEnd('\')
    $expectedParent = [IO.Path]::GetFullPath($artifacts).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -ne $expectedParent -or (Split-Path -Leaf $resolved) -notlike 'deployment-paths-*') { throw 'Refusing unexpected test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
