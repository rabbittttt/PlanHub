#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$PythonPath = 'python'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')
$requirements = (Get-Item -LiteralPath $RequirementsPath -ErrorAction Stop).FullName
if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw 'RequirementsPath must be a file from the independent application.' }
Assert-NoReparsePoint -Path $requirements
$target = Resolve-LocalDeploymentPath -Value $Destination -BasePath (Get-Location).Path -Name 'Destination'
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Use a new directory to avoid mixing dependency versions.' }
$ancestor = Split-Path -Parent $target
while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
Assert-NoReparsePoint -Path $ancestor
Write-Output "Requirements: $requirements"
Write-Output "New offline wheel directory: $target"
Write-Output 'Run on Windows with the same architecture and Python version as the target server. This explicit preparation contacts the configured Python package index.'
if (-not $PSCmdlet.ShouldProcess($target, 'Download binary dependencies and generate SHA256SUMS')) { return }
& $PythonPath '-c' 'import sys; sys.exit(sys.version_info < (3, 11))'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required for the shared workspace dependencies.' }
New-Item -ItemType Directory -Path $target | Out-Null
& $PythonPath '-m' 'pip' '--isolated' 'download' '--disable-pip-version-check' '--only-binary=:all:' '--dest' $target '-r' $requirements
if ($LASTEXITCODE -ne 0) { throw 'Dependency download failed. Preserve the output for diagnosis and retry with a new directory; no checksum manifest was published.' }
$wheels = @(Get-ChildItem -LiteralPath $target -File -Filter '*.whl' | Sort-Object Name)
if (-not $wheels.Count) { throw 'No wheels were downloaded.' }
$lines = @($wheels | ForEach-Object {
    Assert-NoReparsePoint -Path $_.FullName
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
})
[IO.File]::WriteAllLines((Join-Path $target 'SHA256SUMS'), [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Write-Output "Prepared $($wheels.Count) verified binary dependency files. Application source and business data were not copied."
