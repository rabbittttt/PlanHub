#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RuntimeConfig)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Runtime.Release.ps1')
$runtime = Get-Content -LiteralPath $RuntimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$release = Assert-AppRelease (Split-Path -Parent $runtime.payload)
if ($release.Manifest.appId -cne $runtime.appId -or $release.Manifest.version -cne $runtime.version) { throw 'Active service and release manifest differ.' }
if ($runtime.appId -ceq 'sop') {
    Assert-SopRuntimeConsistency -Root ([string]$runtime.root) -Definition $runtime.definition -RequireInitialized
}
if ($null -ne (Get-Setting $runtime.definition 'identityProxy')) { Assert-IdentityProxyConsistency -Root ([string]$runtime.root) -Id ([string]$runtime.appId) -Definition $runtime.definition -RequireInitialized }
$command = Resolve-LocalDeploymentPath $runtime.definition.command $runtime.root 'command'
$runtime.dataDirectory = Resolve-LocalDeploymentPath $runtime.dataDirectory $runtime.root 'dataDirectory'
Assert-PrivateRuntimePath $runtime.root $runtime.dataDirectory 'dataDirectory'
Assert-PrivateRuntimePath $runtime.root $command 'runtime command'
if (-not (Test-Path -LiteralPath $runtime.dataDirectory -PathType Container)) { throw 'Persistent data directory is missing. Restore its configured path before starting the service.' }
if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { throw 'Runtime command is missing. Prepare the configured interpreter before starting the service.' }
$secrets=Get-Setting $runtime.definition 'secretEnvironmentFiles' ([pscustomobject]@{})
$secretPaths=@{}
foreach ($item in $secrets.PSObject.Properties) {
    $secretPath=Resolve-LocalDeploymentPath $item.Value $runtime.root 'secret file'
    Assert-PrivateRuntimePath $runtime.root $secretPath 'secret file'
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) { throw 'A configured secret file is missing. No service was started.' }
    $secretPaths[$item.Name]=$secretPath
}
$changed=@{}
try {
    foreach ($item in $runtime.definition.environment.PSObject.Properties) {
        if (-not $changed.ContainsKey($item.Name)) { $changed[$item.Name]=[Environment]::GetEnvironmentVariable($item.Name,'Process') }
        [Environment]::SetEnvironmentVariable($item.Name,(Expand-RunValue $item.Value $runtime),'Process')
    }
    foreach ($item in $secrets.PSObject.Properties) {
        if (-not $changed.ContainsKey($item.Name)) { $changed[$item.Name]=[Environment]::GetEnvironmentVariable($item.Name,'Process') }
        [Environment]::SetEnvironmentVariable($item.Name,([IO.File]::ReadAllText($secretPaths[$item.Name]).Trim()),'Process')
    }
    $arguments=@($runtime.definition.arguments | ForEach-Object { Expand-RunValue $_ $runtime })
    $logRoot=Join-Path $runtime.root ('logs\'+$runtime.appId)
    Assert-LocalPath $logRoot
    $logPath=Join-Path $logRoot 'service.log'
    Assert-LocalPath $logPath
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Push-Location -LiteralPath $runtime.payload
    try {
        # Windows PowerShell 5.1 turns native stderr (including normal Python
        # request logs) into NativeCommandError. Keep recording that stream,
        # then use the actual native exit code as the service failure signal.
        # A launch/redirection failure must not reuse a previous success code.
        # Native commands update the global value; a script-local variable would
        # hide the exit code when this launcher is invoked by another script.
        $global:LASTEXITCODE=$null
        $preference=$ErrorActionPreference
        try {
            $ErrorActionPreference='Continue'
            & $command @arguments *>> $logPath
            $exitCode=$global:LASTEXITCODE
        } finally { $ErrorActionPreference=$preference }
        if ($null -eq $exitCode) { throw "Service did not report an exit code. Check the interpreter, permissions and log path: $logRoot" }
        if ($exitCode -ne 0) { throw "Service exited with code $exitCode. See $logRoot" }
    } finally { Pop-Location }
} finally {
    foreach ($name in $changed.Keys) { [Environment]::SetEnvironmentVariable($name,$changed[$name],'Process') }
}
