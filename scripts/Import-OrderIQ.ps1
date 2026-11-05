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
$localConfigDirectory = Join-Path $project 'config.local'
$localConfigPath = Join-Path $localConfigDirectory 'apps.json'
if (-not $appDirectory.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '目标目录超出项目。' }
if ($source.FullName -eq $target) { throw '来源已是目标文件，请指定外部生成的发布 HTML。' }
foreach ($directory in @((Join-Path $project 'apps'), $appDirectory, (Join-Path $project 'portal'), (Join-Path $project 'portal\config'), $localConfigDirectory)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "不允许通过重解析目录发布：$directory" }
}
# Validate the private override before touching a usable report or registry.
# ConvertFrom-Json returns PSCustomObject on Windows PowerShell 5.1.
$localConfig = [pscustomobject]@{ applications = [pscustomobject]@{} }
if (Test-Path -LiteralPath $localConfigPath) {
    if (-not (Test-Path -LiteralPath $localConfigPath -PathType Leaf)) { throw 'config.local/apps.json 必须是 JSON 文件；未开始导入。' }
    try {
        $localConfigText = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8
        # PS5.1 can unwrap a singleton top-level array; require the JSON object token.
        if (-not $localConfigText.TrimStart().StartsWith('{')) { throw '本机配置必须为 JSON 对象' }
        $localConfig = $localConfigText | ConvertFrom-Json
    }
    catch { throw 'config.local/apps.json 不是有效 JSON；请先修复配置，现有发布物未修改。' }
    if ($null -eq $localConfig -or $localConfig -isnot [pscustomobject]) { throw 'config.local/apps.json 必须为对象；现有发布物未修改。' }
}
$applicationProperty = @($localConfig.PSObject.Properties | Where-Object { $_.Name -ceq 'applications' })
if ($applicationProperty.Count -eq 0) {
    if (@($localConfig.PSObject.Properties | Where-Object { $_.Name -ieq 'applications' }).Count) { throw '本机配置字段必须准确命名为 applications；现有发布物未修改。' }
    $localConfig | Add-Member -NotePropertyName 'applications' -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $localConfig.applications -or $localConfig.applications -isnot [pscustomobject]) { throw '本机配置 applications 必须为对象；现有发布物未修改。' }
$orderProperty = @($localConfig.applications.PSObject.Properties | Where-Object { $_.Name -ceq 'orderiq' })
if ($orderProperty.Count -eq 0) {
    if (@($localConfig.applications.PSObject.Properties | Where-Object { $_.Name -ieq 'orderiq' }).Count) { throw '订单应用字段必须准确命名为 orderiq；现有发布物未修改。' }
    $localConfig.applications | Add-Member -NotePropertyName 'orderiq' -NotePropertyValue ([pscustomobject]@{})
}
$orderOverride = $localConfig.applications.orderiq
if ($null -eq $orderOverride -or $orderOverride -isnot [pscustomobject]) { throw '本机配置 orderiq 必须为对象；现有发布物未修改。' }
if ($null -ne $orderOverride.PSObject.Properties['type'] -and $orderOverride.type -cne 'static') { throw 'OrderIQ 导入只适用于静态接入；请先核对本机 orderiq.type，现有发布物未修改。' }
$orderOverride | Add-Member -NotePropertyName 'root' -NotePropertyValue 'apps/orderiq' -Force
$orderOverride | Add-Member -NotePropertyName 'entry' -NotePropertyValue 'index.html' -Force
$orderOverride | Add-Member -NotePropertyName 'publicPaths' -NotePropertyValue @('index.html') -Force
# Serialize now as well, so malformed/unsupported configuration cannot be
# discovered only after a previous usable report has already been replaced.
$localConfigJson = $localConfig | ConvertTo-Json -Depth 100
if (-not $PSCmdlet.ShouldProcess($target, '导入 OrderIQ 发布 HTML，并切换本机订单入口到该发布物')) { return }
New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $localConfigDirectory -Force | Out-Null
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
$stagedLocalConfig = Join-Path $localConfigDirectory ".apps-$suffix.tmp"
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
    Copy-Item -LiteralPath $source.FullName -Destination $stagedHtml
    [IO.File]::WriteAllText($stagedRegistry, ($registry | ConvertTo-Json -Depth 20), $utf8)
    [IO.File]::WriteAllText($stagedMetadata, ($metadata | ConvertTo-Json -Depth 5), $utf8)
    [IO.File]::WriteAllText($stagedLocalConfig, $localConfigJson, $utf8)
    Move-Item -LiteralPath $stagedHtml -Destination $target -Force
    Move-Item -LiteralPath $stagedMetadata -Destination $metadataPath -Force
    Move-Item -LiteralPath $stagedRegistry -Destination $registryPath -Force
    Move-Item -LiteralPath $stagedLocalConfig -Destination $localConfigPath -Force
} finally {
    foreach ($temporary in @($stagedHtml, $stagedRegistry, $stagedMetadata, $stagedLocalConfig)) {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Output "OrderIQ 已导入：$target"
Write-Output '本机 orderiq 接入已切换为 apps/orderiq/index.html，其他应用配置保留。'
Write-Output '请完整停止并重启门户以应用接入配置，再运行 npm run check 与 npm test；源项目及源文件未修改。'
