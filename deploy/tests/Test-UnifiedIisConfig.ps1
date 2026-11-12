#requires -Version 5.1
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$root=Split-Path -Parent $deploy
. (Join-Path $deploy 'Environment.Config.ps1')
$checks=0
function Check($Value,$Message){$script:checks++;if(-not $Value){throw $Message}}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected rejection'}
$scratch=Join-Path $root ('artifacts/unified-iis-test-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $scratch
$config=[pscustomobject]@{deploymentRoot='installed';siteName='Fixture';publicOrigin='http://portal.example:8091';sharedDirectory='shared';applications=[pscustomobject]@{planhub=[pscustomobject]@{kind='portal';healthUrl='{publicOrigin}{basePath}'};alpha=[pscustomobject]@{kind='static';healthUrl='{publicOrigin}{basePath}'}}}
$path=Join-Path $scratch 'deployment.json'
function Save { [IO.File]::WriteAllText($path,($config|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false))) }
Save
$before=(Get-FileHash -LiteralPath $path).Hash
$plan=@(& (Join-Path $deploy 'Install-IisSite.ps1') -DeploymentConfigPath $path -PlanOnly)
Check (($plan -join "`n") -match 'HTTP binding: \*:8091:portal.example') 'Binding was not derived from publicOrigin'
Check (($plan -join "`n") -match 'Application: /alpha/') 'Static application missing'
Check (-not(Test-Path -LiteralPath (Join-Path $scratch 'installed'))) 'Plan mode mutated deployment root'
Check ((Get-FileHash -LiteralPath $path).Hash -eq $before) 'Plan mode changed input'
Reject { & (Join-Path $deploy 'Install-IisSite.ps1') -DeploymentConfigPath $path -ConfigPath $path -PlanOnly }
$config.publicOrigin='https://portal.example';Save
Reject { & (Join-Path $deploy 'Install-IisSite.ps1') -DeploymentConfigPath $path -PlanOnly }
$config.publicOrigin='http://portal.example/extra';Save
Reject { & (Join-Path $deploy 'Install-IisSite.ps1') -DeploymentConfigPath $path -PlanOnly }
Write-Output "PASS $checks unified IIS config checks; no IIS settings changed."
