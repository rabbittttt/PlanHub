#requires -Version 5.1
# Read delivery manifests only; never run an older package's scripts.
function Assert-PreviewRuntimeNoLink([string]$Path) {
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Linked Windows runtime paths are not allowed: '+$current)}
        $next=Split-Path -Parent $current;if($next -eq $current){break};$current=$next
    }
}
function Read-PreviewRuntimeManifest([string]$Delivery) {
    $file=Join-Path $Delivery 'delivery.json';Assert-PreviewRuntimeNoLink $file
    $manifest=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
    if(($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or $manifest.schemaVersion -ne 2 -or $manifest.platform -cne 'windows/amd64+linux/amd64' -or $manifest.complete -isnot [bool] -or -not $manifest.complete -or $null -eq $manifest.PSObject.Properties['files'] -or $manifest.files -isnot [pscustomobject]){throw 'Use a complete Windows delivery folder.'}
    $mode=$manifest.PSObject.Properties['runtimeMode']
    if($null -ne $mode -and $mode.Value -cnotin @('included','reuse')){throw 'Unknown Windows runtime mode.'}
    return $manifest
}
function Get-PreviewRuntimeMode($Manifest) {
    $property=$Manifest.PSObject.Properties['runtimeMode'];if($null -eq $property){return 'included'};return [string]$property.Value
}
function Get-PreviewRuntimeFiles([string]$Root,[string]$Directory) {
    Assert-PreviewRuntimeNoLink $Directory
    foreach($entry in Get-ChildItem -LiteralPath $Directory -Force){
        Assert-PreviewRuntimeNoLink $entry.FullName
        if($entry.PSIsContainer){Get-PreviewRuntimeFiles -Root $Root -Directory $entry.FullName}
        elseif($entry -is [IO.FileInfo]){$entry.FullName.Substring($Root.Length+1).Replace('\','/')}
        else{throw ('Non-file Windows runtime entry: '+$entry.FullName)}
    }
}
function Test-PreviewRuntime([string]$Delivery,$Manifest) {
    if((Get-PreviewRuntimeMode $Manifest) -cne 'included'){throw 'Candidate does not include a Windows runtime.'}
    $expected=New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($property in $Manifest.files.PSObject.Properties){
        $name=$property.Name
        if(-not $name.StartsWith('runtime/',[StringComparison]::Ordinal)){continue}
        if($name -match '[\\:*?"<>|\x00-\x1f]' -or @($name.Split('/')|Where-Object {-not $_ -or $_.StartsWith('.') -or $_ -match '[. ]$'}).Count -or $property.Value -isnot [string] -or $property.Value -cnotmatch '^[a-f0-9]{64}$' -or -not $names.Add($name)){throw ('Invalid Windows runtime checksum: '+$name)}
        $expected.Add($name,$property.Value)
    }
    if(-not $expected.ContainsKey('runtime/node/node.exe')){throw 'Candidate has no bundled Node.js.'}
    $actual=@(Get-PreviewRuntimeFiles -Root $Delivery -Directory (Join-Path $Delivery 'runtime'))
    if($actual.Count -ne $expected.Count){throw 'Windows runtime file set differs from its delivery manifest.'}
    foreach($name in $actual){
        if(-not $expected.ContainsKey($name)){throw ('Undeclared Windows runtime file: '+$name)}
        $hash=(Get-FileHash -LiteralPath (Join-Path $Delivery $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if($hash -cne $expected[$name]){throw ('Windows runtime file is damaged: '+$name)}
    }
    return (Join-Path $Delivery 'runtime/node/node.exe')
}
function Resolve-PreviewNode {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Delivery)
    $Delivery=[IO.Path]::GetFullPath($Delivery).TrimEnd('\','/')
    $manifest=Read-PreviewRuntimeManifest $Delivery
    if((Get-PreviewRuntimeMode $manifest) -ceq 'included'){return (Test-PreviewRuntime -Delivery $Delivery -Manifest $manifest)}
    if(Test-Path -LiteralPath (Join-Path $Delivery 'runtime')){throw 'A runtime-reuse delivery must not contain runtime/.'}
    $parent=Split-Path -Parent $Delivery;Assert-PreviewRuntimeNoLink $parent
    [string[]]$names=@(Get-ChildItem -LiteralPath $parent -Directory -Force|Where-Object {$_.Name -cmatch '^planhub-[A-Za-z0-9][A-Za-z0-9._-]*$' -and $_.FullName -cne $Delivery}|ForEach-Object {$_.Name})
    [Array]::Sort($names,[StringComparer]::Ordinal);[Array]::Reverse($names)
    $rejected=New-Object 'Collections.Generic.List[string]'
    foreach($name in $names){
        $candidate=Join-Path $parent $name
        try{
            $previous=Read-PreviewRuntimeManifest $candidate
            if((Get-PreviewRuntimeMode $previous) -cne 'included'){continue}
            return (Test-PreviewRuntime -Delivery $candidate -Manifest $previous)
        }catch{$rejected.Add($name+': '+$_.Exception.Message)}
    }
    $detail=($rejected|Select-Object -First 3) -join "`n"
    throw ('No verified sibling planhub-* complete delivery includes a reusable Windows runtime. Create a new complete delivery with its Windows runtime and copy it to B. No dependencies were installed or changed.'+$(if($detail){"`n"+$detail}else{''}))
}
