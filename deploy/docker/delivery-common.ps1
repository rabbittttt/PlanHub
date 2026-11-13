#requires -Version 5.1
function Assert-DeliveryNoLink([string]$Path){
    $current=$Path
    while($current){
        if(Test-Path -LiteralPath $current){$item=Get-Item -LiteralPath $current -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime and delivery paths cannot contain links.'}}
        $parent=Split-Path -Parent $current;if($parent -eq $current){break};$current=$parent
    }
}
function Write-DeliveryJson($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 50)+"`n",(New-Object Text.UTF8Encoding($false)))}
function Read-Delivery([string]$Package){
    Assert-DeliveryNoLink $Package
    $file=Join-Path $Package 'delivery.json';Assert-DeliveryNoLink $file
    $manifest=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
    if($manifest.schemaVersion -ne 2 -or $manifest.platform -cne 'windows/amd64+linux/amd64'){throw 'Unsupported delivery folder. Create a new package on A.'}
    if($manifest.complete -isnot [bool] -or -not @($manifest.applications).Count){throw 'Invalid delivery application set.'}
    $ids=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($id in $manifest.applications){if($id -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or $id -eq 'network' -or -not $ids.Add($id)){throw 'Invalid application ID.'}}
    $expected=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($entry in $manifest.files.PSObject.Properties){
        $name=$entry.Name
        if($name -ne '.dockerignore' -and ($name -match '[\\:*?"<>|\x00-\x1f]' -or $name.StartsWith('/') -or @($name.Split('/')|Where-Object {-not $_ -or $_.StartsWith('.') -or $_ -match '[. ]$'}).Count)){throw 'Invalid delivery checksum path.'}
        if($name -eq 'delivery.json' -or -not $expected.Add($name) -or $entry.Value -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid delivery checksums.'}
        $target=Join-Path $Package $name;Assert-DeliveryNoLink $target
        if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value){throw ('Delivery file is damaged: '+$name)}
    }
    $actual=New-Object 'Collections.Generic.List[string]'
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($Package)
    while($pending.Count){
        foreach($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force){
            if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked delivery entries are not allowed.'}
            if($entry.PSIsContainer){$pending.Push($entry.FullName)}else{$name=$entry.FullName.Substring($Package.Length+1).Replace('\','/');if($name -ne 'delivery.json'){$actual.Add($name)}}
        }
    }
    if($actual.Count -ne $expected.Count -or @($actual|Where-Object {-not $expected.Contains($_)}).Count){throw 'Delivery contains missing or undeclared files.'}
    foreach($name in @('compose.json','bindings.json','README.md','deploy.ps1','delivery-common.ps1','build-docker.ps1','runtime.example.json','runtime/node/node.exe')){if(-not $expected.Contains($name)){throw ('Missing delivery file: '+$name)}}
    $images=@($manifest.images.PSObject.Properties)
    if($images.Count -ne $ids.Count+1 -or $null -eq $manifest.images.PSObject.Properties['network']){throw 'Invalid Docker image set.'}
    foreach($entry in $images){
        if($entry.Name -ne 'network' -and -not $ids.Contains($entry.Name)){throw 'Unknown Docker image.'}
        $image=$entry.Value
        if($image.tag -cnotmatch '^planhub/[a-z][a-z0-9-]*:[a-f0-9]{32}$' -or $image.fingerprint -cnotmatch '^[a-f0-9]{64}$' -or $image.dockerfile -cne ('docker/'+$entry.Name+'.Dockerfile') -or -not $expected.Contains($image.dockerfile)){throw 'Invalid Docker build definition.'}
    }
    return $manifest
}
function Invoke-DeliveryDocker {
    param([string[]]$Arguments,[switch]$Capture)
    if($Capture){$value=& docker @Arguments;if($LASTEXITCODE -ne 0){throw 'Docker command failed.'};return ($value -join "`n")}
    & docker @Arguments
    if($LASTEXITCODE -ne 0){throw 'Docker command failed. Check the output above; deployment is not complete.'}
}
function Assert-DeliveryDocker {
    $engine=Invoke-DeliveryDocker -Arguments @('info','--format','{{.OSType}}/{{.Architecture}}') -Capture
    if($engine -notmatch '^linux/(x86_64|amd64)$'){throw 'Start Docker using Linux containers on x86_64/amd64.'}
    $version=Invoke-DeliveryDocker -Arguments @('compose','version','--short') -Capture
    if($version -notmatch '^v?(\d+)\.(\d+)\.' -or [int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 20)){throw 'Docker Compose 2.20 or newer is required.'}
}
function Get-DeliveryRuntime([string]$Package,[string]$RuntimeDirectory){
    if(-not $RuntimeDirectory){$RuntimeDirectory=Join-Path (Split-Path -Parent $Package) 'planhub-runtime'}
    $runtime=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDirectory).TrimEnd('\','/')
    if($runtime -eq [IO.Path]::GetPathRoot($runtime).TrimEnd('\','/') -or $runtime -eq $Package -or $runtime.StartsWith($Package+'\',[StringComparison]::OrdinalIgnoreCase) -or $Package.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime data must be outside the delivery folder and below a filesystem root.'}
    Assert-DeliveryNoLink $runtime;return $runtime
}
