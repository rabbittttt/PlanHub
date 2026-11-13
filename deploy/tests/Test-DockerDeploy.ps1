#requires -Version 5.1
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('planhub-docker-deploy-test-'+[Guid]::NewGuid().ToString('N'))
$package=Join-Path $scratch 'delivery';[void][IO.Directory]::CreateDirectory($package)
function Save($File,$Value){[IO.File]::WriteAllText($File,($Value|ConvertTo-Json -Depth 50),(New-Object Text.UTF8Encoding($false)))}
function Put($File,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $File));[IO.File]::WriteAllText($File,$Value)}
function Check($Value,$Message){if(-not $Value){throw $Message};$dockerTestState.checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected safe failure'}
$dockerTestState=[pscustomobject]@{checks=0;calls=(New-Object Collections.Generic.List[string]);failHealth=$false;hasNetwork=$false;foreignRuntime=$false;images=@{}}
foreach($name in @('deploy.ps1','delivery-common.ps1','start.cmd','stop.cmd','runtime.example.json','prepare.cmd','build-docker.ps1','build-docker.cmd')){Copy-Item -LiteralPath (Join-Path $root ('deploy/docker/'+$name)) -Destination $package}
Put (Join-Path $package 'runtime/node/node.exe') 'fixture - never executed'
Put (Join-Path $package 'README.md') 'fixture guide'
Put (Join-Path $package 'bindings.json') '{}'
Save (Join-Path $package 'compose.json') @{name='planhub';services=@{}}
$images=@{}
foreach($id in @('network','planhub')){
    Put (Join-Path $package ('docker/'+$id+'.Dockerfile')) 'FROM fixture - never built'
    $fingerprint=if($id -eq 'network'){'a'*64}else{'b'*64}
    $images[$id]=@{tag=('planhub/'+$id+':'+$fingerprint.Substring(0,32));fingerprint=$fingerprint;dockerfile=('docker/'+$id+'.Dockerfile')}
}
$hashes=@{}
foreach($file in Get-ChildItem -LiteralPath $package -Recurse -File){$hashes[$file.FullName.Substring($package.Length+1).Replace('\','/')]=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()}
$manifest=@{schemaVersion=2;platform='windows/amd64+linux/amd64';contractHash='fixture-contract';complete=$true;applications=@('planhub');versions=@{planhub='v1'};files=$hashes;images=$images}
Save (Join-Path $package 'delivery.json') $manifest
$entry=Join-Path $package 'deploy.ps1';$builder=Join-Path $package 'build-docker.ps1'
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $line=$Arguments -join ' ';$dockerTestState.calls.Add($line);$global:LASTEXITCODE=0
    if($Arguments[0] -eq 'info'){return 'linux/x86_64'}
    if($Arguments[0] -eq 'compose' -and $Arguments[1] -eq 'version'){return '2.24.0'}
    if($Arguments[0] -eq 'ps'){if($dockerTestState.hasNetwork){return 'network-id'}else{return ''}}
    if($Arguments[0] -eq 'inspect'){
        $owner=if($dockerTestState.foreignRuntime){'different-runtime'}else{$env:PLANHUB_RUNTIME}
        return ConvertTo-Json -Depth 10 -InputObject @(@{Config=@{Labels=@{'planhub.runtime'=$owner}};State=@{Running=$true};Image=('sha256:'+'c'*64)})
    }
    if($Arguments[0] -eq 'build'){
        $tag=$Arguments[[Array]::IndexOf($Arguments,'--tag')+1]
        $fingerprint=$Arguments[[Array]::IndexOf($Arguments,'--label')+1].Split('=')[1]
        $actualId=if($tag.StartsWith('planhub/network:')){'c'*64}else{'d'*64}
        $dockerTestState.images[$tag]=@{Id=('sha256:'+$actualId);Os='linux';Architecture='amd64';Config=@{Labels=@{'planhub.fingerprint'=$fingerprint}}}
        return
    }
    if($Arguments[0] -eq 'image' -and $Arguments[1] -eq 'inspect'){
        $tag=$Arguments[-1]
        if(-not $dockerTestState.images.ContainsKey($tag)){$global:LASTEXITCODE=1;return}
        return ConvertTo-Json -Depth 10 -InputObject @($dockerTestState.images[$tag])
    }
    if($line -match 'up -d'){
        if($dockerTestState.failHealth){$global:LASTEXITCODE=1}else{$dockerTestState.hasNetwork=$true}
    }
}
try{
    & $entry -Action Prepare
    $runtime=Join-Path $scratch 'planhub-runtime';$configFile=Join-Path $runtime 'config.json'
    $config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
    Check ($config.proxySecret.Length -eq 64) 'Missing generated secret'
    $secret=$config.proxySecret;& $entry -Action Prepare
    Check ((Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json).proxySecret -ceq $secret) 'Prepare rotated an existing secret'
    Check ($dockerTestState.calls.Count -eq 0) 'Preparing B data must not require Docker'
    Reject {& $entry -Action Start}
    $config.publicOrigin='https://portal.internal';Save $configFile $config
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop |up -d'}).Count -eq 0) 'Missing build record touched services'
    $dockerTestState.calls.Clear();& $builder
    Check (($dockerTestState.calls|Where-Object {$_ -like 'build *'}).Count -eq 2) 'Colleague builder did not build the two fixture images'
    Check (($dockerTestState.calls -join '|') -notmatch ' stop |up -d|image load|image save') 'Building started or stopped services'
    $dockerTestState.calls.Clear();& $builder
    Check (($dockerTestState.calls|Where-Object {$_ -like 'build *'}).Count -eq 0) 'Existing immutable images were rebuilt'
    & $entry -Action Start
    $stateFile=Join-Path $runtime 'deployment-state.json'
    Check ((Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json).running) 'No running deployment record'
    Check ((Get-Content -LiteralPath (Join-Path $runtime 'deployment-active.json') -Raw|ConvertFrom-Json).mayBeRunning) 'Startup did not mark possible writers before success'
    Check (($dockerTestState.calls|Where-Object {$_ -match 'up -d --wait --wait-timeout 180$'}).Count -eq 1) 'Start did not wait for health'
    $before=[IO.File]::ReadAllText($stateFile);$dockerTestState.failHealth=$true
    Reject {& $entry -Action Start}
    Check ([IO.File]::ReadAllText($stateFile) -ceq $before) 'Failed health was recorded as successful'
    $dockerTestState.failHealth=$false;$dockerTestState.calls.Clear()
    [IO.File]::AppendAllText((Join-Path $package 'bindings.json'),'corruption')
    Reject {& $entry -Action Start}
    Check ($dockerTestState.calls.Count -eq 0) 'Corrupt package touched running services'
    Put (Join-Path $package 'bindings.json') '{}'
    Put (Join-Path $package 'extra.txt') 'undeclared';Reject {& $entry -Action Prepare};Remove-Item -LiteralPath (Join-Path $package 'extra.txt')
    $manifest.complete=$false;Save (Join-Path $package 'delivery.json') $manifest
    & $builder;$dockerTestState.calls.Clear();& $entry -Action Start
    Check (($dockerTestState.calls|Where-Object {$_ -match 'up -d --no-deps --wait --wait-timeout 180 planhub$'}).Count -eq 1) 'Partial update did not target only the selected app'
    Check (($dockerTestState.calls|Where-Object {$_ -match 'stop network'}).Count -eq 0) 'Partial update stopped the shared network'
    $dockerTestState.foreignRuntime=$true;$dockerTestState.calls.Clear()
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop '}).Count -eq 0) 'Foreign runtime was changed'
    $dockerTestState.foreignRuntime=$false
    $config.publicOrigin='https://changed.internal';Save $configFile $config;$dockerTestState.calls.Clear()
    Reject {& $entry -Action Start}
    Check (($dockerTestState.calls|Where-Object {$_ -match ' stop '}).Count -eq 0) 'Changed runtime configuration applied to one app'
    $manifest.complete=$true;Save (Join-Path $package 'delivery.json') $manifest
    & $entry -Action Stop
    Check (-not (Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json).running) 'Full stop did not release source for native snapshot'
    Check (-not (Get-Content -LiteralPath (Join-Path $runtime 'deployment-active.json') -Raw|ConvertFrom-Json).mayBeRunning) 'Full stop did not release conservative active marker'
    Check (($dockerTestState.calls|Where-Object {$_ -eq 'stop network-id'}).Count -ge 1) 'Full stop did not stop all verified owned containers'
    $tag=$manifest.images.planhub.tag;$dockerTestState.images[$tag].Config.Labels.'planhub.fingerprint'='bad'
    Reject {& $builder}
    Check (($dockerTestState.calls -join '|') -notmatch 'down|--remove-orphans|volume rm|image load') 'Deployment removed data or loaded nonexistent archive'
    Write-Output ('Docker material/deployment checks passed: '+$dockerTestState.checks)
}finally{
    Remove-Item Function:docker -ErrorAction SilentlyContinue
    $resolved=[IO.Path]::GetFullPath($scratch);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^planhub-docker-deploy-test-[a-f0-9]{32}$'){throw 'Unexpected temporary cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
