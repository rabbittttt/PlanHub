#requires -Version 5.1
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'Runtime.Release.ps1')
$checks=0
function Check($Value,$Message){$script:checks++;if(-not $Value){throw $Message}}
$script:attempt=0;$script:publicCalls=0
function Test-BackendHealth($Definition){$script:attempt++;return $script:attempt -ge 14}
function Test-PublicHealth($Url){$script:publicCalls++;return $true}
Check (Wait-DeploymentHealth -Definition @{} -HealthUrl 'http://fixture/health' -TimeoutSeconds 2 -IntervalMilliseconds 1) 'Delayed service was rejected'
Check ($script:attempt -ge 14) 'Readiness did not go beyond old fixed attempt count'
Check ($script:publicCalls -eq 1) 'Public probe ran before backend readiness'
function Test-BackendHealth($Definition){return $false}
$watch=[Diagnostics.Stopwatch]::StartNew()
Check (-not(Wait-DeploymentHealth -Definition @{} -HealthUrl 'http://fixture/health' -TimeoutSeconds 1 -IntervalMilliseconds 20)) 'Unavailable service passed'
Check ($watch.Elapsed.TotalSeconds -lt 3) 'Deadline was not bounded'
$script:publicCalls=0
Check (Wait-DeploymentHealth -Definition $null -HealthUrl 'http://fixture/page' -TimeoutSeconds 1) 'Static page was not checked'
Check ($script:publicCalls -eq 1) 'Static page missed public check'
Write-Output "PASS $checks startup health checks; no real services or IIS used."
