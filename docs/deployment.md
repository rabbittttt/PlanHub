# 内网发布与部署

A 电脑维护代码和构建；B 电脑给部门同事提供服务。发布使用内网传包和本机工具，外部平台与 Jenkins 均非必需。

## 日常操作

| 需要做什么 | A 开发电脑 | B 部署电脑 |
|---|---|---|
| 新增网页 | 接入新网页.bat 登记，再发布应用 | 首次补应用运行配置，再部署收到的包 |
| 更新程序 | 发布应用.bat 选择应用、生成并发送 | 部署新版本.bat 核对并安装 |
| 更新数据 | 上传或同步到约定来源 | 使用业务网页原有刷新、保存或导入功能 |

Git 推送、发送成功和实际上线是三件事。发布前等待保存、上传及后台写入完成；单应用升级仅停止该服务。A 关闭后，B 应继续工作。

发布菜单也能发送已有包，便于重试。公司已允许 WinRM 时可配置远程发布；工具不会启用它或保存密码。未配置远程通道就由 B 本机执行安装。

## 配置只填一次

| 配置位置 | 维护内容 |
|---|---|
| A：integration/apps.json，可被 config.local/apps.json 覆盖 | 本地服务 target、启动契约；{port}/{host} 从 target 派生，{basePath} 从应用 ID 派生 |
| A：config.local/publish.json | 构建命令或 releasePath、收件目录；build.cwd 省略时使用 sourceRoot |
| B：config.local/deployment.json | 正式环境的唯一运行配置，首次建站、SOP 初始化和后续发布共用 |

B 首次从 deploy/deployment.example.json 复制配置，填写：

- deploymentRoot：正式根目录，相对该配置文件所在目录解析。
- siteName、publicOrigin：站点名和部门访问地址（协议、主机、非默认端口），公共地址仅填一次。
- sharedDirectory：相对正式根的共享数据目录，默认 shared。
- serviceAccount：默认服务账号；应用可显式设置自己的账号。
- 每应用 port、command、dataDirectory：后端端口、B 的解释器及持久目录。
- startupTimeoutSeconds：启动健康检查等待时间，默认 60 秒，范围 1–600；应用可单独覆盖，用于慢机器的服务启动。业务数据首次生成另按应用状态验收。

模板的 `http://localhost:8080` 仅用于本机测试，正式使用须改成部门电脑能够访问的 B 电脑域名或地址；`MACHINE\PlanHubService` 须替换为 B 上实际存在的专用本机或域账号。账号、端口、解释器和数据路径都由 B 管理员确认，不能原样沿用占位值。

模板的地址、前缀和数据来源采用占位符：{publicOrigin}、{publicHost}、{basePath}、{shared}。版本切换时再解析 {payload}、{data}、{port}。原始 Excel、数据库、密钥和机器配置均放版本目录外。

```text
PlanHub部署/
  releases/应用ID/版本/  固定版本程序
  data/应用ID/          数据库、设置及运行结果
  shared/               共同业务输入
  runtime/应用ID/       Python 及依赖
  config/               SOP 网关、身份及密钥
  proxy/                IIS 应用代理
  state/、logs/         发布记录与服务日志
```

本地与正式环境可使用不同端口；同一环境内由门户的一处配置同时决定启动和代理，不跟随子项目的默认端口。订单分析门户默认 8767。

A 本机联调可双击 `启动本地门户.cmd` 后在后台运行，或用 `npm start` 保持前台；启动窗口、停止入口和日志位置见[项目首页](../README.md)。B 按下方正式发布流程运行固定版本。

## 首次部署

### 1. A 生成引导包

准备 Node.js 20+、各原项目和它们的 Python 依赖。从门户根运行；项目不在默认同级目录时，先更新实际配置。

```powershell
$ErrorActionPreference = 'Stop'
$firstVersion = Get-Date -Format 'yyyyMMdd-HHmmss'
$sopRelease = Join-Path (Get-Location).Path ('staging/sop-first-' + $firstVersion)
$firstPackage = Join-Path (Get-Location).Path ('staging/first-install-' + $firstVersion)
npm run prepare:apps -- leads
if ($LASTEXITCODE -ne 0) { throw '静态网页收集失败。' }
& '../.venv/Scripts/python.exe' -B '../SOP维护/scripts/build_release.py' --destination $sopRelease
if ($LASTEXITCODE -ne 0) { throw 'SOP 原格式发布物构建失败。' }
& ./deploy/New-DeploymentPackage.ps1 -ConfigPath ./deploy/config.example.json -Destination $firstPackage -IncludeSop -SopReleasePath $sopRelease
```

