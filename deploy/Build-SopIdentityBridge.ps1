#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x 64-bit C# compiler is missing.' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$dll = Join-Path $destination 'SopIdentityBridge.dll'
if ($PSCmdlet.ShouldProcess($dll, 'Compile reviewed SOP post-authentication identity module')) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    & $compiler '/nologo' '/target:library' '/optimize+' (('/out:' + $dll)) '/reference:System.Web.dll' '/reference:System.Web.Extensions.dll' '/reference:System.Configuration.dll' (Join-Path $PSScriptRoot 'SopIdentityBridge.cs')
    if ($LASTEXITCODE -ne 0) { throw 'SOP identity module compilation failed.' }
    Write-Output "Compiled SOP identity bridge: $dll"
}
