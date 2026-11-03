[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)] [string] $SourceHtml,
    [string] $ProjectRoot
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$source = Get-Item -LiteralPath $SourceHtml
if ($source.PSIsContainer -or $source.Extension -notin @('.html', '.htm') -or $source.Length -eq 0) {
    throw 'SourceHtml 必须是非空的发布 HTML 文件。'
}
$project = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ProjectRoot).Path).TrimEnd("\")
$registryPath = Join-Path $project 'portal\config\apps.json'
$registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$orderApps = @($registry.groups | ForEach-Object { $_.apps } | Where-Object { $_.id -eq 'orderiq' })
if ($orderApps.Count -ne 1 -or $orderApps[0].url -ne '/orderiq/') { throw '注册表必须恰好包含一个路径为 /orderiq/ 的 orderiq 应用。' }
$appDirectory = [IO.Path]::GetFullPath((Join-Path $project 'apps\orderiq'))
$target = Join-Path $appDirectory 'index.html'
if (-not $appDirectory.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '目标目录超出项目。' }
if ($source.FullName -eq $target) { throw '来源已是目标文件，请指定外部生成的发布 HTML。' }
foreach ($directory in @((Join-Path $project 'apps'), $appDirectory, (Join-Path $project 'portal'), (Join-Path $project 'portal\config'))) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "不允许通过重解析目录发布：$directory" }
}
if (-not $PSCmdlet.ShouldProcess($target, '导入 OrderIQ 发布 HTML，并更新本地应用注册状态')) { return }
New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
$metadataPath = Join-Path $project 'apps\orderiq.import.json'
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$sourceStream = [IO.File]::OpenRead($source.FullName)
try {
    $sourceHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($sourceStream)).Replace('-', '').ToLowerInvariant()
} finally {
    $sourceStream.Dispose()
    $hashAlgorithm.Dispose()
}
$metadata = [ordered]@{
    importedAt = [DateTime]::UtcNow.ToString('o')
    sourceFileName = $source.Name
    sourceFileModifiedAt = $source.LastWriteTimeUtc.ToString('o')
    sourceSha256 = $sourceHash
    dataUpdatedAt = $null
    note = 'sourceFileModifiedAt 是源文件修改时间；不能据此推断业务数据更新时间。门户数据更新时间保持原配置。'
}
$orderApps[0].status = 'ready'
$orderApps[0].enabled = $true
$suffix = [Guid]::NewGuid().ToString('N')
$stagedHtml = Join-Path $appDirectory ".import-$suffix.tmp"
$stagedRegistry = Join-Path $project "portal\config\.apps-$suffix.tmp"
$stagedMetadata = Join-Path $project "apps\.metadata-$suffix.tmp"
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
    Copy-Item -LiteralPath $source.FullName -Destination $stagedHtml
    [IO.File]::WriteAllText($stagedRegistry, ($registry | ConvertTo-Json -Depth 20), $utf8)
    [IO.File]::WriteAllText($stagedMetadata, ($metadata | ConvertTo-Json -Depth 5), $utf8)
    Move-Item -LiteralPath $stagedHtml -Destination $target -Force
    Move-Item -LiteralPath $stagedMetadata -Destination $metadataPath -Force
    Move-Item -LiteralPath $stagedRegistry -Destination $registryPath -Force
} finally {
    foreach ($temporary in @($stagedHtml, $stagedRegistry, $stagedMetadata)) {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Output "OrderIQ 已导入：$target"
Write-Output '请运行 npm run check 与 npm test；源项目及源文件未修改。'
