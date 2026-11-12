#requires -Version 5.1
[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$deploy=Split-Path -Parent $PSScriptRoot
$root=Split-Path -Parent $deploy
. (Join-Path $deploy 'Identity.Proxy.ps1')
. (Join-Path $deploy 'Sop.Common.ps1')
$scratch=Join-Path $root ('artifacts/identity-proxy-test-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path (Join-Path $scratch 'machine')
$configPath=Join-Path $scratch 'machine/deployment.json'
$checks=0
function Check([bool]$Value,[string]$Message){$script:checks++;if(-not $Value){throw $Message}}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected safe rejection'}
function Original {
    return [pscustomobject]@{deploymentRoot='../installed';siteName='IdentityFixture';publicOrigin='http://intranet.test:8088';serviceAccount='MACHINE\Fixture';applications=[pscustomobject]@{alpha=[pscustomobject]@{kind='service';port=18890;proxyMode='existing';stripPrefix=$true;backendHealthPath='/healthz';secretEnvironmentFiles=[pscustomobject]@{APP_PROXY_SECRET='config/alpha-proxy.secret'};identityProxy=[pscustomobject]@{userHeader='X-App-User';keyHeader='X-App-Proxy-Key';secretEnvironment='APP_PROXY_SECRET'}}}}
}
function Save($Config){Write-SopJson -Path $configPath -Value $Config}
$config=Original
Save $config
$binding=Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath
Check ($binding.Config.BackendPort -eq 18890) 'Port was not taken from one application binding'
Check ($binding.Config.UserHeader -ceq 'X-App-User') 'Application header contract changed'
Check ($binding.ServiceAccount -ceq 'MACHINE\Fixture') 'Default account was not inherited'
Check ($binding.ConfigPath -ieq (Join-Path $scratch 'installed/config/alpha-identity.json')) 'Protected config path incorrect'
$before=(Get-FileHash -LiteralPath $configPath).Hash
$plan=@(& (Join-Path $deploy 'Configure-IdentityProxy.ps1') -AppId alpha -DeploymentConfigPath $configPath -PlanOnly)
Check (($plan -join "`n") -match 'Offline identity plan validated') 'PlanOnly failed'
Check (-not(Test-Path -LiteralPath $binding.Root)) 'PlanOnly created deployment files'
Check ((Get-FileHash -LiteralPath $configPath).Hash -eq $before) 'PlanOnly changed source config'
Reject {& (Join-Path $deploy 'Configure-IdentityProxy.ps1') -AppId alpha -DeploymentConfigPath $configPath -PlanOnly -Apply}
Reject {Assert-IdentityProxyConsistency -Root $binding.Root -Id alpha -Definition $binding.Definition -RequireInitialized}
foreach($bad in @('Host','X-Forwarded-For','X-Original-User','X-App:User',"X-App`nUser")){
    $invalid=Original;$invalid.applications.alpha.identityProxy.userHeader=$bad;Save $invalid
    Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
}
$invalid=Original;$invalid.applications.alpha.identityProxy.keyHeader='X-App-User';Save $invalid
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
foreach($bad in @('../external.secret','proxy/alpha/key.secret','config/alpha-identity.json')){
    $invalid=Original;$invalid.applications.alpha.secretEnvironmentFiles.APP_PROXY_SECRET=$bad;Save $invalid
    Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
}
$invalid=Original;$invalid.applications.alpha.identityProxy.secretEnvironment='MISSING_SECRET';Save $invalid
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
$invalid=Original;$invalid.applications.alpha.proxyMode='prefix';Save $invalid
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
$invalid=Original;$invalid.applications.alpha.port=0;Save $invalid
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
Save $config
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $binding.ConfigPath),$binding.ProxyRoot -Force
$fixtureSecret='fixture-key-'+('a'*48)
[IO.File]::WriteAllText($binding.SecretPath,$fixtureSecret,(New-Object Text.UTF8Encoding($false)))
Write-SopJson $binding.ConfigPath $binding.Config
$xml=Get-IdentityProxyXml $binding
$webConfig=Join-Path $binding.ProxyRoot 'web.config'
[IO.File]::WriteAllText($webConfig,$xml,(New-Object Text.UTF8Encoding($false)))
Check (-not $xml.Contains($fixtureSecret)) 'Secret leaked into public web.config'
Check (-not(($plan -join "`n").Contains($fixtureSecret))) 'Secret leaked into plan output'
[xml]$parsed=$xml
$action=$parsed.SelectSingleNode('/configuration/system.webServer/rewrite/rules/rule/action[@type="Rewrite"]')
Check ($action.GetAttribute('url') -ceq 'http://127.0.0.1:18890/{R:1}') 'Prefix stripping target incorrect'
$preserved=Resolve-IdentityProxyBinding $binding.Root alpha ([pscustomobject]@{kind='service';proxyMode='existing';port=18890;stripPrefix=$false;serviceAccount='MACHINE\Fixture';healthUrl='http://intranet.test:8088/alpha/healthz';secretEnvironmentFiles=$binding.Definition.secretEnvironmentFiles;identityProxy=$binding.Definition.identityProxy}) 'IdentityFixture' 'http://intranet.test:8088'
Check ((Get-IdentityProxyXml $preserved).Contains('http://127.0.0.1:18890/alpha/{R:1}')) 'Preserved-prefix target incorrect'
& (Join-Path $deploy 'Build-IdentityBridge.ps1') -OutputDirectory (Join-Path $binding.ProxyRoot 'bin')|Out-Host
$dll=Join-Path $binding.ProxyRoot 'bin/PlanHub.TrustedIdentityBridge.dll'
Check (Test-Path -LiteralPath $dll -PathType Leaf) 'C# module did not compile'
Assert-IdentityProxyConsistency -Root $binding.Root -Id alpha -Definition $binding.Definition -RequireInitialized
Check $true 'Initialized proxy accepted'
Add-Type -Path $dll
$moduleConfig=New-Object 'PlanHub.TrustedIdentityBridge+BridgeConfig'
$moduleConfig.SchemaVersion=1;$moduleConfig.AppId='alpha';$moduleConfig.UserHeader='X-App-User';$moduleConfig.KeyHeader='X-App-Key';$moduleConfig.ProxySecretPath=$binding.SecretPath
[PlanHub.TrustedIdentityBridge]::ValidateConfiguration($moduleConfig,'alpha')
Check $true 'Module rejected the valid external configuration'
$headers=New-Object Collections.Specialized.NameValueCollection
$headers.Add('x-app-user','forged-one');$headers.Add('X-App-User','forged-two');$headers.Add('X-App-Key','forged-key');$headers.Add('Origin','http://intranet.test:8088')
[PlanHub.TrustedIdentityBridge]::StripIdentityHeaders($headers,$moduleConfig)
Check ($null -eq $headers['X-App-User'] -and $null -eq $headers['X-App-Key']) 'Client identity headers survived stripping'
Check ($headers['Origin'] -ceq 'http://intranet.test:8088') 'Identity bridge changed unrelated origin headers'
$forgedIdentity=New-Object Security.Principal.GenericIdentity('MACHINE\Fixture','forged')
Check $forgedIdentity.IsAuthenticated 'Forgery fixture must look authenticated to expose type confusion'
Reject {[PlanHub.TrustedIdentityBridge]::GetWindowsUser($forgedIdentity)}
Reject {[PlanHub.TrustedIdentityBridge]::GetWindowsUser($null)}
$windowsIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { Check ([PlanHub.TrustedIdentityBridge]::GetWindowsUser($windowsIdentity) -ceq $windowsIdentity.Name) 'Module did not preserve the real Windows login identifier' } finally { $windowsIdentity.Dispose() }
$moduleConfig.KeyHeader='X-Forwarded-User'
Reject {[PlanHub.TrustedIdentityBridge]::ValidateConfiguration($moduleConfig,'alpha')}
$moduleConfig.KeyHeader='X-App-Key'
Reject {[PlanHub.TrustedIdentityBridge]::ValidateConfiguration($moduleConfig,'another-app')}
$moduleConfig.ProxySecretPath='relative.secret'
Reject {[PlanHub.TrustedIdentityBridge]::ValidateConfiguration($moduleConfig,'alpha')}
$updated=Original;$updated.applications.alpha.port=18891;Save $updated
$newBinding=Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath
Check ($newBinding.Config.BackendPort -eq 18891) 'Updated port could not be planned'
Reject {Assert-IdentityProxyConsistency -Root $newBinding.Root -Id alpha -Definition $newBinding.Definition -RequireInitialized}
Check ([IO.File]::ReadAllText($webConfig) -ceq $xml) 'Read-only planning changed existing proxy'
$updated=Original;$updated.applications.alpha.secretEnvironmentFiles.APP_PROXY_SECRET='config/another.secret';Save $updated
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
Save $config
$originalAuth=[IO.File]::ReadAllText($binding.ConfigPath)
$wrong=Get-Content -LiteralPath $binding.ConfigPath -Raw -Encoding UTF8|ConvertFrom-Json;$wrong.UserHeader='X-Other-User';Write-SopJson $binding.ConfigPath $wrong
Reject {Assert-IdentityProxyConsistency -Root $binding.Root -Id alpha -Definition $binding.Definition -RequireInitialized}
[IO.File]::WriteAllText($binding.ConfigPath,$originalAuth,(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($webConfig,$xml.Replace('PlanHub-Identity-v1','unknown-owner'),(New-Object Text.UTF8Encoding($false)))
Reject {Assert-IdentityProxyConsistency -Root $binding.Root -Id alpha -Definition $binding.Definition -RequireInitialized}
[IO.File]::WriteAllText($webConfig,$xml,(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($binding.SecretPath,'bad',(New-Object Text.UTF8Encoding($false)))
Reject {Read-IdentityProxyBinding -AppId alpha -DeploymentConfigPath $configPath}
Write-Output "Identity proxy fixtures passed: $checks checks; C# compiled. No IIS, task, ACL or business data changed. Evidence: $scratch"
