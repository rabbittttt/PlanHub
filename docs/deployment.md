# 内网发布与部署

适用两台 Windows 电脑：A 同步代码、开发和构建，B 长期开机给部门使用。整个流程可留在内网，无需 GitHub、云平台或 Jenkins。当前提交提供工具，未替你安装 IIS、启用远程管理或在内网实际上线。

第一次部署先完成“首次准备一次”和“首次部署的执行顺序”，之后使用下表。

## 日常只做这几步

| 场景 | A 开发电脑 | B 部署电脑 |
|---|---|---|
| 新增网页 | 双击 `接入新网页.bat` 登记，再发布应用 | 首次补该应用运行配置，部署收到的包 |
| 更新网页或门户 | 双击 `发布应用.bat`，选择应用和操作 | 未启用远程发布时双击 `部署新版本.bat` |
| 更新 Excel/业务数据 | 将新数据放到约定正式来源，或网页上传 | 在业务网页使用原有同步/刷新功能 |

发布菜单提供生成包、生成并发送、生成并远程部署，也可直接发送或部署已有包，便于失败后重试而不重新构建。远程部署选项需要已获准使用的 Windows 远程管理，工具不会启用 WinRM、改防火墙或保存密码。没有远程通道时用第二项，在 B 双击部署。**收到包不是已上线，只有目标机切换并通过检查才算成功。**

已打开的业务页面在发布后刷新查看新版。发布前等保存、上传与后台写入完成；动态应用切换期间会短暂停止该服务。

## 首次准备一次

### A 开发电脑

1. 准备门户工具和各原项目。源码只在内网也完全可以，当前外网电脑无需取得源码。
2. 准备 Node.js 和原项目构建需要的 Python/依赖。首次双击发布工具会创建 `config.local/publish.json`。
3. 核对其中的 `applications`：原项目路径、构建命令或 `releasePath`。模板提供现有项目例子；原项目改名后只改本机配置。
4. `inbox` 填 B 的已授权收件共享目录，也可填本机中转目录再通过允许方式传输。路径可相对门户，UNC 共享只用于传输，不直接作为服务运行目录。

静态网页按登记的公开清单暂存到被 Git 忽略的 `apps/`，再生成发布包。新动态网页可提供原项目已生成的标准包，或在本机发布配置登记构建命令。工具不会猜测或复制整个业务仓库。

### B 部署电脑

保留一份门户工具（包括 deploy/ 与部署 BAT），它可通过内网复制，不要求在 B 拉取业务源码。将 `deploy/deployment.example.json` 复制为 `config.local/deployment.json`，核对：

| 配置 | 填什么 |
|---|---|
| deploymentRoot | 正式运行根目录，相对该配置文件所在目录 |
| siteName | 已创建的 IIS 站点名 |
| applications 中 healthUrl | 部门实际访问地址，含该应用前缀 |
| command / serviceAccount | B 上实际解释器位置与服务账号 |
| dataDirectory / arguments / environment | 各应用正式持久路径、端口、来源与原项目启动参数 |

首次由目标机管理员安装 IIS、URL Rewrite/ARR、准备站点绑定及部门访问边界。动态代理要求 ARR enabled、preserveHostHeader，上传/长任务需核对超时；工具不更改服务器全局安全设置。原 `Install-IisSite.ps1` 可用于首次站点准备，先用 `-PlanOnly` 检查其 `config.example.json` 格式配置。该旧站点配置与新的 deployment.json 用途不同，不要互换。

准备各应用匹配版本的 Python 环境和依赖。离线环境提前准备适配 Windows/Python 的 wheel；可用 `New-OfflineWheelhouse.ps1` 按原 requirements 下载，再按原项目说明离线安装。A 无可达依赖源时，通过公司允许的来源准备离线 wheel。不要复制开发电脑虚拟环境。新依赖环境使用新目录，保留旧环境用于恢复。

正式数据先按原项目一致性备份流程迁移并核对，**发布包不迁移数据库或 Excel**。服务使用本工具计划任务时为 S4U，不保存密码，无法访问网络共享或映射盘；因此业务数据放 B 本机，或另行采用公司允许的可访问共享数据的服务身份方案。服务账号需要批处理登录和相关目录读写权限。

建议布局：

