#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$project=Split-Path -Parent $deploy
. (Join-Path $deploy 'Runtime.Release.ps1')
$scratch=Join-Path $project ('artifacts\runtime-release-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$script:checks=0
function Check([bool]$Result,[string]$Message){$script:checks++;if(-not $Result){throw $Message}}
function Reject([scriptblock]$Action){$rejected=$false;try{& $Action | Out-Null}catch{$rejected=$true};Check $rejected 'Expected validation rejection.'}
function Put([string]$Path,[string]$Text){New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force|Out-Null;[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
$payload=Join-Path $scratch 'source'
Put (Join-Path $payload 'index.html') '<title>Runtime fixture</title>'
$release=Join-Path $scratch 'alpha-v1'
& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $payload -Destination $release -AppId alpha -Version v1 -Type static -EntryPoint index.html -SourceRevision fixture -DataMode stateless | Out-Null
$configPath=Join-Path $scratch 'machine\deployment.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $configPath)|Out-Null
$config=[pscustomobject]@{deploymentRoot='../installed';siteName='Fixture';applications=[pscustomobject]@{alpha=[pscustomobject]@{kind='static';healthUrl='http://localhost:8080/alpha/'}}}
Write-AppReleaseJson $configPath $config
$plan=Read-InstallPlan $release $configPath
Check ($plan.Root -eq (Join-Path $scratch 'installed')) 'Config-relative root is wrong.'
Check ($plan.Destination -eq (Join-Path $scratch 'installed\releases\alpha\v1')) 'Unexpected version location.'
$before=Get-FileHash -LiteralPath (Join-Path $release 'payload\index.html')
& (Join-Path $deploy 'Install-AppVersion.ps1') -ReleasePath $release -ConfigPath $configPath -PlanOnly | Out-Null
Check (-not(Test-Path -LiteralPath $plan.Root)) 'Plan mode mutated deployment root.'
Check ((Get-FileHash -LiteralPath (Join-Path $release 'payload\index.html')).Hash -eq $before.Hash) 'Plan mode changed release.'
Reject { & (Join-Path $deploy 'Install-AppVersion.ps1') -ReleasePath $release -ConfigPath $configPath -Apply -PlanOnly }
$config.applications.alpha.kind='service';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $release $configPath}
$config.applications.alpha.kind='static';$config.applications.alpha.healthUrl='http://localhost:8080/other/';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $release $configPath}
$config.applications.alpha.healthUrl='http://localhost:8080/alpha/';$config.deploymentRoot='C:';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $release $configPath}
$config.deploymentRoot='../installed';Write-AppReleaseJson $configPath $config
Put (Join-Path $release 'payload\index.html') 'changed';Reject {Read-InstallPlan $release $configPath}
Put (Join-Path $release 'payload\index.html') '<title>Runtime fixture</title>'
# Failure recovery selects the last successful version, including a failed first attempt at v2.
New-Item -ItemType Directory -Path $plan.StateRoot -Force|Out-Null
Write-AppReleaseJson (Join-Path $plan.StateRoot 'deployment.json') @{version='v1';previous=$null}
Write-AppReleaseJson (Join-Path $plan.StateRoot 'failure.json') @{resolved=$false;failedVersion='v2';recoverVersion='v1'}
Reject { & (Join-Path $deploy 'Install-AppVersion.ps1') -ReleasePath $release -ConfigPath $configPath -Rollback -PlanOnly }
& (Join-Path $deploy 'Install-AppVersion.ps1') -ReleasePath $release -ConfigPath $configPath -Rollback -DataCompatible -PlanOnly | Out-Null
Check $true 'Failure recovery target accepted.'
# Service fixture uses only a temporary external data folder and a benign script.
$servicePayload=Join-Path $scratch 'service-source'
Put (Join-Path $servicePayload 'server.ps1') 'param([string]$Data); [IO.File]::WriteAllText((Join-Path $Data "result.txt"),$env:PLANHUB_TEST_DATA); exit 0'
$serviceRelease=Join-Path $scratch 'beta-v1'
& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $servicePayload -Destination $serviceRelease -AppId beta -Version v1 -Type service -EntryPoint server.ps1 -SourceRevision fixture -DataMode external -HealthPath /healthz | Out-Null
$data=Join-Path $plan.Root 'data\beta';New-Item -ItemType Directory -Path $data -Force|Out-Null
$shell=Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$definition=[pscustomobject]@{kind='service';healthUrl='http://localhost:8080/beta/';command=$shell;arguments=@('-NoProfile','-File','{payload}/server.ps1','-Data','{data}');environment=[pscustomobject]@{PLANHUB_TEST_DATA='{data}'};dataDirectory='data/beta';port=18888;taskName='PlanHub-fixture';serviceAccount='MACHINE\Fixture';backendHealthPath='/healthz';proxyMode='prefix';healthExpected=[pscustomobject]@{}}
$config.applications | Add-Member -NotePropertyName beta -NotePropertyValue $definition
Write-AppReleaseJson $configPath $config
$servicePlan=Read-InstallPlan $serviceRelease $configPath
Check ($servicePlan.Kind -eq 'service') 'Service validation failed.'
foreach($folder in @('portal','apps','proxy','releases')){
    $privateCandidate=Join-Path $plan.Root ($folder+'\private')
    New-Item -ItemType Directory -Path $privateCandidate -Force|Out-Null
    $definition.dataDirectory=$folder+'/private';Write-AppReleaseJson $configPath $config
    Reject {Read-InstallPlan $serviceRelease $configPath}
    $definition.dataDirectory='data/beta'
    $candidateCommand=Join-Path $privateCandidate 'runtime.exe';Put $candidateCommand 'never executed'
    $definition.command=$candidateCommand;Write-AppReleaseJson $configPath $config
    Reject {Read-InstallPlan $serviceRelease $configPath}
    $definition.command=$shell
    $candidateSecret=Join-Path $privateCandidate 'fixture-secret.txt';Put $candidateSecret 'fixture-not-a-real-secret'
    $definition | Add-Member -NotePropertyName secretEnvironmentFiles -NotePropertyValue ([pscustomobject]@{FIXTURE_SECRET=$candidateSecret}) -Force
    Write-AppReleaseJson $configPath $config
    Reject {Read-InstallPlan $serviceRelease $configPath}
    $definition.PSObject.Properties.Remove('secretEnvironmentFiles')
}
$definition.dataDirectory='data/../PoRtAl/private';Write-AppReleaseJson $configPath $config
Reject {Read-InstallPlan $serviceRelease $configPath}
$definition.dataDirectory='portal./private';Write-AppReleaseJson $configPath $config
Reject {Read-InstallPlan $serviceRelease $configPath}
$allowedSibling=Join-Path $plan.Root 'portal-extra\private';New-Item -ItemType Directory -Path $allowedSibling -Force|Out-Null
$definition.dataDirectory=$allowedSibling;Write-AppReleaseJson $configPath $config
$null=Read-InstallPlan $serviceRelease $configPath;Check $true 'A private sibling prefix was incorrectly treated as a web directory.'
$definition.dataDirectory='releases/beta/v1';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath}
$definition.dataDirectory='proxy/beta';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath}
$definition.dataDirectory='data/beta';$definition.environment | Add-Member -NotePropertyName PATH -NotePropertyValue 'changed';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath};$definition.environment.PSObject.Properties.Remove('PATH')
Write-AppReleaseJson $configPath $config
Reject {Assert-OwnedTask ([pscustomobject]@{Description='unrelated'}) 'beta' $plan.Root}
Assert-OwnedTask ([pscustomobject]@{Description=('PlanHub managed beta '+$plan.Root)}) 'beta' $plan.Root;Check $true 'Owned task not accepted.'
# Capture bound task settings without contacting the system CIM provider. These
# regressions must also run under an ordinary A account without scheduler access.
function New-ScheduledTaskSettingsSet {
    param([string]$MultipleInstances,[TimeSpan]$ExecutionTimeLimit,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[int]$RestartCount,[TimeSpan]$RestartInterval)
    return [pscustomobject]$PSBoundParameters
}
$newSettings=New-ManagedServiceTaskSettings
Check ($newSettings.RestartCount -eq 3 -and $newSettings.RestartInterval -eq (New-TimeSpan -Minutes 1)) 'New tasks do not retry failures.'
Check ($newSettings.ExecutionTimeLimit -eq [TimeSpan]::Zero -and $newSettings.MultipleInstances -ceq 'IgnoreNew' -and $newSettings.StartWhenAvailable -and $newSettings.AllowStartIfOnBatteries -and $newSettings.DontStopIfGoingOnBatteries) 'Service lifetime, startup or battery policy changed.'
$script:taskUpdates=0
function Set-ScheduledTask {
    param($TaskName,$TaskPath,$Settings,$ErrorAction)
    $script:taskUpdates++
    Check ($TaskName -ceq 'PlanHub-fixture' -and $TaskPath -ceq '\') 'Unexpected task selected for retry update.'
    Check ($Settings.RestartCount -eq 3 -and $Settings.RestartInterval -eq 'PT1M') 'Retry policy was not passed to Task Scheduler.'
    Check ($Settings.Priority -eq 7 -and $Settings.ExecutionTimeLimit -eq 'PT0S') 'Other task settings were overwritten.'
}
$oldSettings=[pscustomobject]@{RestartCount=0;RestartInterval='';Priority=7;ExecutionTimeLimit='PT0S'}
$ownedTask=[pscustomobject]@{Description=('PlanHub managed beta '+$plan.Root);TaskName='PlanHub-fixture';TaskPath='\';Settings=$oldSettings;Principal='preserved-identity';Actions='preserved-action';Triggers='preserved-trigger'}
$unownedTask=[pscustomobject]@{Description='unrelated';Settings=$oldSettings}
Reject {Update-OwnedTaskRestartPolicy $unownedTask 'beta' $plan.Root}
Check ($script:taskUpdates -eq 0) 'Unrelated scheduled task was updated.'
Update-OwnedTaskRestartPolicy $ownedTask 'beta' $plan.Root
Check ($script:taskUpdates -eq 1) 'Existing owned task retry policy was not repaired.'
Check ($ownedTask.Principal -eq 'preserved-identity' -and $ownedTask.Actions -eq 'preserved-action' -and $ownedTask.Triggers -eq 'preserved-trigger') 'Task identity/action/trigger changed.'
Update-OwnedTaskRestartPolicy $ownedTask 'beta' $plan.Root
Check ($script:taskUpdates -eq 1) 'Applying the same retry policy was not idempotent.'
$runtime=[ordered]@{schemaVersion=1;appId='beta';version='v1';payload=(Join-Path $serviceRelease 'payload');root=$plan.Root;dataDirectory=$data;definition=$definition}
$runtimePath=Join-Path $scratch 'active.json';Write-AppReleaseJson $runtimePath $runtime
$original=[Environment]::GetEnvironmentVariable('PLANHUB_TEST_DATA','Process')
& (Join-Path $deploy 'Run-AppService.ps1') -RuntimeConfig $runtimePath
Check ([IO.File]::ReadAllText((Join-Path $data 'result.txt')) -eq $data) 'External data placeholder was not passed to service.'
Check ([Environment]::GetEnvironmentVariable('PLANHUB_TEST_DATA','Process') -eq $original) 'Launcher leaked process environment.'
$null=Assert-AppRelease $serviceRelease;Check $true 'Launcher modified version files.'
$atomic=Join-Path $scratch 'atomic.json';Write-AtomicJson $atomic @{version=1};Write-AtomicJson $atomic @{version=2};Check ((Get-Content -LiteralPath $atomic -Raw|ConvertFrom-Json).version -eq 2) 'Atomic state replacement failed.'
# Authenticated services are probed through IIS with the caller's Windows identity.
$script:usedPublicIdentity=$false
function Invoke-WebRequest {
    param($Uri,[switch]$UseBasicParsing,[switch]$UseDefaultCredentials,$TimeoutSec,$MaximumRedirection)
    $script:usedPublicIdentity=$UseDefaultCredentials.IsPresent -and ([string]$Uri -eq 'http://localhost:8080/sop/api/health')
    return [pscustomobject]@{StatusCode=200;Content='{"app_id":"hima-sop","launch_mode":"gateway"}'}
}
$probe=[pscustomobject]@{backendHealthMode='public';healthUrl='http://localhost:8080/sop/api/health';healthExpected=[pscustomobject]@{app_id='hima-sop';launch_mode='gateway'}}
Check (Test-BackendHealth $probe) 'SOP public health identity check failed.'
Check $script:usedPublicIdentity 'Public health bypassed IIS or omitted Windows identity.'
$probe.healthExpected.app_id='other-app';Check (-not(Test-BackendHealth $probe)) 'Unexpected application passed health verification.'
# Environment defaults generate all public addresses, prefixes and shared paths once.
$centralPath=Join-Path $scratch 'machine\single-source.json'
$central=[pscustomobject]@{
    deploymentRoot='../single-installed';siteName='Fixture';publicOrigin='https://department.example:9443';sharedDirectory='../business-shared';serviceAccount='MACHINE\Fixture'
    applications=[pscustomobject]@{
        planhub=[pscustomobject]@{kind='portal'}
        alpha=[pscustomobject]@{kind='static'}
        beta=[pscustomobject]@{kind='service';command=$shell;arguments=@('-NoProfile','-File','{payload}/server.ps1','-Data','{data}');environment=[pscustomobject]@{PLANHUB_TEST_DATA='{data}';PUBLIC_ORIGIN='{publicOrigin}';PUBLIC_HOST='{publicHost}';PUBLIC_PREFIX='{basePath}';SHARED_INPUT='{shared}';CUSTOM_TEXT='{business-owned}'};dataDirectory='data/beta';port=18889;taskName='PlanHub-fixture';backendHealthPath='/healthz';proxyMode='prefix';healthExpected=[pscustomobject]@{public_prefix='{basePath}'}}
    }
}
Write-AppReleaseJson $centralPath $central
$centralBefore=[IO.File]::ReadAllText($centralPath)
$resolved=Read-RuntimeSettings $centralPath
Check ($resolved.Root -eq (Join-Path $scratch 'single-installed')) 'Environment root used the process working directory.'
Check (-not(Test-Path -LiteralPath $resolved.Root)) 'Environment reader created deployment files.'
Check ($resolved.Config.applications.planhub.healthUrl -eq 'https://department.example:9443/') 'Portal health URL was not generated from public origin.'
Check ($resolved.Config.applications.alpha.healthUrl -eq 'https://department.example:9443/alpha/') 'Static health URL was not generated from base path.'
Check ($resolved.Config.applications.beta.healthUrl -eq 'https://department.example:9443/beta/healthz') 'Backend path was not mapped into the public prefix.'
Check ($resolved.Config.applications.beta.serviceAccount -eq 'MACHINE\Fixture') 'Service account default was not inherited.'
Check ($resolved.Config.applications.beta.environment.PUBLIC_HOST -eq 'department.example') 'Allowed public host was not derived from the origin.'
Check ($resolved.Config.applications.beta.environment.PUBLIC_PREFIX -eq '/beta/') 'Environment prefix was not derived from the application ID.'
Check ($resolved.Config.applications.beta.healthExpected.public_prefix -eq '/beta/') 'Health identity prefix was not expanded.'
Check ($resolved.SharedDirectory -eq (Join-Path $scratch 'business-shared')) 'Shared root was not resolved against the deployment root.'
Check ($resolved.Config.applications.beta.environment.SHARED_INPUT -eq $resolved.SharedDirectory) 'Service does not use the shared root.'
Check ($resolved.Config.applications.beta.environment.CUSTOM_TEXT -eq '{business-owned}') 'Application-owned braces were rewritten.'
Check ([IO.File]::ReadAllText($centralPath) -eq $centralBefore) 'Environment reader rewrote the machine configuration.'
# Relocating a portable config relocates its deployment and shared paths.
$copiedConfig=Join-Path $scratch 'moved\machine\single-source.json'
Put $copiedConfig $centralBefore
$copiedSettings=Read-RuntimeSettings $copiedConfig
Check ($copiedSettings.Root -eq (Join-Path $scratch 'moved\single-installed')) 'Copied deployment config retained its old machine directory.'
Check ($copiedSettings.SharedDirectory -eq (Join-Path $scratch 'moved\business-shared')) 'Copied shared config retained its old machine directory.'
# Explicit per-application settings remain usable; defaults are not destructive migrations.
$central.applications.beta | Add-Member -NotePropertyName serviceAccount -NotePropertyValue 'DOMAIN\Custom'
$central.applications.alpha | Add-Member -NotePropertyName healthUrl -NotePropertyValue 'https://alternate.example/alpha/'
Write-AppReleaseJson $centralPath $central
$resolved=Read-RuntimeSettings $centralPath
Check ($resolved.Config.applications.beta.serviceAccount -eq 'DOMAIN\Custom') 'Explicit service identity was overwritten.'
Check ($resolved.Config.applications.alpha.healthUrl -eq 'https://alternate.example/alpha/') 'Explicit health endpoint was overwritten.'
# A generated definition is accepted by the actual planning/runner path.
New-Item -ItemType Directory -Path (Join-Path $resolved.Root 'data\beta') -Force|Out-Null
$centralPlan=Read-InstallPlan $serviceRelease $centralPath
$centralRuntime=[ordered]@{schemaVersion=1;appId='beta';version='v1';payload=(Join-Path $serviceRelease 'payload');root=$resolved.Root;dataDirectory=(Join-Path $resolved.Root 'data\beta');definition=$centralPlan.Definition}
Write-AppReleaseJson $runtimePath $centralRuntime
& (Join-Path $deploy 'Run-AppService.ps1') -RuntimeConfig $runtimePath
Check ([IO.File]::ReadAllText((Join-Path $centralRuntime.dataDirectory 'result.txt')) -eq $centralRuntime.dataDirectory) 'Resolved environment definition failed through the actual runner.'
foreach($badOrigin in @('http://example.test/path','http://example.test/','http://user:password@example.test','ftp://example.test','https://example.test?secret=value','https://example.test#fragment','//example.test')){
    $bad=$centralBefore | ConvertFrom-Json;$bad.publicOrigin=$badOrigin;Write-AppReleaseJson $centralPath $bad
    Reject {Read-RuntimeSettings $centralPath}
}
foreach($badShared in @('\\server\share','C:relative','\relative','portal/private','apps/private','proxy/private','releases/private','{shared}/nested','{deployment}/shared')){
    $bad=$centralBefore | ConvertFrom-Json;$bad.sharedDirectory=$badShared;Write-AppReleaseJson $centralPath $bad
    Reject {Read-RuntimeSettings $centralPath}
}
foreach($badName in @('bad/name','with space','')){
    $bad=$centralBefore | ConvertFrom-Json;$bad.siteName=$badName;Write-AppReleaseJson $centralPath $bad
    Reject {Read-RuntimeSettings $centralPath}
}
$bad=$centralBefore | ConvertFrom-Json;$bad.PSObject.Properties.Remove('publicOrigin');Write-AppReleaseJson $centralPath $bad
Reject {Read-RuntimeSettings $centralPath}
# Legacy configurations with explicit addresses continue to parse without new global fields.
$legacy=Read-RuntimeSettings $configPath
Check ($legacy.Config.applications.alpha.healthUrl -eq 'http://localhost:8080/alpha/') 'Legacy explicit public address changed.'
Write-AppReleaseJson $centralPath ($centralBefore | ConvertFrom-Json)
# SOP planning and boot both validate the same initialized gateway before starting anything.
$sopPayload=Join-Path $scratch 'sop-source'
Put (Join-Path $sopPayload 'server.ps1') '[IO.File]::WriteAllText($env:RUN_MARKER,"must not start")'
$sopRelease=Join-Path $scratch 'sop-v1'
& (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $sopPayload -Destination $sopRelease -AppId sop -Version v1 -Type service -EntryPoint server.ps1 -SourceRevision fixture -DataMode external -HealthPath /api/health | Out-Null
$sopSettings=Read-RuntimeSettings $centralPath
$sopData=Join-Path $sopSettings.Root 'data\sop'
New-Item -ItemType Directory -Path $sopData -Force|Out-Null
$sopDefinition=[pscustomobject]@{kind='service';command=$shell;arguments=@('-NoProfile','-File','{payload}/server.ps1','--gateway-config','{deployment}/config/sop.json');environment=[pscustomobject]@{RUN_MARKER=(Join-Path $scratch 'sop-started.txt')};dataDirectory='data/sop';port=18890;taskName='PlanHub-sop-fixture';backendHealthPath='/sop/api/health';backendHealthMode='public';proxyMode='existing';secretEnvironmentFiles=[pscustomobject]@{SOP_PROXY_SECRET='config/sop-proxy.secret'}}
$central=$centralBefore|ConvertFrom-Json
$central.applications|Add-Member -NotePropertyName sop -NotePropertyValue $sopDefinition
Write-AppReleaseJson $centralPath $central
$sopGateway=[pscustomobject]@{base_path='/sop';public_origin=$central.publicOrigin;proxy_secret_env='SOP_PROXY_SECRET';allow_writes=$true;data_dir=$sopData}
$gatewayPath=Join-Path $sopSettings.Root 'config\sop.json'
$authPath=Join-Path $sopSettings.Root 'config\sop-auth.json'
$sopSecret=Join-Path $sopSettings.Root 'config\sop-proxy.secret'
Put $sopSecret ('a'*48)
Write-AppReleaseJson $gatewayPath $sopGateway
$sopAuth=[pscustomobject]@{BackendPort=$sopDefinition.port;PublicOrigin=$central.publicOrigin;ProxySecretPath=$sopSecret;AllowWrites=$true}
Write-AppReleaseJson $authPath $sopAuth
$escapedAuth=[Security.SecurityElement]::Escape($authPath)
$proxy='<configuration><appSettings><add key="SopIdentityBridgeOwner" value="DataPlatform-SOP-v1"/><add key="SopProxyConfigPath" value="'+$escapedAuth+'"/></appSettings><system.webServer><rewrite><rules><rule><action type="Rewrite" url="http://127.0.0.1:'+$sopDefinition.port+'/sop/{R:1}"/></rule></rules></rewrite></system.webServer></configuration>'
Put (Join-Path $sopSettings.Root 'proxy\sop\web.config') $proxy
$sopPlan=Read-InstallPlan $sopRelease $centralPath
Check ($sopPlan.Definition.serviceAccount -eq $central.serviceAccount) 'SOP plan did not inherit the unified service account.'
$sopGateway.data_dir=Join-Path $sopSettings.Root 'different-data';Write-AppReleaseJson $gatewayPath $sopGateway
Reject {Read-InstallPlan $sopRelease $centralPath}
$sopGateway.data_dir=$sopData;Write-AppReleaseJson $gatewayPath $sopGateway
$sopAuth.BackendPort=18891;Write-AppReleaseJson $authPath $sopAuth
Reject {Read-InstallPlan $sopRelease $centralPath}
$sopRuntime=[ordered]@{schemaVersion=1;appId='sop';version='v1';payload=(Join-Path $sopRelease 'payload');root=$sopSettings.Root;dataDirectory=$sopData;definition=$sopPlan.Definition}
Write-AppReleaseJson $runtimePath $sopRuntime
Reject {& (Join-Path $deploy 'Run-AppService.ps1') -RuntimeConfig $runtimePath}
Check (-not(Test-Path -LiteralPath (Join-Path $scratch 'sop-started.txt'))) 'Boot consistency failure still launched the child process.'
$sopAuth.BackendPort=$sopDefinition.port;Write-AppReleaseJson $authPath $sopAuth
$sopDefinition.arguments[-1]='{deployment}/config/different-sop.json';Write-AppReleaseJson $centralPath $central
Reject {Read-InstallPlan $sopRelease $centralPath}
Write-Output ("Deployment runtime fixtures passed: $script:checks checks; no IIS or scheduled task was modified. Evidence: $scratch")
