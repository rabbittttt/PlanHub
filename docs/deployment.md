# Windows 内网部署指南

本文合并门户 IIS 部署、SOP 内网接入及现有应用的发布要求，供目标 Windows 台式机的管理员使用。**当前工作台仍是本机运行，尚未完成面向部门的正式部署。** 本文中的部署命令是后续操作说明，不代表已经修改 IIS、注册任务或改变安全设置。

日常启动与数据位置见[使用、数据与排查](usage.md)；新应用要求见[开发者接入规范](child-app-developer-guide.md)；历史验证结果见[实施与迁移记录](history.md)。开发项目入口见[仓库说明](../README.md)。

目录：

- [1. 部署前确定的内容](#1-部署前确定的内容)
- [2. 发布包与路径规则](#2-发布包与路径规则)
- [3. 从原项目准备发布物](#3-从原项目准备发布物)
- [4. 在目标电脑配置 IIS](#4-在目标电脑配置-iis)
- [5. SOP 专项配置与后台运行](#5-sop-专项配置与后台运行)
- [6. 其他独立动态服务](#6-其他独立动态服务)
- [7. 验收、升级与回退](#7-验收升级与回退)

## 1. 部署前确定的内容

架构保持为 IIS 统一入口、门户静态文件、各自独立的业务应用及同源代理。业务源码继续在各项目维护；门户消费原样发布物或已有服务，不在发布目录维护第二套源码。

| 项目 | 管理员需确定的实际值 |
|---|---|
| 目标电脑 | Windows 版本、持续运行及重启恢复安排 |
| 访问入口 | 内网域名或地址、端口、部门访问范围；当前数据速查完整操作只支持 HTTP，HTTPS 写入限制见第 6 节 |
| IIS 功能 | 静态内容、默认文档、Windows Authentication、管理工具、URL Rewrite、ARR；SOP 另需 ASP.NET 4.x |
| 服务身份 | 运行 Python/其他服务的明确账号、批处理登录及所需目录权限 |
| 业务目录 | 持久数据库、输入、维护表、日志、备份的本地位置及读写归属 |
| 发布版本 | 门户与各业务项目的版本、配置、回退目录和数据备份 |

所有业务公共地址须与门户同协议、同主机、同端口。部门成员使用相同业务功能，不另分只读/可写角色；入口仅供部门成员访问的条件仍需管理员配置并验收。Windows 登录本身不能代替部门成员范围的核对，隐藏菜单也不构成访问控制。

IIS 脚本兼容 Windows PowerShell 5.1；目标服务器检查和安装使用 **64 位管理员 PowerShell**。若执行策略限制脚本，按组织规范使用签名脚本或已审核的本地脚本。示例中的 `powershell -NoProfile -ExecutionPolicy RemoteSigned -File ...` 只影响该次进程，不修改机器策略。

## 2. 发布包与路径规则

发布布局如下；版本目录名按实际发布批次确定：

```text
发布根/
  portal/                 # IIS 网站根目录
  apps/orderiq/           # 独立 IIS Application /orderiq/
  apps/forecast/          # 独立 IIS Application /forecast/
  services/sop/           # SOP 原项目构建的运行产物，不作静态映射
  data/                   # 持久业务数据，不作静态映射
  logs/                   # 服务日志，不作静态映射
  config/iis.json         # 服务器配置，不作静态映射
  config/quicklook.json   # 数据速查服务路径配置，不作静态映射
  deploy/                 # 发布工具
```

**IIS 网站物理路径只指向 `portal/`，不能指向整个发布根。** `portal/config/apps.json` 是公开的导航注册表；它与发布根下存放服务器配置和机密的 `config/` 是不同目录。静态报表若已嵌入真实数据，所有能取得该 HTML 的访问者也能取得其中的数据。

开发机的**门户源码根**包含 `package.json`、`portal/`、`deploy/`，用于收集发布物和生成发布包。目标电脑的**发布根**包含 `portal/`、`apps/`、`services/`、`config/`、`deploy/`，用于执行 IIS 和服务脚本；它不运行 `npm start`，也不要求安装 Node.js。下文第 3 节在源码根执行，第 4–7 节在目标发布根执行，不能混用两个目录。

数据速查原项目单独交付，默认放在发布根同级的 `../数据速查/`，共享输入放在 `../共享数据/`；其源码不复制进门户包。若版本目录嵌套位置不同，在 `config/quicklook.json` 填写正确的 `ProjectRoot`、`SharedDataRoot`，不为套用示例移动业务数据。

| 配置或接口 | 路径解析方式 |
|---|---|
| 开发机文档中的文件路径 | 相对门户根目录；命令从该根执行 |
| `config.example.json` / `sop-iis.example.json` 的 `DeploymentRoot` | 相对配置文件所在目录；模板 `..` 表示发布包根 |
| `ProxySecretPath` | 相对解析后的发布根，且必须位于 `config/` 内 |
| `deploy/sop.example.json` 的数据、来源、规则、计划路径 | 相对发布根；由配置脚本生成运行时绝对路径 |
| 数据速查配置的 `DeploymentRoot` | 相对配置文件目录；配置放在 `config/` 时 `..` 指向发布根 |
| 数据速查配置的 `ProjectRoot`、`SharedDataRoot`、`RuntimePath` | 相对解析后的发布根；原项目数据继续由该原项目管理 |
| SOP 构建器 `--destination`、IIS 物理路径、SOP 网关路径、部分部署脚本参数 | 要求绝对路径；用 `Resolve-Path`、`Join-Path`、`GetFullPath` 从当前环境生成 |

部署配置兼容明确的本地绝对值，但模板和指南不绑定开发机盘符。通用发布根校验拒绝 UNC、仅带盘符的相对路径及磁盘根；服务运行时需绝对路径的地方不能直接传模板相对值。数据、规则和秘密必须在 Web 根之外；现有配置中的自定义业务路径应保留，不因升级覆盖成默认目录。

## 3. 从原项目准备发布物

### 静态网页

订单分析和销量预测先在各自原项目生成并审核最终发布物；本地默认直接读取原项目目录。打包前运行 `npm run prepare:apps -- orderiq forecast` 收集到发布目录；该命令已包含在下一小节的完整流程中，按流程执行一次即可。

该命令只收集公开清单中的原样发布文件，已有目标产物移到 `artifacts/static-backup-...` 保留恢复。来源与哈希记录在忽略的 `apps/<应用ID>.import.json`。订单最终发布入口仍为 `apps/orderiq/index.html`，销量预测保留完整资源目录；旧订单导入器生成的本机覆盖仍可作为打包来源。数据库、原始 Excel、日志、秘密及整套业务源码不入静态目录或公开 Git。

### SOP 发布物与完整包

先在原项目生成并审核订单和预测的完整产物，再在门户源码根执行以下步骤。构建机须与目标电脑的 Windows 架构及 Python 版本一致；`$buildPython` 明确选择已安装原项目依赖的解释器。以下目录名带时间戳，每次构建均使用新目录：

```powershell
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path '.').Path
$buildPython = (Resolve-Path -LiteralPath (Read-Host '构建用 Python 可执行文件路径')).Path
$releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
$sopRelease = Join-Path $sourceRoot ('staging/sop-release-' + $releaseId)
$packagePath = Join-Path $sourceRoot ('staging/DataPlatform-' + $releaseId)
if (-not (Test-Path -LiteralPath './deploy/config.local.json')) {
    Copy-Item -LiteralPath './deploy/config.example.json' -Destination './deploy/config.local.json'
}
# 先编辑 config.local.json：真实站点、HTTP 主机/端口、RequireReverseProxy=true，
# 并保留 orderiq、forecast 两个 Enabled=true 的静态应用。
npm run prepare:apps -- orderiq forecast
if ($LASTEXITCODE -ne 0) { throw '静态发布物收集失败，停止打包。' }
& $buildPython '../SOP维护/scripts/build_release.py' --destination $sopRelease
if ($LASTEXITCODE -ne 0) { throw 'SOP 发布物构建失败，停止打包。' }
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/Install-IisSite.ps1 -ConfigPath ./deploy/config.local.json -PlanOnly
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/New-DeploymentPackage.ps1 -ConfigPath ./deploy/config.local.json -Destination $packagePath -IncludeSop -SopReleasePath $sopRelease -WhatIf
```

此处 `Install-IisSite -PlanOnly` 只检查配置；源码配置中的 `DeploymentRoot: ".."` 指向源码根，不能在开发机去掉 `-PlanOnly` 安装站点。包内 `config/iis.json` 的同一相对值才指向发布根。

SOP 原项目的 `sop-release.json` 记录源提交、工作区状态及每个文件的 SHA256。门户打包校验 manifest、文件集合、哈希和路径，拒绝额外文件、缺少显式来源及路径越界；拒绝重解析点和常见非公开条目。`services/sop` 在发布包中只是被验证的运行产物，不是门户 Git 的业务源码。

### 离线依赖与实际打包

同一 PowerShell 会话中，在门户源码根准备离线依赖。数据速查依赖来自独立原项目的 `requirements.txt`，不复制或改写该清单；两个依赖目录各有自己的 `SHA256SUMS`：

```powershell
./deploy/New-OfflineWheelhouse.ps1 -RequirementsPath (Join-Path $sopRelease 'requirements-intranet.txt') -Destination ./offline/wheels -PythonPath $buildPython -WhatIf
./deploy/New-OfflineWheelhouse.ps1 -RequirementsPath ../数据速查/requirements.txt -Destination ./offline/quicklook-wheels -PythonPath $buildPython -WhatIf
```

离线依赖工具需要联网构建环境，使用 `pip download --only-binary` 下载 wheel 并生成哈希，不安装到当前环境；下载目标默认取当前解释器和系统，因此构建机需与服务器匹配。[pip download 官方说明](https://pip.pypa.io/en/stable/cli/pip_download/)

目的目录必须是新目录；已有离线目录先核对是否与本次 requirements、目标 Python/架构匹配，可复用时跳过下载。需重建时，管理员先将旧目录保留到备份位置，再生成新目录，不删除恢复资料。**打包器仅收集源码根的 `offline/wheels` 和 `offline/quicklook-wheels`**；在其他新目录准备的 wheelhouse，审核后必须连同 `SHA256SUMS` 原样归置到这两个固定输入位置，不能只修改下载 `-Destination` 就直接打包。缺少兼容 wheel 时按原项目要求补齐，不能继续交付空依赖目录。

首次准备、两个目标目录均不存在且计划已审核时，实际下载命令为：

```powershell
./deploy/New-OfflineWheelhouse.ps1 -RequirementsPath (Join-Path $sopRelease 'requirements-intranet.txt') -Destination ./offline/wheels -PythonPath $buildPython
./deploy/New-OfflineWheelhouse.ps1 -RequirementsPath ../数据速查/requirements.txt -Destination ./offline/quicklook-wheels -PythonPath $buildPython
```

审阅静态产物、SOP manifest、依赖及发布计划后，生成完整包：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/New-DeploymentPackage.ps1 -ConfigPath ./deploy/config.local.json -Destination $packagePath -IncludeSop -SopReleasePath $sopRelease
if ($LASTEXITCODE -ne 0) { throw '完整发布包生成失败。' }
```

打包器附带门户、启用的静态产物、SOP 产物、部署脚本、配置模板及已准备的两套离线 wheel。**数据速查源码、数据库、真实 Excel、共享规则、账号及机密不在包中**，需按下一节另行迁移。完整工作台需要 SOP 时不得省略 `-IncludeSop -SopReleasePath`；目的目录存在时打包器拒绝覆盖。

### 另外迁移业务数据与数据速查原项目

迁移前停止相关服务和写入，用 SQLite backup API 导出一致快照，或在确认服务全部停止后备份；不热拷主库而漏掉 WAL。保留迁移前原始数据和恢复备份。将以下内容通过已批准的方式送到目标电脑，均不得放入 `portal/` 或 `apps/`：

| 内容 | 目标位置及配置 |
|---|---|
| SOP `sop.sqlite3`、`sales.json`、`source_settings.json` 及备份 | 按 `deploy/sop.example.json` 配置的数据目录，默认发布根的 `data/sop/` |
| SOP 销售输入、已有计划维护 Excel、真实共享规则 | 默认 `data/sop/input_file/`、`data/sop/SOP计划维护.xlsx`、`config/shared_config.py`；先审核模板中的实际路径 |
| 数据速查独立原仓库的已审核版本及 requirements | 默认发布根同级 `../数据速查/`；核对源提交，保留其 `output_file/` 和 `input_file/`，不复制开发机 `.venv` |
| 数据速查数据库、设置、识别规则、缓存及私有输入 | 原项目的 `output_file/`、`input_file/`；迁移 `warehouse.db`、`workspace.json`、`recognition.json` 等实际文件，保留既有来源设置 |
| 共用 Excel 输入 | 默认发布根同级 `../共享数据/`；按实际目录迁移，不能用空目录代替真实来源 |

数据速查已保存的来源设置优先于 `SharedDataRoot` 默认值。迁移后通过原应用核对“管理数据源”，不能假定设置中的旧绝对路径会被门户修复。S4U 任务仅支持本机数据，网络共享需另行准备有网络访问能力的服务方案。

## 4. 在目标电脑配置 IIS

先将审核后的包、独立数据速查原项目和外置业务数据迁移到目标电脑的新版本目录。安装并核对第 1 节的 IIS 组件；动态服务需要 ARR 的 `enabled=true`、`preserveHostHeader=true` 和足够的代理超时。数据速查预检会检查这些服务器级设置；**管理员需评估现有站点后单独配置，部署脚本不会修改 ARR 全局设置。**

在目标发布根打开 64 位管理员 PowerShell，先复制首次安装配置；已有实际配置只审核，不用模板覆盖：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path '.').Path
$serviceAccount = Read-Host '后台服务账号（DOMAIN\账号或计算机名\账号）'
$pythonPath = (Resolve-Path -LiteralPath (Read-Host '目标电脑已安装的 Python 3.11+ 可执行文件路径')).Path
foreach ($name in @('sop-iis', 'quicklook', 'quicklook-iis')) {
    $destination = Join-Path $deploymentRoot ('config/' + $name + '.json')
    if (-not (Test-Path -LiteralPath $destination)) {
        Copy-Item -LiteralPath (Join-Path $deploymentRoot ('deploy/' + $name + '.example.json')) -Destination $destination
    }
}
```

执行任何服务器变更前，由管理员编辑并交叉核对这些文件：

| 文件 | 必须核对的内容 |
|---|---|
| `config/iis.json` | 真实站点、主机、HTTP 端口、`DeploymentRoot`、两项静态应用和 `RequireReverseProxy: true` |
| `config/sop-iis.json` | 同一站点与公共 Origin、独立 SOP 应用池、回环后端端口、写入开关和秘密路径 |
| `deploy/sop.example.json`（首次生成 SOP 网关） | 实际持久数据、输入、维护表和规则位置；路径不得越出发布根；已有 `config/sop.json` 会保留原数据路径 |
| `config/quicklook.json` | `DeploymentRoot`、独立原项目 `ProjectRoot`、共享输入 `SharedDataRoot`、本机 `RuntimePath` |
| `config/quicklook-iis.json` | 同一站点与 HTTP Origin、固定数据速查回环端口；精确 API、上传上限和最低代理超时由工具固定校验 |

示例域名不能原样上线；三个公共入口配置必须与实际 IIS 绑定一致。`PublicOrigin` 只填协议、主机和非默认端口，不带路径或末尾 `/`（使用默认 80 端口时省略 `:80`）。配置文件相对路径的解析基准见第 2 节。保持站点未启动，先做离线计划和实际服务器只读预检：

```powershell
./deploy/Install-IisSite.ps1 -ConfigPath ./config/iis.json
./deploy/Install-IisSite.ps1 -ConfigPath ./config/iis.json -Apply -WhatIf
```

默认命令只读预检：检查目标文件、必需模块、同名站点/应用池、绑定冲突及 ARR 开关。`-PlanOnly` 只校验配置和打印离线计划，不能代替服务器预检。管理员审核后明确执行以下命令，才创建停止状态的新站点；这一步不会启动业务服务：

```powershell
./deploy/Install-IisSite.ps1 -ConfigPath ./config/iis.json -Apply
```

创建脚本只适用于**新站点**，会拒绝同名站点/应用池；不用于给现有站点追加应用或覆盖升级。它创建无托管 CLR 的新静态应用池、停止状态站点和已启用的静态 Application，开启 Windows 认证、关闭匿名认证，并将认证设置写到 apphost 对应 location。它不切换现有站点，不开启全局 ARR，不配置 DNS、HTTPS 证书、ACL 或防火墙。

模板的 HTTP 端口和空主机名只用于隔离验收；正式入口由管理员填写真实域名和批准的绑定。**当前包含数据速查的完整工作台不能直接以 HTTPS 通过全部写入验收**，原因见第 6 节；若组织要求 HTTPS，先列为原项目阻塞，不改写 Origin 或关闭校验绕过。需要动态代理时将 `RequireReverseProxy` 设为 true；全局 ARR 开关需另行设置，脚本只检查。

管理员需配置以下内容，再手工启动站点：

- 应用池和必要成员的读取权限、业务服务账号的最小必需读写权限；IIS 认证与 NTFS 权限都需验收。
- 部门入口访问范围；门户与直接应用 URL 均受实际 IIS/后端规则约束。
- 新站点物理路径、应用路径、认证、正式绑定；`ServerAutoStart` 初始关闭，验收后按运维安排启用。

子网页必须允许同源 iframe。门户用 `inheritInChildApplications="false"` 隔离默认文档和响应头，因此静态业务网页应建为 **IIS Application**，不能用普通虚拟目录替代。通常最终响应包含 `X-Frame-Options: SAMEORIGIN` 和 CSP `frame-ancestors 'self'`。根应用的代理响应与子应用原有策略也需检查是否重复、冲突。

门户自身 HTML 用 CSP meta 限制脚本、样式与 iframe 来源；`frame-ancestors` 由 HTTP 响应头提供。若子应用返回禁止嵌入的策略，记录阻塞并交给获授权的原项目任务处理，不能在门户剥除安全头或改写页面。纯静态页面不能直接获得 IIS 当前用户名；需要真实操作人时使用经过认证的服务，不信任浏览器自报的身份头或查询参数。

## 5. SOP 专项配置与后台运行

### 可信身份和持久数据

SOP 的 `/sop` 使用独立 .NET 4 Integrated 代理应用、Windows Authentication 和 ARR，保留 `/sop/` 前缀。身份桥接源码来自经过验证的 SOP 发布物 `integration/iis/SopIdentityBridge.cs`，不在门户维护副本。

桥接模块在 Windows 认证后核对用户与 Origin，覆盖代理 key 和身份头；后端再次检查回环来源、key、用户、前缀及 Origin，记录可信操作人。秘密位于 Web 根之外的受保护文件，不写入 URL、前端、命令行或公开 Git。

正常运行使用持久数据库和维护表。服务级 `AllowWrites: true` 与后端 `allow_writes: true` 必须配对；两者同时 false 只表示全服务暂停写入，不是成员角色。不同部门成员应具备相同查看、维护、导入导出能力。独立运行模式不自动启用 IIS 身份协议，本机代理身份也不能充当正式 Windows 登录证明。

### 配置、依赖和任务

第 4 节已复制并核对 `config/sop-iis.json`。后端端口以该文件为准，不与本机预览或其他服务的端口混用；SOP 网关使用模板解析出的持久目录，不使用开发机临时快照。

以下继续在第 4 节同一目标发布根 PowerShell 会话执行，使用已赋值的 `$deploymentRoot`、`$serviceAccount`、`$pythonPath`。换会话时须重新执行第 4 节变量赋值，不能直接复制未定义变量：

```powershell
$deploymentRoot = (Resolve-Path '.').Path
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json -PlanOnly
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json -ServiceAccount $serviceAccount -Apply -WhatIf
./deploy/Install-SopDependencies.ps1 -DeploymentRoot $deploymentRoot -PythonPath $pythonPath -WhatIf
./deploy/Register-SopTask.ps1 -DeploymentRoot $deploymentRoot -ServiceAccount $serviceAccount
```

以上仅为计划、只读预检或 WhatIf。管理员审核模块、权限、数据和离线依赖后，依次执行实际应用；任务注册后仍不启动：

```powershell
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json -ServiceAccount $serviceAccount -Apply
./deploy/Install-SopDependencies.ps1 -DeploymentRoot $deploymentRoot -PythonPath $pythonPath
./deploy/Register-SopTask.ps1 -DeploymentRoot $deploymentRoot -ServiceAccount $serviceAccount -Apply
```

各工具的作用和限制：

| 工具 | 实际写入动作及限制 |
|---|---|
| `Configure-SopProxy.ps1 -Apply` | 创建/更新本工具拥有的 `/sop` 代理应用，生成匹配的 `config/sop-auth.json`、`config/sop.json` 和受保护秘密；要求明确的服务账号。已有无关应用/应用池会被拒绝 |
| `Build-SopIdentityBridge.ps1` | 编译明确指定的、来自原 SOP 发布物的 C# 源码；配置代理时使用，不接受门户旧副本 |
| `Install-SopDependencies.ps1` 去掉 `-WhatIf` | 验证 wheel 哈希并创建 `runtime/sop-venv`，按原 SOP 锁定 requirements 离线安装，不访问包索引；需先准备完整 wheel 和清单 |
| `Register-SopTask.ps1 -Apply` | 注册一个停止状态任务，不自动启动；同名任务已存在时拒绝覆盖 |
| `Start-SopService.ps1` | 使用包内运行环境、受保护配置和实际业务数据以前台进程运行 SOP，日志追加到 `logs/sop/service.log`，供任务计划程序观察退出状态 |

配置脚本将模板中的路径解析成运行时绝对值，并保留已有业务路径；不要将 `deploy/sop.example.json` 直接交给网关。模板相对路径不得越出发布根；秘密必须在 `config/`，数据/规则/输入不得落入 `portal/`、`apps/` 或 `proxy/`。

提供的后台任务采用 S4U，不保存密码，**无法访问网络共享**，因此该方案的数据和输入需在目标电脑本地。若要使用网络共享，需另行设计并批准具备相应网络访问能力的运行身份与服务方案，不能直接套用 S4U。任务支持开机触发、失败重试、单实例和无限运行时间；注册后仍需配置批处理登录权限与本地目录 ACL，再手工启动并验收。

### 从旧 WriteGroups 配置迁移

已有环境先备份配置、产物和数据，重新从唯一 SOP 原项目构建产物及身份桥接模块。移除旧 `WriteGroups`，显式配置服务级 `AllowWrites`；重新生成匹配的 `sop-auth.json` 与 `sop.json` 后再重启。不能只改一个开关或继续使用旧 DLL；旧字段、缺失开关及两端不一致会被拒绝。

## 6. 其他独立动态服务

销量预测为静态发布物，按第 3 节收集后由新站点脚本创建 `/forecast/` 独立 Application。数据速查是独立 Python 服务，**门户发布包附带接入工具和配置模板，不附带它的源码和业务数据**；使用第 3 节迁移的原仓库版本。

### 数据速查的路径、协议与 IIS 边界

`config/quicklook.json` 的默认 `ProjectRoot: "../数据速查"`、`SharedDataRoot: "../共享数据"` 相对发布根解析，`RuntimePath: "runtime/quicklook-venv"` 必须在发布根的 `runtime/` 下。服务直接运行原项目 `server.py`，固定监听 `127.0.0.1:8765`；单改门户配置不能改变原服务端口。私有数据库、来源设置和规则继续保存在原项目 `output_file/`，不重新初始化、覆盖或迁入门户临时目录。

数据速查现有页面资源使用 `/quicklook/` 剥离前缀代理，前端仍使用根 API。专用配置工具只转发现有 11 个精确接口：`/api/catalog`、`/api/table`、`/api/workbooks`、`/api/workbook`、`/api/sheet`、`/api/search`、`/api/raw`、`/api/import`、`/api/sync`、`/api/config`、`/api/recognition`。它不转发其他 `/api/*`，不占用门户管理接口；新应用应使用自己的完整子路径。

这些规则写入门户的 `portal/web.config`，`/quicklook/` 和上述根 API 仍属于门户 IIS Application，**不另建 `/quicklook` 或 `/api` Application/虚拟目录**。工具检查现有路由归属、有效认证、匹配的 HTTP 绑定和 ARR；遇到无关应用、物理路径或规则会拒绝覆盖。普通代理与 SOP 的专属身份桥接不同，不能复用 SOP 密钥或伪造操作人身份。

**当前只支持 HTTP 公共入口的完整操作。** 原项目 `server.py` 对 POST 要求 `Origin` 等于 `http://` 加 `Host`；HTTPS 页面发出的 `https://...` Origin 会被拒绝。因此配置工具拒绝 HTTPS `PublicOrigin`，保留原始 Host、Origin、安全响应头与响应正文，不替换 Origin、不关闭业务校验。需要 HTTPS 时，由另行获授权的数据速查任务先解决原项目兼容性，再验收；当前不能宣称 HTTPS 的导入、同步和设置保存可用。

管理员需在实际有效作用域配置 ARR `enabled=true`、`preserveHostHeader=true` 和至少 **300 秒**超时。专用工具只检查这些值，不改服务器级设置；保留原始 Host 的配置依据见 [Microsoft ARR 说明](https://learn.microsoft.com/en-us/iis/extensions/configuring-application-request-routing-arr/arr-as-generic-proxy-in-hotmail-and-skydrive)。

工具为数据速查上传路径配置请求上限 **269484032 字节**（256 MiB 文件加 1 MiB 请求余量），原服务的单文件上限仍为 256 MiB；不提高其他应用的上传限制。IIS 的 `maxAllowedContentLength` 按字节限制整个请求，依据见 [Microsoft 请求限制参考](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/requestfiltering/requestlimits/)。

### 数据速查配置、依赖和后台任务

继续在第 4 节同一管理员会话中执行，保持站点和相关任务未启动。先检查并审核计划：

```powershell
./deploy/Configure-QuicklookProxy.ps1 -ConfigPath ./config/quicklook-iis.json -PlanOnly
./deploy/Configure-QuicklookProxy.ps1 -ConfigPath ./config/quicklook-iis.json
./deploy/Configure-QuicklookProxy.ps1 -ConfigPath ./config/quicklook-iis.json -Apply -WhatIf
./deploy/Install-QuicklookDependencies.ps1 -ConfigPath ./config/quicklook.json -PythonPath $pythonPath -WhatIf
./deploy/Register-QuicklookTask.ps1 -ConfigPath ./config/quicklook.json -ServiceAccount $serviceAccount
```

`-PlanOnly` 不访问 IIS；不带 `-Apply` 的代理命令执行目标服务器只读预检。管理员审核通过后，执行实际应用和依赖安装：

```powershell
./deploy/Configure-QuicklookProxy.ps1 -ConfigPath ./config/quicklook-iis.json -Apply
./deploy/Install-QuicklookDependencies.ps1 -ConfigPath ./config/quicklook.json -PythonPath $pythonPath
./deploy/Register-QuicklookTask.ps1 -ConfigPath ./config/quicklook.json -ServiceAccount $serviceAccount -Apply
```

| 工具 | 实际行为与限制 |
|---|---|
| `Configure-QuicklookProxy.ps1 -Apply` | 备份门户 `web.config` 至 `config/quicklook-proxy-backups/`，只添加或更新本工具拥有的路由和请求限制；不创建 IIS 子应用，不改认证、ARR 全局设置、ACL 或防火墙 |
| `Install-QuicklookDependencies.ps1` | 默认验证 `offline/quicklook-wheels/SHA256SUMS`，从原项目 requirements 离线创建新运行环境，并执行 `pip check`；不启动业务服务。`RuntimePath` 已存在时拒绝覆盖，应保留旧环境并选新目录 |
| `Install-QuicklookDependencies.ps1 -Online` | 仅明确选择此参数时联网安装原项目 requirements；不能与 `-WheelPath` 同用。目标机无网络时使用默认离线方案 |
| `Register-QuicklookTask.ps1 -Apply` | 注册 `DataPlatform-Quicklook` 停止状态任务，开机触发、单实例及失败重试；同名任务已存在时拒绝覆盖，不自动启动 |
| `Start-QuicklookService.ps1 -ConfigPath ./config/quicklook.json` | 以前台进程运行独立原项目，日志写入发布根 `logs/quicklook/service.out.log`、`service.err.log`；端口被占用时拒绝，不结束已有未知进程 |

后台任务使用 S4U，无保存密码且不能访问网络共享或映射盘。服务账号至少需读取原项目、解释器和共享输入，修改原项目 `output_file/`、允许上传的本机目录及 `logs/quicklook/`；还需批处理登录权限。原项目 `workspace.json` 中已保存的来源也必须逐项核对，不能只检查 `SharedDataRoot`。ACL 与批处理登录由管理员按组织规则单独配置，脚本不自动扩大权限。

`deploy/arr-rules.example.xml` 只演示 `/leads/` 剥离前缀，不是 SOP 或数据速查的即用配置。普通代理与 SOP 的身份桥接不能混用。Node 本地 `integration/apps.json` 不会自动生成 IIS 代理、安装依赖或配置后台服务。

按实际应用协调前缀保留/剥离、资源、Location、表单、Cookie Path、Host/Origin 与身份信任。history 回退只作用于对应业务应用，不设置全站 SPA fallback。需 WebSocket 的应用必须另行配置 IIS WebSocket 并专项验收；当前通用 Node 本地代理不支持 WebSocket upgrade。完成目标环境的页面、接口及持久保存验收后，再将入口设为 ready。

## 7. 验收、升级与回退

### 手工启动与验收

前述 `-Apply` 只创建配置和停止状态任务。管理员确认服务身份、ACL、持久目录和部门入口范围均就绪后，再从目标发布根启动已审核的任务和站点。以下使用注册脚本默认任务名；若注册时指定了 `-TaskName`，应填相同实际名称：

```powershell
$siteName = (Get-Content -LiteralPath ./config/iis.json -Raw -Encoding UTF8 | ConvertFrom-Json).SiteName
$sopTaskName = 'DataPlatform-SOP'
$quicklookTaskName = 'DataPlatform-Quicklook'
Start-ScheduledTask -TaskName $sopTaskName
Start-ScheduledTask -TaskName $quicklookTaskName
Get-ScheduledTask -TaskName $sopTaskName, $quicklookTaskName | Select-Object TaskName, State
Import-Module WebAdministration
Start-Website -Name $siteName
```

检查 `logs/sop/service.log`、`logs/quicklook/service.err.log` 与服务运行状态；任务显示 Running 或端口存在都不能代替 HTTP 和业务验收。原项目服务只监听回环，部门用户统一访问管理员配置的 IIS 公共 Origin，不访问 Python 后端端口。先使用明确的测试数据验收，完成后再按运维安排启用站点随系统启动。

| 检查 | 通过条件 |
|---|---|
| 门户及应用直达 | 认证后页面、配置、资源和接口成功；无匿名或跨前缀旁路 |
| 部门范围与统一能力 | 获准成员均可查看、维护、导入导出并正确留痕；入口外用户不能取得业务数据 |
| SOP 代理校验 | 缺失/伪造身份、错误 key、错误或跨源 Origin 被拒绝；正常成员操作成功 |
| 数据速查代理与来源 | `/quicklook/`、11 个根 API 均受 Windows 认证与部门入口限制；其他根 API 不被转发；正常 HTTP 导入、同步及设置保存成功，伪造 Origin 被原应用拒绝 |
| 数据速查持久与上传 | 已迁移的来源、规则与数据库正确，测试文件导入及同名覆盖提示正常；重启读回一致；检查大文件上限、ARR 超时和失败日志 |
| 静态业务网页 | 订单最终 HTML 和预测完整资源正常，包外源码及原始 Excel 无静态下载路径 |
| iframe 与浏览器 | 同源嵌入、刷新、内部跳转、下载正常，无资源 404、混合内容、跨域或 CSP 冲突 |
| 数据外置 | 数据库、输入、秘密及日志不能通过静态地址下载；服务路径与计划表归属正确 |
| 业务操作 | 使用测试数据验证计划保存、导入导出和冲突处理；停止并重启后读回一致 |
| 运行恢复 | 服务器重启后 IIS 与各服务按运维设置恢复；没有两个服务写同一维护表 |
| 访问与菜单 | 即使隐藏菜单，直接业务 URL 仍受 IIS/后端访问规则约束 |

### 升级与回退

升级前保存当前原项目版本、发布包、有效服务配置、任务定义、门户 `web.config` 及对应业务数据备份。任务与绑定沿用原名称时需管理员审核既有配置，不能把首次安装脚本当作覆盖升级命令；两个注册脚本均拒绝替换同名任务。数据速查更换依赖时选新 `RuntimePath`，保留上一环境；新版本服务不能与旧版本同时写同一数据库。

完整停止前先等待上传和计划保存完成，并停止有关写入。目标发布根下，管理员使用实际站点和任务名停止：

```powershell
Stop-Website -Name $siteName
Stop-ScheduledTask -TaskName $sopTaskName
Stop-ScheduledTask -TaskName $quicklookTaskName
```

核对对应后端进程已退出，再迁移持久数据或切换版本。SOP 与数据速查均需一致的 SQLite 备份；保留匹配的设置、规则、销售数据和计划维护表，不能仅热拷主数据库而漏掉 WAL。不要结束归属不明的端口进程，也不要让新旧服务同时写入。文件归属与日常持久位置见[使用说明](usage.md)。

首次上线保留原站点、产物和配置，验收后再切入口。回退先停止受影响服务、确认数据库版本兼容，再恢复对应应用上一版程序、运行环境和匹配配置；只有明确需要数据恢复时才使用经核对的业务备份，不能用旧发布包覆盖已维护数据。Quicklook 代理可从 `config/quicklook-proxy-backups/` 审核恢复对应的门户 `web.config`；若之后又有其他配置变更，应合并恢复，不能盲目覆盖。不为单应用回退恢复整个 IIS 全局配置，不自动删除站点、目录或恢复备份。恢复后重新执行相关验收。

## 参考依据

- [Microsoft：Windows Authentication](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/authentication/windowsauthentication/)
- [Microsoft：URL Rewrite 与 ARR 反向代理](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing)
- [Microsoft：URL Rewrite 配置参考](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/url-rewrite-module-configuration-reference)
- [Microsoft：配置继承边界](https://techcommunity.microsoft.com/blog/iis-support-blog/how-to-prevent-web-config-files-to-be-overwritten-by-config-files-in-application/297627)
- [Microsoft：ARR 保留原始 Host](https://learn.microsoft.com/en-us/iis/extensions/configuring-application-request-routing-arr/arr-as-generic-proxy-in-hotmail-and-skydrive)
- [Microsoft：请求大小限制](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/requestfiltering/requestlimits/)
- [pip：下载用于离线安装的依赖](https://pip.pypa.io/en/stable/cli/pip_download/)