订单分析首次发布或前端模板修改后，先在订单原项目完成一次成功生成，再打包。package_release.py 要求 output_file/runtime 中已有 current.json、index.html、web-build.json，且前端哈希匹配当前源码；门户不会自动替业务项目生成数据。默认同级布局可从门户根执行：

```powershell
& '../.venv/Scripts/python.exe' -B '../订单分析/scripts/generate_html/main.py' --input '../共享数据/订单汇总' --no-open
if ($LASTEXITCODE -ne 0) { throw '订单生成失败，请先查看原项目日志。' }
```

输入不在默认共享目录时，使用原项目已确认的实际输入；若生成时 --output 指向自定义 HTML 文件，打包器的 --runtime 应指向该 HTML 父目录下的 runtime/，不能填 HTML 文件本身。不要把 B 首次可自动生成数据批次，误认为 A 打包前无需生成前端。

A 随后用发布应用.bat 为 planhub、leads、orderiq、forecast、quicklook、sop、vehicle-config 分别生成并发送包，先不要激活。将 B 收到的包保留在收件目录；B 下一步从 payload/requirements.txt 准备依赖，因此无需业务源码。

将 first-install 目录完整传到 B 的正式根。它包含门户、静态样例及 SOP 首次身份接入所需的原格式 services/sop。订单、预测、速查和车型配置显示 EXTERNAL，随后分别发布；引导包不加 RequireComplete。引导包中的旧 iis.json 仅供兼容，新流程使用统一部署配置。

B 另保留工具目录，含完整 deploy/、config.local/ 和部署新版本.bat。工具目录与正式根分开维护。

**B 的部署工具须与 A 本次使用的工具成套同步。** 将 A 已验证版本的完整 `deploy/`（包含 `.ps1`、`.cs`、模板等）与根目录 `部署新版本.bat` 一起交付到 B 工具目录，不能只复制主安装脚本。车型配置身份接入需要同时包含 `Configure-IdentityProxy.ps1`、`Identity.Proxy.ps1`、`Build-IdentityBridge.ps1`、`TrustedIdentityBridge.cs`；SOP 及通用发布工具的其余依赖也保留在该目录。B 自己的 `config.local/` 单独保存，更新工具时保留原本机设置。

`planhub` 应用发布包只更新门户页面，不更新 B 工具目录。Git 同步也只取得已提交并推送的文件；不要把本机尚未提交的新工具视为已送到 A、B 或 Jenkins。文件交付时核对整套工具版本。已注册任务会引用 B 工具目录中的启动脚本，目录使用稳定路径；不要移动或删除任务仍在引用的工具目录。B 不需要各业务开发仓库，业务程序由对应应用发布包交付。

### 离线依赖也要单独交付

在有公司允许的软件包来源、且 Windows 架构和 Python 版本与 B 一致的 A 或依赖准备电脑上，对每个动态应用的本次发布包准备依赖。示例从门户根执行；选择包含 `app-release.json` 和 `payload/` 的动态包，目标目录必须不存在：

```powershell
$ErrorActionPreference = 'Stop'
$dependencyPackage = (Resolve-Path -LiteralPath (Read-Host '输入待交付的动态应用版本包目录')).ProviderPath
$dependencyManifest = Get-Content -LiteralPath (Join-Path $dependencyPackage 'app-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$wheelPython = (Resolve-Path -LiteralPath (Read-Host '输入与 B 版本及架构一致的 Python 可执行文件路径')).ProviderPath
$wheelOutput = Join-Path (Get-Location).Path ('staging/wheels-' + $dependencyManifest.appId + '-' + $dependencyManifest.version)
./deploy/New-OfflineWheelhouse.ps1 -RequirementsPath (Join-Path $dependencyPackage 'payload/requirements.txt') -Destination $wheelOutput -PythonPath $wheelPython
```

对 orderiq、forecast、quicklook、sop、vehicle-config 分别核对并准备；静态 leads 和门户不需要 Python 依赖。尤其数据速查还需要 pandas、streamlit、plotly 等，不能假定 SOP 的 wheel 足够。工具只下载 wheel 并生成 `SHA256SUMS`，不安装业务依赖；已存在的输出目录不会覆盖。

