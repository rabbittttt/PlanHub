#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$windowsPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if(-not(Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)){throw 'System Windows PowerShell 5.1 is required for deployment script compatibility checks.'}
if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop'){
    & $windowsPowerShell -NoProfile -ExecutionPolicy RemoteSigned -File $PSCommandPath
    if($LASTEXITCODE -ne 0){throw 'Windows PowerShell 5.1 deployment script checks failed.'}
    return
}
$deploy=Split-Path -Parent $PSScriptRoot
$root=Split-Path -Parent $deploy
$script:checks=0
function Check($Value,[string]$Message){$script:checks++;if(-not $Value){throw $Message}}
function Save-FixtureText([string]$Path,[string]$Value){
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path))|Out-Null
    [IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($true)))
}
function Save-FixtureJson([string]$Path,$Value){Save-FixtureText $Path ($Value|ConvertTo-Json -Depth 20)}
function Invoke-FixtureProcess([string]$Command,[string]$Arguments,[string]$Directory,[string]$InputText=''){
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$Command
    $info.Arguments=$Arguments
    $info.WorkingDirectory=$Directory
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$info
    try{
        [void]$process.Start()
        $stdout=$process.StandardOutput.ReadToEndAsync()
        $stderr=$process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($InputText)
        $process.StandardInput.Close()
        if(-not $process.WaitForExit(15000)){
            # Only this test's process tree; there are no deployed services in fixtures.
            $kill=New-Object Diagnostics.ProcessStartInfo
            $kill.FileName=Join-Path $env:SystemRoot 'System32\taskkill.exe'
            $kill.Arguments='/PID '+$process.Id+' /T /F'
            $kill.UseShellExecute=$false;$kill.CreateNoWindow=$true
            $cleanup=[Diagnostics.Process]::Start($kill)
            try{[void]$cleanup.WaitForExit(5000)}finally{$cleanup.Dispose()}
            throw 'Fixture process timed out; only its owned process tree was stopped.'
        }
        $process.WaitForExit()
        return [pscustomobject]@{ExitCode=$process.ExitCode;Output=$stdout.Result;Error=$stderr.Result}
    }finally{$process.Dispose()}
}

$scripts=@(Get-ChildItem -LiteralPath $deploy -File -Filter '*.ps1' -Recurse)
foreach($file in $scripts){
    $parseErrors=$null;$tokens=$null
    [void][Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$parseErrors)
    $details=($parseErrors|ForEach-Object{'line '+$_.Extent.StartLineNumber+': '+$_.Message}) -join '; '
    Check (@($parseErrors).Count -eq 0) ('Windows PowerShell 5.1 ParseFile failed for '+$file.FullName+': '+$details)
}
$interactive=Join-Path $deploy 'Deploy-Interactive.ps1'
$bytes=[IO.File]::ReadAllBytes($interactive)
Check ($bytes.Length -gt 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) 'Deploy-Interactive.ps1 must retain its UTF-8 BOM for Windows PowerShell 5.1 -File.'
$decoded=[IO.File]::ReadAllText($interactive,[Text.Encoding]::UTF8)
Check ($decoded.Contains('请确认上方是部署电脑') -and $decoded.Contains('未执行发布。')) 'Deployment prompts lost their original Chinese text.'
$bat=Join-Path $root '部署新版本.bat'
$batText=[IO.File]::ReadAllText($bat,[Text.Encoding]::UTF8)
Check ($batText.Contains('chcp 65001') -and $batText.Contains('部署未完成')) 'The UTF-8 deployment BAT must select code page 65001 and preserve its Chinese text.'

