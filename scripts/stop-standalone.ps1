#requires -Version 5.1
[CmdletBinding()]
param([switch]$ListOnly, [string]$Root)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Read-Config($path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        return (Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json)
    }
}

function Full-Path($base, $value) {
    [IO.Path]::GetFullPath([IO.Path]::Combine($base, $value))
}

# Read only source locations. Stopping an app does not require its data, release or health endpoint.
function Get-Targets($rootDir) {
    $registry = Read-Config (Join-Path $rootDir 'portal/config/apps.json')
    if (!$registry.groups) { throw '未找到工作台应用注册表。' }
    $defaults = Read-Config (Join-Path $rootDir 'integration/apps.json')
    $local = Read-Config (Join-Path $rootDir 'config.local/apps.json')
    foreach ($group in $registry.groups) {
        foreach ($app in $group.apps) {
            if (!$app.enabled) { continue }
            $id = $app.id
            $base = $defaults.applications.$id
            $override = $local.applications.$id
            $start = $base.start
            if ($override.start) { $start = $override.start }
            $type = $base.type
            if ($override.type) { $type = $override.type }
            $launchers = @()
            $python = $null
            if ($id -eq 'sop') {
                $settings = Read-Config (Join-Path $rootDir 'config.local/sop.json')
                $sopRoot = $env:SOP_SOURCE_ROOT
                if (!$sopRoot) { $sopRoot = $settings.sourceRoot }
                if (!$sopRoot) { $sopRoot = (Read-Config (Join-Path $rootDir 'integration/sop.example.json')).sourceRoot }
                $cwd = Full-Path $rootDir $sopRoot
                $entries = @((Full-Path $cwd 'server.py'))
                $python = $env:SOP_PYTHON_PATH
            } elseif ($type -eq 'static') {
                Write-Host ("{0}：静态入口，无独立应用服务。" -f $app.name)
                continue
            } elseif ($start.cwd -and $start.command -and
                    [IO.Path]::GetFileName($start.command) -match '^pythonw?(\.exe)?$') {
                $cwd = Full-Path $rootDir $start.cwd
                $python = Full-Path $rootDir $start.command
                $script = @($start.args | Where-Object { $_ -match '\.py$' } | Select-Object -First 1)
                if (!$script.Count) { Write-Warning "$id 未登记 Python 网页入口，已跳过。"; continue }
                $standalone = $base.standalone
                if ($override.standalone) { $standalone = $override.standalone }
                $entries = @(Full-Path $cwd $script[0])
                foreach ($alias in $standalone.entries) { $entries += Full-Path $cwd $alias }
                foreach ($launcher in $standalone.launchers) { $launchers += Full-Path $cwd $launcher }
            } else {
                Write-Warning "$id 未登记可识别的本机独立网页入口，已跳过。"
                continue
            }
            [pscustomobject]@{ Name=$app.name; Entries=$entries; Launchers=$launchers; Python=$python }
        }
    }
}

function Get-Ancestry($process, $byId) {
    $seen = @{}
    while ($process.ParentProcessId) {
        $parent = $byId[[int]$process.ParentProcessId]
        if (!$parent -or $parent.CreationDate -gt $process.CreationDate -or $seen.ContainsKey($parent.ProcessId)) { break }
        $seen[$parent.ProcessId] = $true
        $parent
        $process = $parent
    }
}

function Get-RelativeEntry($process, $ancestors, $scriptName, $possible) {
    # Double-clicking a registered CMD starts cmd.exe /c ""absolute path" ".
    # Only trust the launcher directly above the Python/venv pair.
    $launcher = $null
    $exePrefix = '^\s*(?:"[^"]+"|\S+)\s*'
    $arguments = $process.CommandLine -replace $exePrefix, ''
    foreach ($parent in $ancestors) {
        if ($parent.Name -notmatch '^pythonw?\.exe$') { $launcher = $parent; break }
        if (($parent.CommandLine -replace $exePrefix, '') -ne $arguments) { break }
    }
    if ($launcher.Name -eq 'cmd.exe' -and $launcher.CommandLine -match '(?i)\s/c\s+(.+)$') {
        $batch = $Matches[1].Trim([char[]]' "')
        foreach ($target in $possible) {
            if ($target.Launchers -contains $batch) {
                return Full-Path ([IO.Path]::GetDirectoryName($batch)) $scriptName
            }
        }
    }
    # An interactive shell need not retain the CMD name. If available, psutil can
    # resolve its child's real working directory. Never guess cwd from the port.
    foreach ($python in @($possible.Python | Where-Object { $_ } | Sort-Object -Unique)) {
        if (!(Test-Path -LiteralPath $python -PathType Leaf)) { continue }
        $query = @'
import sys
try:
    import psutil
    print(psutil.Process(int(sys.argv[1])).cwd())
except (ImportError, OSError):
    sys.exit(2)
except psutil.Error:
    sys.exit(2)
'@
        # Pass the code via stdin so Windows PowerShell preserves Python quotes.
        $dir = $query | & $python -I -B -X utf8 - $process.ProcessId
        if ($LASTEXITCODE -eq 0 -and $dir -and [IO.Path]::IsPathRooted($dir)) {
            return Full-Path $dir $scriptName
        }
    }
}

