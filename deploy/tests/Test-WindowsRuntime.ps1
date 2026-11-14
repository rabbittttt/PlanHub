#requires -Version 5.1
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'deploy/windows/runtime-common.ps1')
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('planhub-runtime-selector-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scratch)
$script:checks=0
function Put([string]$Path,[string]$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($false)))}
function Check($Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Check $failed 'Expected runtime selection rejection'}
function Bundle([string]$Name,[string]$Mode='included',[bool]$Complete=$true,[bool]$Legacy=$false){
    $directory=Join-Path $scratch $Name;[void][IO.Directory]::CreateDirectory($directory)
    $files=@{}
    if($Mode -eq 'included'){
        foreach($file in @('runtime/node/node.exe','runtime/node/LICENSE','runtime/python/python.exe')){Put (Join-Path $directory $file) ('synthetic '+$file);$files[$file]=(Get-FileHash -LiteralPath (Join-Path $directory $file)).Hash.ToLowerInvariant()}
    }
    $manifest=@{schemaVersion=2;platform='windows/amd64+linux/amd64';complete=$Complete;files=$files}
    if(-not $Legacy){$manifest.runtimeMode=$Mode}
    Put (Join-Path $directory 'delivery.json') ($manifest|ConvertTo-Json -Depth 20)
    return $directory
}
try{
    $older=Bundle 'planhub-100' 'included' $true $true
    Check ((Resolve-PreviewNode -Delivery $older) -ceq (Join-Path $older 'runtime/node/node.exe')) 'Legacy included runtime did not resolve itself'
    $newer=Bundle 'planhub-200'
    $null=Bundle 'planhub-300' 'reuse'
    $null=Bundle 'planhub-400' 'included' $false
    $reuse=Bundle 'planhub-500' 'reuse'
    Check ((Resolve-PreviewNode -Delivery $reuse) -ceq (Join-Path $newer 'runtime/node/node.exe')) 'Reuse did not choose newest verified included sibling'
    Put (Join-Path $newer 'runtime/node/node.exe') 'damaged'
    Check ((Resolve-PreviewNode -Delivery $reuse) -ceq (Join-Path $older 'runtime/node/node.exe')) 'Damaged runtime did not fall back to older verified bundle'
    Put (Join-Path $older 'runtime/undeclared.txt') 'undeclared'
    Reject {Resolve-PreviewNode -Delivery $reuse}
    Remove-Item -LiteralPath (Join-Path $older 'runtime/undeclared.txt')
    Put (Join-Path $reuse 'runtime/unexpected.txt') 'unexpected'
    Reject {Resolve-PreviewNode -Delivery $reuse}
    Write-Output ('Windows runtime selector checks passed: '+$script:checks)
}finally{
    $resolved=[IO.Path]::GetFullPath($scratch)
    $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if((Split-Path -Parent $resolved).TrimEnd('\','/') -cne $temporary -or -not (Split-Path -Leaf $resolved).StartsWith('planhub-runtime-selector-test-')){throw 'Unsafe fixture cleanup target'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
