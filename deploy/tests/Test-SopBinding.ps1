#requires -Version 5.1
[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
. (Join-Path $deploy 'Sop.Common.ps1')
$project=Split-Path -Parent $deploy
$scratch=Join-Path $project ('artifacts/sop-binding-test-'+[guid]::NewGuid().ToString('N'))
$machine=Join-Path $scratch 'machine'
$installed=Join-Path $scratch 'installed'
New-Item -ItemType Directory -Path $machine -Force|Out-Null
$configPath=Join-Path $machine 'deployment.json'
$script:checks=0
function Check([bool]$Value,[string]$Message){$script:checks++;if(-not $Value){throw $Message}}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected a safe rejection.'}
function Save($Value){Write-SopJson $configPath $Value}
function Original {
    return [pscustomobject]@{deploymentRoot='../installed';siteName='BindingFixture';publicOrigin='http://intranet.test:8088';sharedDirectory='shared';serviceAccount='MACHINE\Fixture';applications=[pscustomobject]@{sop=[pscustomobject]@{kind='service';arguments=@('-B','{payload}/server.py','--gateway-config','{deployment}/config/sop.json');dataDirectory='data/sop';port=18877;backendHealthPath='/sop/api/health';proxyMode='existing';secretEnvironmentFiles=[pscustomobject]@{SOP_PROXY_SECRET='config/sop-proxy.secret'};gatewayPaths=[pscustomobject]@{source_dir='{shared}/orders';shared_config='{deployment}/config/shared_config.py';plan_file='{shared}/plans/plan.xlsx'}}}}
}
function PutProxy([int]$Port) {
    $path=Join-Path $installed 'proxy/sop/web.config'
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force|Out-Null
    $auth=[Security.SecurityElement]::Escape((Join-Path $installed 'config/sop-auth.json'))
    [IO.File]::WriteAllText($path,('<configuration><appSettings><add key="SopIdentityBridgeOwner" value="DataPlatform-SOP-v1"/><add key="SopProxyConfigPath" value="'+$auth+'"/></appSettings><system.webServer><rewrite><rules><rule><action type="Rewrite" url="http://127.0.0.1:'+$Port+'/sop/{R:1}"/></rule></rules></rewrite></system.webServer></configuration>'),(New-Object Text.UTF8Encoding($false)))
}
$config=Original
Save $config
$binding=Read-SopDeploymentBinding -Path $configPath
Check ($binding.Config.BackendPort -eq 18877) 'Proxy port did not come from unified binding.'
Check ($binding.Config.PublicOrigin -ceq $config.publicOrigin) 'Public origin was not shared.'
Check ($binding.ServiceAccount -ceq $config.serviceAccount) 'Service account was not inherited.'
Check ($binding.Config.ProxySecretPath -ieq (Join-Path $installed 'config/sop-proxy.secret')) 'Secret path did not come from runtime binding.'
Check ($binding.Gateway.data_dir -ieq (Join-Path $installed 'data/sop')) 'Gateway and runtime data diverged.'
Check ($binding.Gateway.source_dir -ieq (Join-Path $installed 'shared/orders')) 'Shared source token did not resolve.'
Check ($binding.Gateway.shared_config -ieq (Join-Path $installed 'config/shared_config.py')) 'Explicit rules path did not resolve.'
$plan=& (Join-Path $deploy 'Configure-SopProxy.ps1') -DeploymentConfigPath $configPath -PlanOnly
Check (($plan -join "`n") -match 'Offline plan validated') 'Unified offline plan failed.'
Check (($plan -join "`n") -match 'Service account: MACHINE') 'Offline plan omitted the service identity.'
Check (($plan -join "`n") -match 'Persistent SOP data:') 'Offline plan omitted actual business paths.'
Check (-not(Test-Path -LiteralPath $installed)) 'Plan mode created a deployment or data directory.'
Reject {Read-SopDeploymentBinding -Path $configPath -ServiceAccount 'MACHINE\Other'}
Reject {& (Join-Path $deploy 'Configure-SopProxy.ps1') -DeploymentConfigPath $configPath -ConfigPath (Join-Path $deploy 'sop-iis.example.json') -PlanOnly}
Reject {Assert-SopRuntimeConsistency -Root $installed -Definition $binding.Definition -PublicOrigin $config.publicOrigin -RequireInitialized}

New-Item -ItemType Directory -Path (Join-Path $installed 'config') -Force|Out-Null
$gatewayPath=Join-Path $installed 'config/sop.json'
$authPath=Join-Path $installed 'config/sop-auth.json'
Write-SopJson $gatewayPath $binding.Gateway
Write-SopJson $authPath @{BackendPort=18877;PublicOrigin=$config.publicOrigin;ProxySecretPath=$binding.Config.ProxySecretPath;AllowWrites=$true}
PutProxy 18877
Assert-SopRuntimeConsistency -Root $installed -Definition $binding.Definition -PublicOrigin $config.publicOrigin -RequireInitialized
Check $true 'Initialized binding failed validation.'
$before=[IO.File]::ReadAllText($gatewayPath)
$config.applications.sop.port=18878
Save $config
$updated=Read-SopDeploymentBinding -Path $configPath
Check ($updated.Config.BackendPort -eq 18878) 'A changed canonical port could not be planned.'
$plan=& (Join-Path $deploy 'Configure-SopProxy.ps1') -DeploymentConfigPath $configPath -PlanOnly
Check (($plan -join "`n") -match 'will be regenerated on Apply: BackendPort') 'Plan did not describe derived identity drift.'
Reject {Assert-SopRuntimeConsistency -Root $installed -Definition $updated.Definition -PublicOrigin $config.publicOrigin -RequireInitialized}
Check ([IO.File]::ReadAllText($gatewayPath) -ceq $before) 'Plan rewrote an existing gateway.'

$config=Original
$config.publicOrigin='https://new.intranet.test'
Save $config
$updated=Read-SopDeploymentBinding -Path $configPath
Check ($updated.Config.PublicOrigin -ceq $config.publicOrigin) 'Origin change was not derived for Apply.'
Reject {Assert-SopRuntimeConsistency -Root $installed -Definition $updated.Definition -PublicOrigin $config.publicOrigin -RequireInitialized}
Check ([IO.File]::ReadAllText($gatewayPath) -ceq $before) 'Planning an origin change modified gateway data.'
$config=Original
$config.applications.sop.dataDirectory='data/other'
Save $config
Reject {Read-SopDeploymentBinding -Path $configPath}
Check ([IO.File]::ReadAllText($gatewayPath) -ceq $before) 'Data mismatch modified the existing path.'
$config=Original
$config.applications.sop.gatewayPaths.source_dir='{shared}/different'
Save $config
Reject {Read-SopDeploymentBinding -Path $configPath}
$config=Original
$config.applications.sop.arguments=@('-B','{payload}/server.py','--gateway-config','{deployment}/config/other.json')
Save $config
Reject {Read-SopDeploymentBinding -Path $configPath}
$config=Original
$config.applications.sop.arguments+=@('--gateway-config','{deployment}/config/sop.json')
Save $config
Reject {Read-SopDeploymentBinding -Path $configPath}
$config=Original
$config.applications.sop.secretEnvironmentFiles.SOP_PROXY_SECRET='config/other.secret'
Save $config
Reject {Read-SopDeploymentBinding -Path $configPath}
Check (-not(Test-Path -LiteralPath (Join-Path $installed 'config/other.secret'))) 'Planning silently rotated a key.'
$config=Original
Save $config
$binding=Read-SopDeploymentBinding -Path $configPath
PutProxy 18879
Reject {Assert-SopRuntimeConsistency -Root $installed -Definition $binding.Definition -PublicOrigin $config.publicOrigin -RequireInitialized}
PutProxy 18877

# Historical gateway business paths remain authoritative unless explicitly configured.
$legacy=Get-Content -LiteralPath $gatewayPath -Raw -Encoding UTF8|ConvertFrom-Json
$legacy.source_dir=Join-Path $installed 'legacy-sources'
Write-SopJson $gatewayPath $legacy
$config.applications.sop.PSObject.Properties.Remove('gatewayPaths')
Save $config
$binding=Read-SopDeploymentBinding -Path $configPath
Check ($binding.Gateway.source_dir -ieq $legacy.source_dir) 'Legacy custom source was silently replaced.'
$legacy.allow_writes=$false
Write-SopJson $gatewayPath $legacy
Write-SopJson $authPath @{BackendPort=18877;PublicOrigin=$config.publicOrigin;ProxySecretPath=$binding.Config.ProxySecretPath;AllowWrites=$false}
$binding=Read-SopDeploymentBinding -Path $configPath
Check (-not $binding.Config.AllowWrites) 'An existing maintenance pause was silently lifted.'
Assert-SopRuntimeConsistency -Root $installed -Definition $binding.Definition -PublicOrigin $config.publicOrigin -RequireInitialized
Check $true 'Consistent maintenance configuration was rejected.'
$old=Read-SopIisConfig -Path (Join-Path $deploy 'sop-iis.example.json')
Check ($old.BackendPort -eq 8877) 'Compatibility template has a conflicting default port.'
Write-Output "SOP unified binding fixtures passed: $script:checks checks. No IIS, service, task, ACL or business data was changed. Evidence: $scratch"