try {
    if (!$Root) { $Root = Split-Path -Parent $PSScriptRoot }
    $Root = (Resolve-Path -LiteralPath $Root).Path
    $targets = @(Get-Targets $Root)
    $byId = @{}
    foreach ($item in Get-CimInstance -ClassName Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate,CommandLine) {
        $byId[[int]$item.ProcessId] = $item
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique)
    $affected = 0
    $uncertain = 0
    foreach ($processId in $listeners) {
        $process = $byId[[int]$processId]
        if ($process.Name -notmatch '^pythonw?\.exe$') { continue }
        if (!$process.CommandLine) {
            Write-Warning "无法读取 Python 监听进程 PID $processId 的身份，已跳过。"
            $uncertain++; continue
        }
        # Match the interpreter's script argument, never a filename later in -c,
        # -m, a business argument, a compile command or an unrelated program.
        $scriptArg = '^\s*(?:"[^"]+"|\S+)\s+(?:(?:-[bBEiIOPqsSuvx]+|-X\s*[^\s"]+|-W\s*[^\s"]+)\s+)*(?:"([^"]+\.py)"|([^\s"]+\.py))(?=\s|$)'
        if ($process.CommandLine -notmatch $scriptArg) { continue }
        $entry = $Matches[1]
        if (!$entry) { $entry = $Matches[2] }
        $possible = @($targets | Where-Object {
            @($_.Entries | ForEach-Object { [IO.Path]::GetFileName($_) }) -contains [IO.Path]::GetFileName($entry)
        })
        if (!$possible.Count) { continue }
        $ancestors = @(Get-Ancestry $process $byId)
        $owner = $ancestors | Where-Object { $_.Name -notmatch '^pythonw?\.exe$' } | Select-Object -First 1
        if ($owner.Name -eq 'node.exe' -or $process.CommandLine -match '(?:\s|")--(?:gateway-config|sync-worker)(?:[="\s]|$)') { continue }
        if ($entry -match '^(?:[a-zA-Z]:[\\/]|\\\\)') {
            $absolute = [IO.Path]::GetFullPath($entry)
        } else {
            $absolute = Get-RelativeEntry $process $ancestors $entry $possible
            if (!$absolute) {
                Write-Warning "PID $processId 使用相对入口 $entry，无法核实项目目录，已保留。"
                $uncertain++; continue
            }
        }
        $matchesTarget = @($possible | Where-Object { $_.Entries -contains $absolute })
        if (!$matchesTarget.Count) { continue }

        # Pin a live process handle, check creation time against the inventory,
        # and terminate only the listener (not its shell, browser, or PID tree).
        $live = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (!$live) { continue }
        try {
            $null = $live.Handle
            if ($live.HasExited) { continue }
            if ([math]::Abs(($live.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) {
                Write-Warning "PID $processId 已变化，已跳过。"; $uncertain++; continue
            }
            $name = $matchesTarget[0].Name
            if ($ListOnly) { Write-Host "可停止：$name（PID $processId）" }
            else {
                $live.Kill()
                if (!$live.WaitForExit(5000)) { throw '等待退出超时' }
                Write-Host "已停止：$name（PID $processId）"
            }
            $affected++
        } catch {
            if (!$live.HasExited) { Write-Warning "PID $processId 未能完成操作：$_"; $uncertain++ }
        } finally { $live.Dispose() }
    }
    if (!$affected) { Write-Host '未发现可确认归属的独立网页服务。' }
    if ($uncertain) { exit 2 }
    exit 0
} catch {
    Write-Error -ErrorAction Continue "检查独立网页时失败：$_"
    exit 1
}
