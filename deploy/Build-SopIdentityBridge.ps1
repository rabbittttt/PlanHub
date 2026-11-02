#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$SourcePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
$source = [IO.Path]::GetFullPath($SourcePath)
if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or [IO.Path]::GetExtension($source) -cne '.cs') { throw 'Specify the SOP-owned identity bridge C# source from the validated release.' }
Assert-NoReparsePoint -Path $source
$compiler = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x 64-bit C# compiler is missing.' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$dll = Join-Path $destination 'SopIdentityBridge.dll'
if ($PSCmdlet.ShouldProcess($dll, 'Compile reviewed SOP post-authentication identity module')) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    & $compiler '/nologo' '/target:library' '/optimize+' (('/out:' + $dll)) '/reference:System.Web.dll' '/reference:System.Web.Extensions.dll' '/reference:System.Configuration.dll' $source
    if ($LASTEXITCODE -ne 0) { throw 'SOP identity module compilation failed.' }
    Write-Output "Compiled SOP identity bridge: $dll"
}