$scratch=Join-Path $root ('artifacts\deployment-scripts-'+[Guid]::NewGuid().ToString('N'))
$workspace=Join-Path $scratch '部署工作区 含空格'
$fixtureDeploy=Join-Path $workspace 'deploy'
[IO.Directory]::CreateDirectory($fixtureDeploy)|Out-Null
try{
    Copy-Item -LiteralPath $interactive -Destination (Join-Path $fixtureDeploy 'Deploy-Interactive.ps1')
    Copy-Item -LiteralPath (Join-Path $deploy 'deployment.example.json') -Destination (Join-Path $fixtureDeploy 'deployment.example.json')
    $fixtureBat=Join-Path $workspace '部署新版本.bat'
    Copy-Item -LiteralPath $bat -Destination $fixtureBat
    $marker=Join-Path $workspace 'installer-call.json'
    # This fixture stands between the real interactive/BAT entry and all mutations.
    # Any accidental Apply is rejected before touching IIS, tasks or a release directory.
    $installer=@'
param([string]$ReleasePath,[string]$ConfigPath,[switch]$PlanOnly,[switch]$Apply)
$ErrorActionPreference='Stop'
if($Apply -or -not $PlanOnly){throw 'Fixture forbids Apply and every non-plan installer call.'}
$marker=Join-Path (Split-Path -Parent $PSScriptRoot) 'installer-call.json'
if(Test-Path -LiteralPath $marker){throw 'Interactive cancellation invoked the installer more than once.'}
$result=@{releasePath=$ReleasePath;configPath=$ConfigPath;planOnly=[bool]$PlanOnly;apply=[bool]$Apply}
[IO.File]::WriteAllText($marker,($result|ConvertTo-Json),(New-Object Text.UTF8Encoding($true)))
Write-Output 'Fixture plan only; no IIS, tasks or services were contacted.'
'@
    Save-FixtureText (Join-Path $fixtureDeploy 'Install-AppVersion.ps1') $installer
    $cmd=Join-Path $env:SystemRoot 'System32\cmd.exe'
    $first=Invoke-FixtureProcess $cmd ('/d /c ""'+$fixtureBat+'""') $workspace "`r`n"
    Check ($first.ExitCode -eq 0) ('The real deployment BAT could not generate a fixture config: '+$first.Error)
    $config=Join-Path $workspace 'config.local\deployment.json'
    Check (Test-Path -LiteralPath $config -PathType Leaf) 'The interactive entry did not create its fixture template.'
    Check (-not(Test-Path -LiteralPath $marker)) 'Template generation called the installer.'
    Check ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $deploy 'deployment.example.json') -Algorithm SHA256).Hash) 'Template generation transcoded or changed the reviewed JSON.'
    $generated=Get-Content -LiteralPath $config -Raw -Encoding UTF8|ConvertFrom-Json
    Check ($generated.applications.'vehicle-config'.dataDirectory -ceq '{shared}/车型配置') 'Generated template Chinese paths were corrupted.'
    $configBefore=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    $release=Join-Path $workspace '收到的版本 v1'
    $cancel=Invoke-FixtureProcess $cmd ('/d /c ""'+$fixtureBat+'" -ReleasePath "'+$release+'""') $workspace "N`r`n`r`n"
    Check ($cancel.ExitCode -eq 0) ('The real deployment BAT failed on fixture cancellation: '+$cancel.Error)
    Check (Test-Path -LiteralPath $marker -PathType Leaf) 'Cancellation did not run the preliminary plan.'
    $call=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json
    Check ($call.planOnly -and -not $call.apply -and $call.releasePath -ceq $release) 'Interactive cancellation changed the release path or requested Apply.'
    Check ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ceq $configBefore) 'Cancellation changed machine configuration.'
    Check (-not(Test-Path -LiteralPath $release)) 'The interactive fixture created a release directory.'

    # Exercise the actual installer separately with an explicitly static, isolated PlanOnly.
    $realDeploy=Join-Path $scratch 'actual-tools\deploy'
    [IO.Directory]::CreateDirectory($realDeploy)|Out-Null
    foreach($name in @('Install-AppVersion.ps1','Runtime.Release.ps1','Environment.Config.ps1','App.Release.ps1','Deployment.Common.ps1','Sop.Common.ps1','Identity.Proxy.ps1')){
        Copy-Item -LiteralPath (Join-Path $deploy $name) -Destination (Join-Path $realDeploy $name)
    }
    $payload=Join-Path $release 'payload\index.html'
    Save-FixtureText $payload '<title>Deployment plan fixture</title>'
    $manifest=[ordered]@{schemaVersion=1;appId='alpha';version='v1';type='static';basePath='/alpha/';entryPoint='index.html';sourceRevision='isolated-script-test';dataMode='stateless';healthPath='/';files=@(@{path='index.html';bytes=(Get-Item -LiteralPath $payload).Length;sha256=(Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()})}
    Save-FixtureJson (Join-Path $release 'app-release.json') $manifest
    $installed=Join-Path $scratch 'not-created-installed'
    $planConfig=Join-Path $scratch 'plan.json'
    Save-FixtureJson $planConfig ([ordered]@{deploymentRoot=$installed;siteName='DeploymentFixture';publicOrigin='http://localhost:8080';applications=@{alpha=@{kind='static'}}})
    $plan=Invoke-FixtureProcess $windowsPowerShell ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+(Join-Path $realDeploy 'Install-AppVersion.ps1')+'" -ReleasePath "'+$release+'" -ConfigPath "'+$planConfig+'" -PlanOnly') $workspace
    Check ($plan.ExitCode -eq 0 -and $plan.Output.Contains('Plan only.')) ('Actual installer PlanOnly failed: '+$plan.Error)
    Check (-not(Test-Path -LiteralPath $installed)) 'Actual PlanOnly created a deployment, version or state directory.'
    Write-Output "PASS $script:checks deployment script checks ($($scripts.Count) files parsed by Windows PowerShell 5.1). Real BAT/template/cancel and actual PlanOnly used isolated fixtures; no Apply, IIS, tasks, services or business data."
}finally{
    $resolved=[IO.Path]::GetFullPath($scratch)
    $prefix=[IO.Path]::GetFullPath((Join-Path $root 'artifacts')).TrimEnd('\')+'\deployment-scripts-'
    if(-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing unexpected deployment script fixture cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
