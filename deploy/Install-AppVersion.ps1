#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$ReleasePath,
    [string]$ConfigPath='',
    [switch]$Apply,
    [switch]$PlanOnly,
    [switch]$Rollback,
    [switch]$DataCompatible
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Runtime.Release.ps1')
if(-not $ConfigPath){$ConfigPath=Join-Path $PSScriptRoot '..\config.local\deployment.json'}
if($PlanOnly -and $Apply){throw 'PlanOnly and Apply cannot be combined.'}
$plan=Read-InstallPlan $ReleasePath $ConfigPath
$recordPath=Join-Path $plan.StateRoot 'deployment.json'
$failurePath=Join-Path $plan.StateRoot 'failure.json'
$record=if(Test-Path -LiteralPath $recordPath){Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
if($Rollback){
    if(-not $DataCompatible){throw 'Rollback needs -DataCompatible after checking database and configuration compatibility. Data will not be restored.'}
    $failure=if(Test-Path -LiteralPath $failurePath){Get-Content -LiteralPath $failurePath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
    $previous=if($failure -and -not (Get-Setting $failure 'resolved' $false)){Get-Setting $record 'version'}else{Get-Setting $record 'previous'}
    if(-not $previous){throw 'No recorded previous version.'}
    if($previous -cne $plan.Release.Manifest.version){throw 'For rollback, select the recorded previous version package.'}
}
Write-Output ("Target: {0}; site: {1}; application: {2}; version: {3}; kind: {4}" -f $plan.Root,$plan.SiteName,$plan.Id,$plan.Release.Manifest.version,$plan.Kind)
Write-Output ('Install: '+$plan.Destination)
Write-Output ('Verify: '+$plan.HealthUrl)
if($plan.Kind -eq 'service'){
    Write-Output ('Task: '+$plan.Definition.taskName+'; persistent data: '+$plan.Definition.dataDirectory)
    Write-Output 'Wait for saves, imports and background writes to finish before Apply. Only this application is stopped.'
}
if(-not $Apply){Write-Output 'Plan only. No IIS, task, process, release directory or data was changed.';return}
if(-not $PSCmdlet.ShouldProcess($plan.Root,('Publish '+$plan.Id+' '+$plan.Release.Manifest.version))){return}
if(-not [Environment]::Is64BitProcess){throw 'Use 64-bit Windows PowerShell on the deployment computer.'}
$assembly=Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
if(-not(Test-Path -LiteralPath $assembly)){throw 'IIS management API is missing. Complete first-time IIS setup.'}
Add-Type -Path $assembly
$manager=New-Object Microsoft.Web.Administration.ServerManager
$lock=$null
$oldPhysical=$null
$changedStatic=$false
$createdStatic=$false
$started=$false
$task=$null
try {
    $site=$manager.Sites[$plan.SiteName]
    if($null -eq $site){throw 'Configured IIS site does not exist. Complete initial site setup first.'}
    $appPath=if($plan.Kind -eq 'portal'){'/'}else{'/'+$plan.Id}
    $application=$site.Applications[$appPath]
    if($plan.Kind -eq 'service'){
        $task=Get-ScheduledTask -TaskName $plan.Definition.taskName -ErrorAction SilentlyContinue
        if($task){Assert-OwnedTask $task $plan.Id $plan.Root
            if($task.Principal.UserId -ine $plan.Definition.serviceAccount){throw 'Task service account differs. Review it separately.'}
        }elseif(-not(Test-PortFree $plan.Definition.port)){throw 'Backend port belongs to another process. Stop or migrate the old service separately.'}
        if($plan.Definition.proxyMode -eq 'existing'){
            if($null -eq $application){throw 'The application requires its existing IIS proxy/identity bridge.'}
            if($null -ne (Get-Setting $plan.Definition 'identityProxy')) {
                $identityBinding=Resolve-IdentityProxyBinding $plan.Root $plan.Id $plan.Definition $plan.SiteName ''
                $identityPool=$manager.ApplicationPools[$identityBinding.ApplicationPool]
                if($application.ApplicationPoolName -cne $identityBinding.ApplicationPool -or $null -eq $identityPool -or $identityPool.ManagedRuntimeVersion -ne 'v4.0' -or $identityPool.ManagedPipelineMode.ToString() -ne 'Integrated'){throw 'Existing IIS identity application uses a different pool or managed runtime. No service was switched.'}
            }
            if($plan.Id -eq 'sop' -or $null -ne (Get-Setting $plan.Definition 'identityProxy')) {
                $expectedProxy=Join-Path $plan.Root ('proxy\'+$plan.Id)
                if($application.VirtualDirectories['/'].PhysicalPath -ine $expectedProxy){throw 'Existing IIS identity application points to a different physical directory. No service was switched.'}
            }
        } else {
            $proxyRoot=Join-Path $plan.Root ('proxy\'+$plan.Id)
            if($application -and $application.VirtualDirectories['/'].PhysicalPath -ine $proxyRoot){throw 'Existing IIS application is not this tool owned proxy. Migrate explicitly first.'}
            $appHost=$manager.GetApplicationHostConfiguration()
            $modules=@($appHost.GetSection('system.webServer/globalModules').GetCollection() | ForEach-Object {[string]$_.GetAttributeValue('name')})
            if('RewriteModule' -notin $modules -or 'ApplicationRequestRouting' -notin $modules -or -not [bool]$appHost.GetSection('system.webServer/proxy').GetAttributeValue('enabled')){throw 'IIS URL Rewrite and enabled ARR are required. This tool does not change global settings.'}
            if(-not [bool]$appHost.GetSection('system.webServer/proxy').GetAttributeValue('preserveHostHeader')){throw 'Configure ARR preserveHostHeader during first-time setup.'}
            $strip=Get-Setting $plan.Definition 'stripPrefix' $true
            $target='http://127.0.0.1:'+$plan.Definition.port+'/'
            if(-not $strip){$target+=$plan.Id+'/'}
            $limit=Get-Setting $plan.Definition 'maxRequestBytes' 269484032
            if($limit -isnot [int] -or $limit -lt 1024 -or $limit -gt 2147483647){throw 'Invalid maxRequestBytes.'}
            $proxyXml='<?xml version="1.0" encoding="utf-8"?><configuration><system.webServer><security><requestFiltering><requestLimits maxAllowedContentLength="'+$limit+'" /></requestFiltering></security><rewrite><rules><rule name="PlanHub-'+$plan.Id+'" stopProcessing="true"><match url="^(.*)$" /><action type="Rewrite" url="'+$target+'{R:1}" appendQueryString="true" /></rule></rules></rewrite></system.webServer></configuration>'
            $proxyFile=Join-Path $proxyRoot 'web.config'
            if(Test-Path -LiteralPath $proxyFile){
                if([IO.File]::ReadAllText($proxyFile) -cne $proxyXml){throw 'Proxy configuration differs. Preserve and review the existing proxy before changing its port/limits.'}
            }
        }
    }
    New-Item -ItemType Directory -Path $plan.StateRoot -Force | Out-Null
    Assert-LocalPath $plan.StateRoot
    $lock=[IO.File]::Open((Join-Path $plan.StateRoot 'publish.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    # Re-read under lock; an earlier publisher must not be silently overwritten.
    $current=if(Test-Path -LiteralPath $recordPath){Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
    if((Get-Setting $current 'version') -cne (Get-Setting $record 'version')){throw 'Deployment changed while planning. Run again.'}
    if(Test-Path -LiteralPath $plan.Destination){
        $installed=Assert-AppRelease $plan.Destination
        if(($installed.Manifest | ConvertTo-Json -Depth 30 -Compress) -cne ($plan.Release.Manifest | ConvertTo-Json -Depth 30 -Compress)){throw 'Version already exists with different content. Use a new version.'}
    }else{
        $parent=Split-Path -Parent $plan.Destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Assert-LocalPath $parent
        $incoming=Join-Path $parent ('.incoming-'+[guid]::NewGuid().ToString('N'))
        $null=Copy-ValidatedRelease $plan.Release $incoming
        Move-Item -LiteralPath $incoming -Destination $plan.Destination
    }
    $payload=Join-Path $plan.Destination 'payload'
    if($plan.Kind -ne 'service'){
        if($application){$oldPhysical=$application.VirtualDirectories['/'].PhysicalPath;$application.VirtualDirectories['/'].PhysicalPath=$payload}
        else{$application=$site.Applications.Add($appPath,$payload);$application.ApplicationPoolName=$site.Applications['/'].ApplicationPoolName;$createdStatic=$true}
        $manager.CommitChanges();$changedStatic=$true
    }else{
        $runtimePath=Join-Path $plan.StateRoot 'active.json'
        $runtime=[ordered]@{schemaVersion=1;appId=$plan.Id;version=$plan.Release.Manifest.version;payload=$payload;root=$plan.Root;dataDirectory=(Resolve-LocalDeploymentPath $plan.Definition.dataDirectory $plan.Root 'dataDirectory');definition=$plan.Definition}
        if($task){
            Stop-ScheduledTask -TaskName $plan.Definition.taskName
            $stopped=$false
            for($i=0;$i -lt 40;$i++){
                $state=(Get-ScheduledTask -TaskName $plan.Definition.taskName).State
                if($state -notin @('Running','Queued') -and (Test-PortFree $plan.Definition.port)){$stopped=$true;break}
                Start-Sleep -Milliseconds 250
            }
            if(-not $stopped){throw 'Old service has not fully stopped. No new instance was started. Inspect task and port.'}
        }
        if(-not(Test-PortFree $plan.Definition.port)){throw 'Backend port is not free; no new service will be started.'}
        if(Test-Path -LiteralPath $runtimePath){Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $plan.StateRoot ('runtime-'+[guid]::NewGuid().ToString('N')+'.json'))}
        Write-AtomicJson $runtimePath $runtime
        if($plan.Definition.proxyMode -eq 'prefix'){
            New-Item -ItemType Directory -Path $proxyRoot -Force | Out-Null
            Assert-LocalPath $proxyRoot
            if(-not(Test-Path -LiteralPath $proxyFile)){[IO.File]::WriteAllText($proxyFile,$proxyXml,(New-Object Text.UTF8Encoding($false)))}
            if(-not $application){$application=$site.Applications.Add($appPath,$proxyRoot);$application.ApplicationPoolName=$site.Applications['/'].ApplicationPoolName;$manager.CommitChanges()}
        }
        if(-not $task){
            $shell=Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $launcher=Join-Path $PSScriptRoot 'Run-AppService.ps1'
            $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "'+$launcher+'" -RuntimeConfig "'+$runtimePath+'"'
            $action=New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $plan.StateRoot
            $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            $principal=New-ScheduledTaskPrincipal -UserId $plan.Definition.serviceAccount -LogonType S4U -RunLevel Limited
            Register-ScheduledTask -TaskName $plan.Definition.taskName -Description ('PlanHub managed '+$plan.Id+' '+$plan.Root) -Action $action -Settings $settings -Principal $principal -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
        }
        Start-ScheduledTask -TaskName $plan.Definition.taskName;$started=$true
    }
    $healthDefinition=if($plan.Kind -eq 'service'){$plan.Definition}else{$null}
    $startupTimeout=[int](Get-Setting $plan.Definition 'startupTimeoutSeconds' 60)
    $healthy=Wait-DeploymentHealth -Definition $healthDefinition -HealthUrl $plan.HealthUrl -TimeoutSeconds $startupTimeout
    if(-not $healthy){throw 'Published version failed health checks. See application logs. No data or database was rolled back.'}
    $previous=Get-Setting $record 'version'
    if($previous -ceq $plan.Release.Manifest.version){$previous=Get-Setting $record 'previous'}
    Write-AtomicJson $recordPath ([ordered]@{appId=$plan.Id;version=$plan.Release.Manifest.version;previous=$previous;release=$plan.Destination;publishedAt=[DateTime]::UtcNow.ToString('o');healthUrl=$plan.HealthUrl})
    if(Test-Path -LiteralPath $failurePath){Write-AtomicJson $failurePath ([ordered]@{resolved=$true;version=$plan.Release.Manifest.version})}
    Write-Output ('Published and verified: '+$plan.Id+' '+$plan.Release.Manifest.version)
}catch{
    if($started){Stop-ScheduledTask -TaskName $plan.Definition.taskName -ErrorAction Continue}
    if($changedStatic -and $oldPhysical){$application.VirtualDirectories['/'].PhysicalPath=$oldPhysical;$manager.CommitChanges()}
    elseif($changedStatic -and $createdStatic){$site.Applications.Remove($application);$manager.CommitChanges()}
    if($lock){Write-AtomicJson $failurePath ([ordered]@{resolved=$false;failedVersion=$plan.Release.Manifest.version;recoverVersion=(Get-Setting $record 'version');failedAt=[DateTime]::UtcNow.ToString('o')})}
    Write-Warning 'Publication failed. Previous release files and business data are retained. If the dynamic service was switched, it is left stopped; recover with the recorded successful version and -Rollback -DataCompatible.'
    throw
}finally{if($lock){$lock.Dispose()};$manager.Dispose()}