```text
PlanHub部署/
  releases/应用ID/版本/   固定版本程序
  data/应用ID/           数据库与应用设置
  shared/                正式 Excel 等共同输入
  runtime/应用ID/        解释器和依赖
  config/                本机身份与秘密
  proxy/                 工具生成的独立应用代理
  state/                 当前版本记录与服务启动配置
  logs/                  服务日志
```

### 现有应用必须核对的设置

- **订单分析**：服务包使用原项目 `package_release.py`；显式配置 `--input`、`--data-dir`、`--state-dir`、`--web-dir` 和公共 Host/Origin。模板从 shared/订单汇总 读取 Excel，持久批次及批注放 data/orderiq。首次可由原服务自动生成批次；已有数据则停服备份后迁入，升级复用原路径。不要依赖发布目录下的默认输入。
- **数据速查**：使用原项目新发布包，设置 `DATA_QUICKLOOK_DATA_DIR`、`DATA_QUICKLOOK_SOURCE_BASE`、`DATA_QUICKLOOK_PUBLIC_PREFIX`、`DATA_QUICKLOOK_PUBLIC_ORIGIN`、`SHARED_DATA_ROOT`。模板共享根为 {deployment}/shared，供新版后台自动扫描；SOURCE_BASE 仅解析已保存来源路径，不能代替共享根。正式前缀 `/quicklook/`，健康接口 `/healthz`。保留原 workspace.json 中数据来源含义，迁移后逐项核对。
- **SOP**：保留既有 SOP 网关和 IIS 身份桥接，先用专用 `Configure-SopProxy.ps1` 完成首次接入及匹配身份配置。新版部署绑定设 `proxyMode: existing`，提供 `--gateway-config` 和秘密文件环境绑定；不能当成普通无身份代理。旧 SOP 任务不会被通用工具接管，第一次迁移先正常停止并确认端口释放，再使用新任务。
- **静态应用**：入口与资源完整交付。线索声量当前为替代样例，内网正式页面仍需验收；仅文件名相同不能证明资源与行为一致。

`Configure-QuicklookProxy.ps1` 等旧专用 Quicklook 工具属于旧版接入，含根 API 和 HTTP 限制。新包使用本手册的通用前缀代理，不再套用旧脚本。原完整包工具仍保留供既有环境使用，日常单应用升级优先使用新发布入口。

已有 config.local/publish.json、config.local/deployment.json 和 config.local/apps.json 不会被 Git 更新覆盖。此次升级按模板逐项核对：订单 sourceRoot/build.cwd 指向原项目 scripts，构建参数为 generate_html/package_release.py，正式启动增加 --input；数据速查增加 SHARED_DATA_ROOT；SOP 增加共享根和 SOP_RECONCILE_DIR；销量预测按下段切换动态配置。保留本机真实账号、端口和路径，不整份覆盖。

销量预测静态转动态：A 更新销量预测原项目和门户；本机 apps.json 若有旧 forecast 覆盖，按 integration/apps.json 替换该项；publish.json 的 forecast 改为模板中的 release 构建配置。B 的 deployment.json 按模板改为 service，准备 runtime/forecast 的 Python 与 requirements.txt，--data-dir 指向 data/forecast，SHARED_DATA_ROOT 指向 shared；已有部署/config.local.json 的 StaticApplications 移除 forecast。只更新 forecast 项并保留本机参数。

B 尚未建站时直接使用新模板。若此前已在 IIS 建立静态 /forecast 应用，先备份 IIS 配置、记录原物理路径，在维护窗口由管理员移除该应用映射，再运行部署新版本.bat 创建动态前缀代理；保留全部原目录和数据。工具会拒绝覆盖已有非工具代理。跨类型恢复需恢复原配置及映射，不能直接用动态配置回滚静态包。

销量预测健康检查访问 /forecast/healthz；页面首次等待输入稳定一分钟后生成。/forecast/readyz 返回 200 才表示有可用页面且没有生成错误，验收时还需检查页面与 /forecast/api/status。共享原始文件只读，预测服务按原规则更新 shared/订单汇总 中的销量汇总；账号需有该派生文件的写入权限。

## 首次部署的执行顺序

B 首次安装先完成本节，之后按日常发布表操作。每步报错时先处理该错误，再继续下一步。首次采用 A 传包、B 本机执行。B 上使用 64 位管理员 Windows PowerShell，执行脚本的位置为 B 的工具根目录，包含 deploy/ 和部署 BAT。

