#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
$source=Join-Path $PSScriptRoot 'TrustedIdentityBridge.cs'
Assert-NoReparsePoint -Path $source
$compiler=Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not(Test-Path -LiteralPath $compiler -PathType Leaf)){throw '.NET Framework 4.x 64-bit C# compiler is required.'}
$destination=[IO.Path]::GetFullPath($OutputDirectory)
$dll=Join-Path $destination 'PlanHub.TrustedIdentityBridge.dll'
if($PSCmdlet.ShouldProcess($dll,'Compile the generic Windows identity module')){
    New-Item -ItemType Directory -Path $destination -Force|Out-Null
    Assert-NoReparsePoint -Path $destination
    & $compiler /nologo /target:library /optimize+ ('/out:'+$dll) /reference:System.Web.dll /reference:System.Web.Extensions.dll /reference:System.Configuration.dll $source
    if($LASTEXITCODE -ne 0){throw 'Trusted identity module compilation failed.'}
    Write-Output ('Compiled trusted identity bridge: '+$dll)
}
