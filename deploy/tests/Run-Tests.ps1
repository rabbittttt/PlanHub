#requires -Version 5.1
$ErrorActionPreference = 'Stop'
# npm launched from PowerShell 7 may pass its own module search order to Windows PowerShell.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
foreach ($test in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Test-*.ps1' -File | Sort-Object Name)) {
    Write-Host $test.Name
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $test.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