### 1. A 生成首次引导包

在 A 的门户根目录执行。下面使用当前默认同级项目布局，路径不同时按 A 的实际配置调整。

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
if ($LASTEXITCODE -ne 0) { throw '首次引导包生成失败。' }
```

将生成的 first-install 目录完整传到 B，放到选定的正式部署根。引导包提供 portal/、静态 apps/、SOP 原格式 services/sop/ 及 config/。此时 orderiq、quicklook、forecast 显示 EXTERNAL 是因为稍后单独发布。该引导包不加 RequireComplete。

SOP 首次身份接入需要 services/sop/sop-release.json。发布 BAT 生成的通用 SOP 包用于后续切版，首次引导使用上面的原格式产物。

### 2. B 准备配置并创建站点

B 另放一份工具目录，包含门户仓库的 deploy/ 和部署新版本.bat。以后更新工具时从已验证版本取得。保留工具目录与正式部署目录的分工。

先在 B 工具根目录取得实际部署路径。

```powershell
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Read-Host '输入 B 的首次引导包最终目录')).ProviderPath
```

修改正式部署根的 config/iis.json，将 SiteName、HostName、Port 设为实际值，RequireReverseProxy 设为 true，DeploymentRoot 保持相对配置目录的 ..。SiteName 须与 config.local/deployment.json 一致。

```powershell
$iisConfig = Join-Path $deploymentRoot 'config/iis.json'
& ./deploy/Install-IisSite.ps1 -ConfigPath $iisConfig -PlanOnly
# 核对站点、端口和目录后执行
& ./deploy/Install-IisSite.ps1 -ConfigPath $iisConfig -Apply
```

此时站点为停止状态。安装器会检查 IIS、Windows Authentication、URL Rewrite 和 ARR；SOP 还需要 IIS ASP.NET 4.x 及相应 .NET Framework 模块。相关组件和 ARR 全局配置由 B 的管理员先准备。

### 3. B 初始化 SOP 身份接入

将 deploy/sop-iis.example.json 复制到正式部署根的 config/sop-iis.json，填写实际 SiteName、PublicOrigin 和部署根。BackendPort 与 config.local/deployment.json 的 SOP port 对齐，例如两处统一 8877。ProxySecretPath 与 SOP 的 secretEnvironmentFiles.SOP_PROXY_SECRET 对齐。

首次生成 SOP 的私有运行配置，按本手册目录布局指定四个路径。原有正式环境升级时沿用已有配置。

```powershell
. ./deploy/Sop.Common.ps1
$gateway = Resolve-SopGatewayTemplate -Path ./deploy/sop.example.json -DeploymentRoot $deploymentRoot
$gateway.data_dir = Join-Path $deploymentRoot 'data/sop'
$gateway.source_dir = Join-Path $deploymentRoot 'shared/订单汇总'
$gateway.shared_config = Join-Path $deploymentRoot 'config/shared_config.py'
$gateway.plan_file = Join-Path $deploymentRoot 'shared/SOP计划/SOP计划维护.xlsx'
Write-SopJson -Path (Join-Path $deploymentRoot 'config/sop.json') -Value $gateway
$sopConfig = Join-Path $deploymentRoot 'config/sop-iis.json'
& ./deploy/Configure-SopProxy.ps1 -ConfigPath $sopConfig -PlanOnly
$serviceAccount = Read-Host '输入 B 实际运行 SOP 的 计算机或域名\服务账号'
& ./deploy/Configure-SopProxy.ps1 -ConfigPath $sopConfig -ServiceAccount $serviceAccount -Apply
```

脚本保留已有 config/sop.json 中的业务路径，并生成匹配的身份配置和秘密。deploy/sop.example.json 原默认使用部署根外的 ../shared；只修改 config/sop.example.json 不会影响该初始化脚本。因此首次按上面显式写入 config/sop.json，并检查生成结果。服务账号与 deployment.json 中 SOP 的 serviceAccount 保持一致，首次使用新通用任务。

### 4. B 准备数据、运行环境和公共地址

按上文迁入各应用持久数据，准备独立 Python 环境及依赖。SOP 原规则文件需另放到 B 的 config/shared_config.py，数据库放 data/sop，销售来源使用上面实际配置的路径。新版计划由网页保存或前台 Excel 导入，不再自动同步服务器维护表；plan_file 仅保留旧版兼容路径，不作为新环境必需业务文件。资料对账目录由 SOP_RECONCILE_DIR 指定为 shared/对账资料。SOP 启动时会检查真实规则和数据。

在 B 工具目录双击部署新版本.bat 生成 config.local/deployment.json 后，先填写实际配置。三个动态应用的 command 应指向 B 已安装依赖的解释器。原 Install-SopDependencies.ps1 默认创建 runtime/sop-venv，而新模板为 runtime/sop；使用旧依赖安装器时应把 command 改为实际解释器位置。

healthUrl、SOP PublicOrigin、订单 allowed-host/allowed-origin 和数据速查 DATA_QUICKLOOK_PUBLIC_ORIGIN，统一使用部门实际访问的 B 内网地址及端口。模板中的 localhost、示例域名和 MACHINE\PlanHubService 都需按 B 的实际值替换。

### 5. 开始发布并验收

B 在 IIS 管理器启动已经配置好部门访问范围的站点，先确认能打开引导门户。单应用发布会通过该站点做健康检查，因此站点需要运行。

A 双击发布应用.bat，依次生成并发送 planhub、forecast、leads、orderiq、quicklook、sop 的版本包。B 对每个收到的包双击部署新版本.bat，核对目标后执行。首次初始化无需再注册旧 Register-SopTask 或旧 Quicklook 任务。

验收各网页、关键查询、保存、导入导出及 B 重启后的服务恢复。发布完成后，同事统一访问 B 的内网地址；A 关闭后，B 应继续正常提供页面和业务操作。

## 发布包是什么

通用包为 `app-release.json` 加 `payload/`。清单记录 ID、版本、来源、入口、外置数据声明和文件哈希；禁止覆盖同一版本。静态包包含网页及资源，动态包包含运行必需代码和前端；Python 的 `.py` 可以入包。真实数据、Git、密码和本机环境不随包发布。

SOP 原包先按原 manifest 验证，再封装为通用版本。门户本身发布 ID 为 planhub，部署时对应 IIS 根站点。每个应用独立发布；新增入口还需发布门户版本才能在 B 显示。

## 命令行与内网 AI

从门户工具根目录运行。所有 `-Apply` 只在目标部署电脑执行。

```powershell
# A：仅构建，不发送，不上线
./deploy/Publish-App.ps1 -AppId leads -Version v1 -Action Package -NonInteractive
# A：发送已经验证的包
./deploy/Send-AppRelease.ps1 -ReleasePath ./staging/releases/leads-v1
# B：只检查计划
./deploy/Install-AppVersion.ps1 -ReleasePath ../收件/leads/v1 -PlanOnly
# B：按本机配置切换并检查
./deploy/Install-AppVersion.ps1 -ReleasePath ../收件/leads/v1 -Apply
```

使用远程发布时，在 A 的 publish.json 填 `remote.computerName`、`toolsRoot`、`configPath`、`inboxLocalPath`，后三项为 B 实际本机路径；使用当前 Windows 身份执行，避免网络共享的二次认证问题。公司未允许 WinRM 时使用离线传包方式。

已有内网 Jenkins 可使用 `ci/Jenkinsfile`，配置构建、部署 Windows 节点和各自本机配置路径。它调用同一套 PowerShell 工具，部署节点消费同一已验证产物。Jenkins 并非必装，模板未经你们内网环境验收。

## 失败与恢复

校验或构建失败不会继续发送。接收先复制到临时目录，完整校验后才成为版本；传输失败重试不覆盖旧包。上线失败显示具体步骤，保留旧程序和正式数据，动态服务保持停止以免两版同时写数据。

先查部署输出和 `logs/应用ID/service.log`，确认当前 `state/应用ID/deployment.json` 及运行配置。回退前确认旧程序兼容现有数据库与配置，使用部署工具的 `-Rollback -DataCompatible` 和相应旧版本包。它不会恢复旧数据库；数据库结构不兼容时由原项目提供迁移/恢复方案，不能直接覆盖维护数据。

目标电脑还需实际验收首次安装、开机启动、代理访问、查询、导入导出、持久保存以及版本恢复。本机测试和样例页面验证不代替这些操作。
