#requires -Version 5.1
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scratch=Join-Path $root ('artifacts/docker-deploy-test-'+[Guid]::NewGuid().ToString('N'))
$package=Join-Path $scratch 'delivery'
[void][IO.Directory]::CreateDirectory($package)
function Save($File,$Value){[IO.File]::WriteAllText($File,($Value|ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false)))}
function Check($Value,$Message){if(-not $Value){throw $Message};$dockerTestState.checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected safe failure'}
$dockerTestState=[pscustomobject]@{checks=0;calls=(New-Object Collections.Generic.List[string]);failHealth=$false;hasNetwork=$false;foreignRuntime=$false}
foreach($name in @('deploy.ps1','start.cmd','stop.cmd','runtime.example.json')){Copy-Item -LiteralPath (Join-Path $root ('deploy/docker/'+$name)) -Destination $package}
[IO.File]::WriteAllText((Join-Path $package 'images.tar'),'fixture archive')
[IO.File]::WriteAllText((Join-Path $package 'README.md'),'fixture guide')
Save (Join-Path $package 'compose.json') @{name='planhub';services=@{}}
$hashes=@{}
foreach($name in @('deploy.ps1','start.cmd','stop.cmd','runtime.example.json','images.tar','compose.json','README.md')){$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $package $name)).Hash.ToLowerInvariant()}
$manifest=@{schemaVersion=1;platform='linux/amd64';contractHash='fixture-contract';complete=$true;applications=@('planhub');files=$hashes;images=@{network=@{tag='network-fixture';id='sha256:network'};planhub=@{tag='portal-fixture';id='sha256:planhub'}}}
Save (Join-Path $package 'delivery.json') $manifest
$entry=Join-Path $package 'deploy.ps1'
& $entry -Action Prepare
$runtime=Join-Path $scratch 'planhub-runtime';$configFile=Join-Path $runtime 'config.json'
$config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
Check ($config.proxySecret.Length -eq 64) 'Missing generated secret'
$secret=$config.proxySecret
& $entry -Action Prepare
Check ((Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json).proxySecret -eq $secret) 'Prepare rotated an existing secret'
Reject {& $entry -Action Start}
$config.publicOrigin='https://portal.internal';Save $configFile $config
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $line=$Arguments -join ' ';$dockerTestState.calls.Add($line);$global:LASTEXITCODE=0
    if($Arguments[0] -eq 'info'){return 'linux/x86_64'}
    if($Arguments[0] -eq 'compose' -and $Arguments[1] -eq 'version'){return '2.24.0'}
    if($Arguments[0] -eq 'ps'){if($dockerTestState.hasNetwork){return 'network-id'}else{return ''}}
    if($Arguments[0] -eq 'inspect'){
        $owner=if($dockerTestState.foreignRuntime){'different-runtime'}else{$env:PLANHUB_RUNTIME}
        return ConvertTo-Json -Depth 10 -InputObject @(@{Config=@{Labels=@{'planhub.runtime'=$owner}};State=@{Running=$true};Image='sha256:network'})
    }
    if($Arguments[0] -eq 'image' -and $Arguments[1] -eq 'inspect'){
        if($Arguments[-1] -eq 'network-fixture'){return 'sha256:network'}else{return 'sha256:planhub'}
    }
    if($line -match 'up -d' -and $dockerTestState.failHealth){$global:LASTEXITCODE=1}
}
$dockerTestState.failHealth=$false
try {
    & $entry -Action Start
    $stateFile=Join-Path $runtime 'deployment-state.json'
    Check (Test-Path -LiteralPath $stateFile) 'No successful deployment record'
    $commands=@($dockerTestState.calls)
    Check (($commands|Where-Object {$_ -like 'image load*'}).Count -eq 1) 'Offline images were not loaded'
    Check (($commands|Where-Object {$_ -match 'up -d --wait --wait-timeout 180'}).Count -eq 1) 'Start did not wait for health'
    Check (($commands -join '|') -notmatch 'down|--remove-orphans|volume rm') 'Deployment removed data or unrelated services'
    $before=[IO.File]::ReadAllText($stateFile);$dockerTestState.failHealth=$true
    Reject {& $entry -Action Start}
    Check ([IO.File]::ReadAllText($stateFile) -ceq $before) 'Failed health was recorded as a successful deployment'
    $dockerTestState.failHealth=$false;$dockerTestState.calls.Clear()
    [IO.File]::AppendAllText((Join-Path $package 'images.tar'),'corruption')
    Reject {& $entry -Action Start}
    Check ($dockerTestState.calls.Count -eq 0) 'Corrupt package touched running services'
    [IO.File]::WriteAllText((Join-Path $package 'images.tar'),'fixture archive')
    $manifest.complete=$false;Save (Join-Path $package 'delivery.json') $manifest
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop '}).Count -eq 0) 'Partial package stopped services without baseline'
    $dockerTestState.hasNetwork=$true;$dockerTestState.calls.Clear()
    & $entry -Action Start
    Check (($dockerTestState.calls|Where-Object {$_ -match 'up -d --no-deps --wait --wait-timeout 180 planhub$'}).Count -eq 1) 'Partial update did not target only the selected app'
    Check (($dockerTestState.calls|Where-Object {$_ -match 'stop network'}).Count -eq 0) 'Partial update stopped the shared network'
    $dockerTestState.foreignRuntime=$true;$dockerTestState.calls.Clear()
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop |image load'}).Count -eq 0) 'A foreign runtime was changed'
    $dockerTestState.foreignRuntime=$false
    $config.publicOrigin='https://changed.internal';Save $configFile $config;$dockerTestState.calls.Clear()
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop |image load'}).Count -eq 0) 'Changed runtime configuration was applied to only one app'
    Write-Output ('Docker deployment checks passed: '+$dockerTestState.checks)
} finally {Remove-Item Function:docker -ErrorAction SilentlyContinue}
