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
$definition.dataDirectory='releases/beta/v1';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath}
$definition.dataDirectory='proxy/beta';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath}
$definition.dataDirectory='data/beta';$definition.environment | Add-Member -NotePropertyName PATH -NotePropertyValue 'changed';Write-AppReleaseJson $configPath $config;Reject {Read-InstallPlan $serviceRelease $configPath};$definition.environment.PSObject.Properties.Remove('PATH')
Write-AppReleaseJson $configPath $config
Reject {Assert-OwnedTask ([pscustomobject]@{Description='unrelated'}) 'beta' $plan.Root}
Assert-OwnedTask ([pscustomobject]@{Description=('PlanHub managed beta '+$plan.Root)}) 'beta' $plan.Root;Check $true 'Owned task not accepted.'
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
Write-Output ("Deployment runtime fixtures passed: $script:checks checks; no IIS or scheduled task was modified. Evidence: $scratch")