将每个已核对的 wheel 目录连同 `SHA256SUMS` **另行完整传到 B 的本机目录**，记录它与应用版本、Python 版本及架构的对应关系。应用包的发送菜单不发送这些目录；引导包仅可能附带 A 已准备的部分 wheel，也不证明全部应用依赖齐全。B 安装时使用实际收到的目录，不假定工具目录下已有 `offline/wheels`。同一应用需要重建时保留旧目录并另选新目录。

### 2. B 准备运行环境和数据

在 B 工具目录创建 config.local/deployment.json，按前节填写。先收到 A 发来的全部程序包、同版部署工具和各应用离线依赖，再按各包 payload/requirements.txt 建立对应 Python 环境；SOP 首次引导内也有 services/sop/requirements.txt。不要复制 A 的虚拟环境。

以下从 B 工具根执行，对每个动态包分别运行。运行环境位置读取统一配置的 `command`，示例适用于模板中的 `runtime/应用ID/Scripts/python.exe` 虚拟环境布局。先核对所选 wheel 对应当前应用和 B 的 Python，并按随目录交付的 `SHA256SUMS` 核对文件：

```powershell
$ErrorActionPreference = 'Stop'
. ./deploy/Environment.Config.ps1
$settings = Read-RuntimeSettings './config.local/deployment.json'
$receivedPackage = (Resolve-Path -LiteralPath (Read-Host '输入收到的动态应用版本包目录')).ProviderPath
$receivedManifest = Get-Content -LiteralPath (Join-Path $receivedPackage 'app-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$binding = Get-Setting $settings.Config.applications $receivedManifest.appId
if ($null -eq $binding -or $binding.kind -ne 'service') { throw '请选择已登记的动态应用发布包。' }
$wheelDirectory = (Resolve-Path -LiteralPath (Read-Host '输入 B 实际收到、对应此应用的 wheel 目录')).ProviderPath
$basePython = (Resolve-Path -LiteralPath (Read-Host '输入 B 已安装的 Python 可执行文件路径')).ProviderPath
$runtimePython = Resolve-EnvironmentPath $binding.command $settings.Root 'command'
$venv = Split-Path -Parent (Split-Path -Parent $runtimePython)
if (Test-Path -LiteralPath $venv) { throw '该环境已存在，请先核对或选择新的环境目录。' }
& $basePython -m venv $venv
if ($LASTEXITCODE -ne 0) { throw 'Python 环境创建失败。' }
& $runtimePython -m pip --isolated install --no-index --find-links $wheelDirectory -r (Join-Path $receivedPackage 'payload/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '离线依赖安装失败。' }
& $runtimePython -m pip check
if ($LASTEXITCODE -ne 0) { throw '依赖一致性检查失败。' }
```

`$basePython` 应为 B 已安装且符合原项目要求、与 wheel 匹配的版本。已有运行环境先核对，不覆盖；需要新依赖版本时在统一配置中选择新环境的 `command`，再创建该环境。若使用其他运行环境布局，按管理员已审核的路径准备，不套用上述虚拟环境目录推导。

创建模板指定的 data/orderiq、data/forecast、data/quicklook、data/sop 及 sharedDirectory 下的车型配置持久目录；首次发布前工具会检查这些目录和解释器文件已存在。已有数据按原项目流程停服备份后迁移，发布包不迁移业务数据。

- 订单：输入默认 {shared}/订单汇总；批次和批注在 data/orderiq，由 --input/--data-dir/--state-dir 显式传入；--web-dir 使用当前发布包的 web。
- 销量预测：SHARED_DATA_ROOT 使用 {shared}，--data-dir 使用 data/forecast。只读原始输入，按原规则更新订单汇总中的销量汇总派生文件，服务账号需能写该文件。
- 数据速查：数据在 data/quicklook；SHARED_DATA_ROOT 选择共享扫描根，DATA_QUICKLOOK_SOURCE_BASE 解析历史工作区相对来源，两者含义不同，迁移后核对 workspace.json。
- 车型配置：数据在 {shared}/车型配置，草稿、已发布快照及历史记录由同一外置数据库管理。迁移时停服备份整个目录；业务报表当前尚未消费这些配置，不会因为这里发布就自动改变订单或 SOP。
- SOP：数据库在 data/sop，真实共享规则放 config/shared_config.py，来源和旧维护表兼容路径由 sop.gatewayPaths 配置。计划从网页保存或前台 Excel 导入，不再自动同步服务器旧维护表。已有业务路径应在统一配置中明确保留。

