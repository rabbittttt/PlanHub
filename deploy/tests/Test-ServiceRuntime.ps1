#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'Run this native-stream regression test with Windows PowerShell 5.1 (powershell.exe).' }
$deploy=Split-Path -Parent $PSScriptRoot
$project=Split-Path -Parent $deploy
. (Join-Path $deploy 'Runtime.Release.ps1')
$scratch=Join-Path $project ('artifacts\service-runtime-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$script:checks=0
function Check([bool]$Value,[string]$Message){$script:checks++;if(-not $Value){throw $Message}}
function Put([string]$Path,[string]$Text){New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force|Out-Null;[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
function Rejected([scriptblock]$Action,[string]$Pattern=''){
    $failure=$null
    try{& $Action | Out-Null}catch{$failure=$_}
    Check ($null -ne $failure) 'Expected the service wrapper to reject this fixture.'
    if($Pattern){Check ($failure.Exception.Message -match $Pattern) ('Unexpected failure: '+$failure.Exception.Message)}
}
$names=@('PLANHUB_RUNTIME_TEST_VALUE','PLANHUB_RUNTIME_TEST_SECRET','PLANHUB_RUNTIME_TEST_UNSET')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$originalLocation=(Get-Location).Path
try {
    $prepared=Join-Path $scratch 'prepared'
    $fixture=@'
param([string]$Data,[int]$ExitCode=0)
[Console]::Error.WriteLine('benign fixture stderr before completion')
Start-Sleep -Milliseconds 100
$result=@{value=$env:PLANHUB_RUNTIME_TEST_VALUE;secret=$env:PLANHUB_RUNTIME_TEST_SECRET;introduced=$env:PLANHUB_RUNTIME_TEST_UNSET;edition=$PSVersionTable.PSEdition;major=$PSVersionTable.PSVersion.Major;cwd=(Get-Location).Path}
[IO.File]::WriteAllText((Join-Path $Data 'result.json'),($result|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
[Console]::Out.WriteLine('fixture completed after benign stderr')
exit $ExitCode
'@
    Put (Join-Path $prepared 'fixture.ps1') $fixture
    $release=Join-Path $scratch 'fixture-v1'
    & (Join-Path $deploy 'New-AppRelease.ps1') -PayloadPath $prepared -Destination $release -AppId runtime-fixture -Version v1 -Type service -EntryPoint fixture.ps1 -SourceRevision fixture-only -DataMode external -HealthPath /healthz | Out-Null
    $root=Join-Path $scratch 'installed'
    $data=Join-Path $root 'data\runtime-fixture'
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Put (Join-Path $root 'config\fixture-secret.txt') 'runtime-secret-fixture'
    $shell=Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $definition=[pscustomobject]@{
        command=$shell
        arguments=@('-NoProfile','-NonInteractive','-File','{payload}/fixture.ps1','-Data','{data}','-ExitCode','0')
        environment=[pscustomobject]@{PLANHUB_RUNTIME_TEST_VALUE='runtime-value-fixture';PLANHUB_RUNTIME_TEST_SECRET='intermediate-environment-value';PLANHUB_RUNTIME_TEST_UNSET='introduced-by-runtime'}
        secretEnvironmentFiles=[pscustomobject]@{PLANHUB_RUNTIME_TEST_SECRET='config/fixture-secret.txt'}
        port=18888
    }
    $runtime=[pscustomobject]@{schemaVersion=1;appId='runtime-fixture';version='v1';payload=(Join-Path $release 'payload');root=$root;dataDirectory=$data;definition=$definition}
    $runtimePath=Join-Path $scratch 'active.json'
    $runner=Join-Path $deploy 'Run-AppService.ps1'
    $resultPath=Join-Path $data 'result.json'
    $logPath=Join-Path $root 'logs\runtime-fixture\service.log'
    $env:PLANHUB_RUNTIME_TEST_VALUE='original-value-fixture'
    $env:PLANHUB_RUNTIME_TEST_SECRET='original-secret-fixture'
    [Environment]::SetEnvironmentVariable('PLANHUB_RUNTIME_TEST_UNSET',$null,'Process')
    function Check-Restored {
        Check ($env:PLANHUB_RUNTIME_TEST_VALUE -ceq 'original-value-fixture') 'The wrapper leaked a process environment override.'
        Check ($env:PLANHUB_RUNTIME_TEST_SECRET -ceq 'original-secret-fixture') 'A variable shared by environment and secret bindings was not restored to its original value.'
        Check ($null -eq [Environment]::GetEnvironmentVariable('PLANHUB_RUNTIME_TEST_UNSET','Process')) 'A newly introduced environment variable survived the child process.'
        Check ((Get-Location).Path -eq $originalLocation) 'The wrapper changed the caller working directory.'
        Check ($ErrorActionPreference -eq 'Stop') 'The native stderr workaround changed the caller error preference.'
    }

    # Real Windows PowerShell child writes stderr, then continues and exits 0.
    # This fails with NativeCommandError on the old service wrapper.
    Write-AppReleaseJson $runtimePath $runtime
    & $runner -RuntimeConfig $runtimePath
    Check (Test-Path -LiteralPath $resultPath -PathType Leaf) 'Benign stderr prevented the child from reaching its completion marker.'
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Check ($result.edition -ceq 'Desktop' -and $result.major -eq 5) 'The native child was not Windows PowerShell 5.1.'
    Check ($result.value -ceq 'runtime-value-fixture' -and $result.secret -ceq 'runtime-secret-fixture') 'The fixture did not receive the configured process and secret environment.'
    Check ($result.introduced -ceq 'introduced-by-runtime') 'The newly introduced runtime variable was not passed to the child.'
    Check ($result.cwd -eq $runtime.payload) 'The native child did not run from its immutable payload.'
    $log=Get-Content -LiteralPath $logPath -Raw
    Check ($log -match 'benign fixture stderr before completion' -and $log -match 'fixture completed after benign stderr') 'Both native stdout and stderr must remain in the service log.'
    Check-Restored
    $null=Assert-AppRelease $release
    Check $true 'Running the fixture must not change release files.'

    # Stderr must not hide the real non-zero exit code or skip restoration.
    $definition.arguments[-1]='17'
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath} 'code 17'
    Check-Restored
    $definition.arguments[-1]='0'
    Remove-Item -LiteralPath $resultPath

    # A stale successful LASTEXITCODE cannot make a missing/invalid executable
    # or an inaccessible log target look like a successful service exit.
    $definition.command=Join-Path $scratch 'missing.exe'
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath} 'command is missing'
    Check (-not(Test-Path -LiteralPath $resultPath)) 'The missing-command fixture unexpectedly ran.'
    Check-Restored
    $invalid=Join-Path $scratch 'invalid.exe'
    Put $invalid 'not a Windows executable'
    $definition.command=$invalid
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath}
    Check (-not(Test-Path -LiteralPath $resultPath)) 'The invalid-command fixture unexpectedly ran.'
    Check-Restored
    $definition.command=$shell
    $oldLog=$logPath+'.previous'
    Move-Item -LiteralPath $logPath -Destination $oldLog
    New-Item -ItemType Directory -Path $logPath | Out-Null
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath}
    Check (-not(Test-Path -LiteralPath $resultPath)) 'A log-open failure still launched the fixture.'
    Check-Restored
    Remove-Item -LiteralPath $logPath
    Move-Item -LiteralPath $oldLog -Destination $logPath

    # Existing or hand-edited active.json must pass the same private-path
    # boundary before any process or secret is read, even without a new plan.
    foreach($folder in @('portal','apps','proxy','releases','data/../portal')){
        $unsafe=Join-Path $root ($folder+'\private')
        New-Item -ItemType Directory -Path $unsafe -Force | Out-Null
        $runtime.dataDirectory=$unsafe
        Write-AppReleaseJson $runtimePath $runtime
        Rejected {& $runner -RuntimeConfig $runtimePath}
        Check (-not(Test-Path -LiteralPath $resultPath)) 'An unsafe active data path still launched the fixture.'
    }
    $runtime.dataDirectory=$data
    $definition.command=Join-Path $root 'portal\private\interpreter.exe'
    Put $definition.command 'fixture; never execute'
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath}
    Check (-not(Test-Path -LiteralPath $resultPath)) 'An unsafe active interpreter still launched the fixture.'
    $definition.command=$shell
    $definition.secretEnvironmentFiles.PLANHUB_RUNTIME_TEST_SECRET='apps/private/fixture-secret.txt'
    Put (Join-Path $root 'apps\private\fixture-secret.txt') 'fixture; never read'
    Write-AppReleaseJson $runtimePath $runtime
    Rejected {& $runner -RuntimeConfig $runtimePath}
    Check (-not(Test-Path -LiteralPath $resultPath)) 'An unsafe active secret path still launched the fixture.'
    Check-Restored
    Write-Output ("PASS {0} service runtime checks under Windows PowerShell {1}; no business services, IIS, tasks or real data were used. Evidence: {2}" -f $script:checks,$PSVersionTable.PSVersion,$scratch)
} finally {
    foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
    Set-Location -LiteralPath $originalLocation
}