通用任务使用 S4U，不保存密码，不能访问网络共享或映射盘。业务数据、输入及运行环境应在 B 本机；需要直接访问网络来源时，另用公司允许的运行身份方案。服务账号需有批处理登录权限、读取 B 工具和版本程序/运行环境的权限，以及修改本应用持久数据、日志和确需写入的来源文件的权限；IIS 应用池另需读取页面和代理文件。外置密钥由身份初始化工具限制为相关应用池及服务账号读取，不向普通成员开放。账号与 ACL 由 B 管理员审核配置。

### 3. B 创建站点并初始化 SOP

先由 B 管理员准备 IIS、Windows Authentication、URL Rewrite/ARR、ASP.NET 4.x 和 .NET Framework。动态代理要求 ARR enabled、preserveHostHeader；这些全局设置由管理员配置。

从 B 工具根目录，在 64 位管理员 Windows PowerShell 中执行：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentConfig = './config.local/deployment.json'
./deploy/Install-IisSite.ps1 -DeploymentConfigPath $deploymentConfig -PlanOnly
# 核对生成的站点、绑定和目录后，在 B 执行
./deploy/Install-IisSite.ps1 -DeploymentConfigPath $deploymentConfig -Apply
./deploy/Configure-SopProxy.ps1 -DeploymentConfigPath $deploymentConfig -PlanOnly
# 核对端口、账号及数据路径后，在 B 执行
./deploy/Configure-SopProxy.ps1 -DeploymentConfigPath $deploymentConfig -Apply
./deploy/Configure-IdentityProxy.ps1 -AppId vehicle-config -DeploymentConfigPath $deploymentConfig -PlanOnly
# 核对可信身份请求头、账号、端口和密钥路径后，在 B 执行
./deploy/Configure-IdentityProxy.ps1 -AppId vehicle-config -DeploymentConfigPath $deploymentConfig -Apply
```

上述初始化工具都读取同一部署配置。SOP 的端口、数据根、公共地址、服务账号和密钥路径由统一配置派生，不再手工复制另一套值。首次生成网关；既有业务路径或密钥路径冲突会拒绝，不能靠自动迁移来消除。修改公共地址或端口后，先重新规划并显式更新 SOP 身份代理，再发布服务；派生产物与运行绑定不一致时发布/启动会停止并指出问题。

车型配置必须先完成通用身份桥初始化，再发布服务。工具从 identityProxy 读取可信用户头、密钥头和外置密钥绑定，在 Windows 认证后覆盖浏览器自报身份；初始化仅在显式 Apply 时创建保护文件、编译模块并配置所属应用。健康检查通过不代表身份边界已验收。现有用户名头为原始文本契约，身份桥支持 ASCII Windows 登录标识（例如域\工号）；非 ASCII 登录名会被拒绝，需由原项目先提供明确编码契约。

新站点保持停止状态。自动首次建站仅提供 HTTP；HTTPS 绑定和证书由管理员单独配置，工具不会降级 HTTPS。旧环境仍可使用 -ConfigPath 的旧格式入口，避免两种入口同时传参。

### 4. B 开放入口并逐个发布

完成部门访问边界后，在 IIS 管理器启动站点。B 用部署新版本.bat 安装第一步已收到、第二步已准备好运行环境的各应用包；后续更新再由 A 构建和发送。无需额外注册旧版 SOP/Quicklook 任务。

发布工具检查固定版本文件和服务健康。业务验收另检查网页、查询、下载、导入导出、保存及 B 重启后保留数据。销量预测首次等待输入稳定一分钟后生成，/forecast/readyz 返回 200 才表示页面可用且没有生成错误。

### 5. 首次验收后启用重启恢复

首次建站有意设置 `ServerAutoStart=false`。页面和关键业务操作验收通过后，由 B 管理员在工具根的 64 位 Windows PowerShell 中明确执行以下步骤，只为统一配置中指定的目标站点开启自动启动；不要改成遍历所有站点：

```powershell
$ErrorActionPreference = 'Stop'
. ./deploy/Environment.Config.ps1
$settings = Read-RuntimeSettings './config.local/deployment.json'
Add-Type -Path (Join-Path $env:windir 'System32/inetsrv/Microsoft.Web.Administration.dll')
$iisManager = New-Object Microsoft.Web.Administration.ServerManager
try {
    $site = $iisManager.Sites[$settings.Config.siteName]
    if ($null -eq $site) { throw '统一配置中的目标 IIS 站点不存在。' }
    Write-Output ('启用目标站点自动启动：' + $site.Name)
    $site.ServerAutoStart = $true
    $iisManager.CommitChanges()
} finally { $iisManager.Dispose() }
```

动态应用任务已有开机触发，服务异常退出时最多重试 3 次、间隔 1 分钟；更新任务设置只针对本工具管理的对应任务。B 管理员还需核对 IIS 与任务计划服务按组织设置正常运行，并在约定时间安排一次 B 重启验收。重启后从另一台部门电脑检查公共入口及各应用、可信操作人、保存的数据和任务/服务日志，确认只运行一份正式服务；A 关闭时 B 仍须可用。不能仅凭手工启动成功，就判定开机恢复已完成。

## 已有环境更新配置

Git 不覆盖 config.local。本次升级可逐应用调整，先保留本机原配置：

1. A 的 apps.json：字面端口改用 {port}；前缀改用 {basePath}。数据速查也需 --port {port}，避免依赖子项目默认值。以后本地改端口只改 target。
2. B 的 deployment.json：填写 publicOrigin/sharedDirectory/serviceAccount 默认值，将重复地址、前缀及共享根改成模板占位符；应用有明确不同需求时保留显式覆盖。
3. SOP 用统一配置执行 PlanOnly。已有数据目录、来源与密钥保持实际值；不一致先核对配置，不移动或覆盖数据。
4. 用统一配置初始化过的环境无需再维护旧 sop-iis.json；原始旧配置保留作恢复依据，不编辑生成的 auth/gateway/state 文件来凑一致。
5. 新增车型配置时，A 的 publish.json 与 B 的 deployment.json 分别补入模板中的 vehicle-config 项（含 identityProxy 和 secretEnvironmentFiles），保留其他应用的本机值；先规划并初始化该应用身份桥，再激活程序包。

销量预测若仍为静态接入，按新模板把 A 的 forecast 改为动态预览和 release 构建，B 改为 service。若 IIS 已有静态 /forecast，备份配置并记录原物理路径，由管理员在维护窗口移除旧应用映射，再部署动态包；保留原目录。跨类型恢复需要恢复相应配置与映射。

## 发布包和命令

通用包为 app-release.json 加 payload/，包含运行必需的同版程序、前端和依赖清单，Python .py 可入包。排除真实数据、Git、密码和虚拟环境；版本不可覆盖。SOP 原包验证后封装为通用包。新增导航入口还需发布 planhub。

```powershell
# A：只构建
./deploy/Publish-App.ps1 -AppId leads -Version v1 -Action Package -NonInteractive
# A：发送已有包
./deploy/Send-AppRelease.ps1 -ReleasePath ./staging/releases/leads-v1
# B：先规划，再执行
./deploy/Install-AppVersion.ps1 -ReleasePath ../收件/leads/v1 -PlanOnly
./deploy/Install-AppVersion.ps1 -ReleasePath ../收件/leads/v1 -Apply
```

A 的 inbox 为 B 收件共享目录或本机中转目录，UNC 仅用于传输。远程执行还需 remote.computerName/toolsRoot/configPath/inboxLocalPath；后三项指向 B 本机位置。已有内网 Jenkins 可调用同一套脚本，模板见 ci/Jenkinsfile。

## 失败与恢复

构建或校验失败不继续发送；接收先校验再成为版本。程序切换失败保留旧文件和正式数据，动态服务保持停止，避免新旧两版写同一数据库。

查看 logs/应用ID/service.log 和 state/应用ID 发布记录。回退先核对旧程序的数据兼容性，再选择记录中的旧包并用 -Rollback -DataCompatible；不会恢复数据库。数据库结构不兼容时由原项目提供恢复流程。

本机测试不代替 B 上首次建站、账号权限、网络可达、开机启动和业务操作验收。
