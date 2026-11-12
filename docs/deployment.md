# 程序打包、本机运行与交付

本机整套使用：在 A 打包，完整复制整包到运行电脑，一次准备 Node.js 和 Python 依赖、真实规则及数据，再双击包内启动 CMD。运行时只读取发布包中的同版程序，不需要 A 的兄弟项目源码，也不需要 IIS 或计划任务。

本机入口仅监听 `127.0.0.1`，使用本机账户身份，不提供 Windows 部门认证；其他电脑不能把它当作部门内网站点访问。正式 Windows + IIS 方案和 `部署新版本.bat` 继续保留，操作见文末部署同事附录。

<a id="local-bundle"></a>

## 整套发布版在本机启动

### 第一步：准备本次要交付的代码

在 A 同步门户和需要发布的原项目，先确认本地网页功能正常。A 需已有 Node.js 20+、Python 和各项目的构建依赖。

工具调用各应用的构建入口，自动生成并校验同版前端、后端和资源，不需要先手动生成业务报表。首次配置好项目路径、构建环境和静态页面来源，后续沿用。

输入 `0`，依次打包门户和所有已启用应用；当前包括 `planhub`、`sop`、`orderiq`、`forecast`、`leads`、`quicklook`、`vehicle-config`。除各自的独立包外，全部成功后额外生成整套本机包。线索声量按已登记的真实静态页面收集，首次接入时核对来源，不能以接入样例代替正式页面。

### 第二步：双击“发布应用.bat”，选择应用

在门户根目录双击 `发布应用.bat`，输入 `0` 全部打包。批量只生成独立版本包和整套本机包，不传送、不部署；各应用仍保留自己的版本目录。正式 IIS 后续更新可输入原有单个应用编号，只交付受影响应用。

首次运行自动创建 `config.local/publish.json`。模板按项目与门户同级、Python 位于 `../.venv/Scripts/python.exe` 设置；位置不同时，修改对应应用的 `sourceRoot`、`build.command`，再重新运行。`build.cwd` 未填写时使用 `sourceRoot`。这些路径按门户根目录解析。

这份配置只负责找到原项目及其构建工具，你不需要填写 B 的账号、权限或服务器地址，也不需要填写 `inbox`、`remote`。已有本机配置不会被自动更新或覆盖；缺少应用时从 `deploy/publish.example.json` 补入对应项。

已准备好本机配置时，也可从门户根用命令行全部打包：

```powershell
./deploy/Publish-App.ps1 -All -NonInteractive
```

`-All` 与输入 `0` 相同。某个应用失败会记录原因并继续其余应用；最后列出成功目录和失败清单，有失败则返回错误状态，不把不完整结果交付为整套包。

### 第三步：找到生成的版本包

全部成功后，按窗口提示找到整套本机包：

```text
staging/bundles/PlanHub-时间戳/
  启动发布版工作台.cmd
  停止发布版工作台.cmd
  bundle.json
  local.runtime.example.json
  _launcher/                 通用启动和代理工具
  releases/应用ID/版本/
    app-release.json
    payload/                 同版前端、后端和运行资源
```

整个 `PlanHub-时间戳` 目录一起复制或完整压成 ZIP，运行电脑完整解压后使用。不要只取 CMD、`payload` 或其中某个 HTML。启动器校验清单和文件哈希；包内程序不直接覆盖，后续重新生成新包。

原来的独立包仍保留，供正式 IIS 逐应用发布：

```text
staging/releases/应用ID-版本号/
  app-release.json
  payload/
```

批量出错时处理失败清单中的具体原因。独立包可按编号重试失败项；需要完整本机包时，再输入 `0` 完成整批构建。已有成功包保留，不修改内容。

### 第四步：运行电脑首次准备

运行电脑安装 Node.js 20+（`node` 可在命令行使用），并准备符合各应用依赖要求的 Python。当前工作区要求 Python 3.11+；按整包内五个动态应用各自的 `releases/应用ID/版本/payload/requirements.txt` 安装并核对依赖。可以使用同一个已验证兼容的解释器，也可以在本机配置中为各应用设置自己的 `python`。不要复制其他电脑的虚拟环境；整包不会自动安装依赖。离线准备方法见附录“离线依赖也要单独交付”。

有公司允许的软件包来源时，可从整包目录逐个准备动态应用依赖；这里选择的解释器应与随后本机配置中的 `python` 一致：

```powershell
$python = (Resolve-Path -LiteralPath (Read-Host '输入已安装的 Python 可执行文件路径')).ProviderPath
$release = (Resolve-Path -LiteralPath (Read-Host '输入本包内动态应用版本目录（含 app-release.json）')).ProviderPath
& $python -m pip install -r (Join-Path $release 'payload/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '应用依赖安装失败。' }
& $python -m pip check
if ($LASTEXITCODE -ne 0) { throw '依赖一致性检查失败。' }
```

首次双击 `启动发布版工作台.cmd`，会在整包旁的 `../PlanHub本地运行/` 自动生成 `config.local.json`。首次缺少规则或依赖时会报错并保留窗口；按提示补齐后重新启动。这个外置运行目录保存本机配置、持久数据、日志和规则，升级时保留它：

```text
运行电脑上的同一父目录/
  PlanHub-旧时间戳/            旧程序包，保留作恢复
  PlanHub-新时间戳/            新程序包
  PlanHub本地运行/
    config.local.json         本机运行配置
    config/shared_config.py   单独准备的真实 SOP 共享规则
    shared/                   默认共享输入位置
    data/                     各应用持久数据，具体位置按配置
    logs/                     启动及应用日志
```

核对生成的配置，里面的相对路径均按 **`PlanHub本地运行` 目录**解析：

| 字段 | 首次核对内容 |
|---|---|
| `python` | 已装好依赖的 Python 命令或解释器路径；`applications.应用ID.python` 可覆盖 |
| `portalPort` | 门户端口，默认 `4173`；地址始终使用 `127.0.0.1` |
| `sharedDirectory` | 真实共享输入根，默认 `shared`；准备订单汇总、车型信息等原应用需要的文件 |
| `sopSharedConfig` | 默认 `config/shared_config.py`，必须单独放入真实业务规则文件 |
| `applications.应用ID.dataDirectory` | 该应用已有或新建的版本外持久目录；迁移后核对原数据库、设置及上传 |
| `applications.应用ID.port` | 对应后台端口，不能与门户及其他应用重复 |

真实共享输入、数据库、上传、历史设置和规则需由操作人员另行准备；已有数据迁移前先停旧服务并按原项目流程备份。程序包不携带业务数据、真实规则或密钥，不会自动从开发电脑复制，不会用空规则或假数据代替。SOP 仍通过其已有网关接口接入；本机网关及临时代理配置在外置运行目录生成，不能拿它们代替正式 IIS 身份配置。

迁入数据速查旧 `workspace.json` 时，还要核对 `applications.quicklook.environment.DATA_QUICKLOOK_SOURCE_BASE`，它决定旧相对来源路径的解析基准；不能只搬数据库而让来源继续指向旧电脑。

需要其他运行位置时，从整包目录使用相同的 `--runtime` 参数启动和停止，例如：

```powershell
./启动发布版工作台.cmd --runtime ../我的本机运行
./停止发布版工作台.cmd --runtime ../我的本机运行
```

`--runtime` 相对启动命令所在的整包目录解析；运行目录与发布目录必须独立，不能相互包含。换位置时同样保留原持久数据和路径基准，不另建空目录来冒充已有数据。

### 第五步：启动、停止与更新

补齐首次环境、规则及数据后，双击整包中的 `启动发布版工作台.cmd`。新实例健康检查通过并稳定运行 3 秒后，窗口自动关闭，门户和本轮业务服务在后台运行。浏览器打开默认 `http://127.0.0.1:4173/`；改过 `portalPort` 时使用实际提示地址。检查各页面、真实来源、保存、导入导出，并停止再启动确认维护结果保留。

进程健康不等于业务数据已经生成；销量预测首次还需等待输入稳定和生成完成，`/forecast/readyz` 返回 200 才表示页面可用且没有生成错误。

停止时双击同包的 `停止发布版工作台.cmd`；使用过 `--runtime` 时带上相同参数。只停止这个运行实例及其启动的服务，不按端口结束其他程序。关闭浏览器不会停止后台服务。启动失败会回收本轮新服务并保留外置 `logs/`，按窗口提示处理；缺依赖、缺规则、占用端口都会明确报错。重复启动同一发布目录和配置可复用健康实例，不接管陌生后端。

更新时重新输入 `0` 生成新整包，先停止旧版，再把新旧包并排放在同一父目录并启动新包；原 `PlanHub本地运行` 保留，已有本机配置不会被新模板覆盖。自定义运行目录时，新包继续指定原 `--runtime`。不要同时启动开发版或其他版本写同一份数据；业务数据刷新也不等于程序升级。

**正式 IIS 方案继续保留 `部署新版本.bat`。** 本机整包不用运行它；需要部门其他电脑访问 B 时，由部署同事按以下附录准备独立包、IIS、账号权限和统一配置，逐应用安装验收。

---

<details>
<summary>部署同事专用：服务器配置、首次安装与故障恢复（打包人员可跳过）</summary>

以下由部署同事执行；仅为交接保留，不属于打包人员的日常步骤。适用于现有 Windows + IIS + Python 方案。账户、权限、网站及服务设置在目标机核对后应用，不因收到 ZIP 自动生效。

正式 IIS 首次交付各应用的独立目录或完整 ZIP，同时交付同版完整 `deploy/`、根目录 `部署新版本.bat` 和本手册；部署工具更新时同样成套交付。独立包解压后选择直接包含 `app-release.json` 和 `payload/` 的目录。整套本机包中的 CMD 使用本机身份，不替代下述部门认证与服务部署。

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

## 部署同事：首次安装的五个步骤

### 第一步：接收程序包，协作准备首次引导材料

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

订单分析须同步包含直接源码构建能力的新版 `generate_html/package_release.py`。门户原有构建命令无需调整；打包不读取 `output_file/runtime`、Excel 或旧批次，旧 `--runtime` 参数仅兼容接受并提示忽略。B 上仍需配置真实输入和外置持久目录，启动后由原服务生成业务数据；程序包完成不代表首批业务数据已就绪。

按正文五步接收 planhub、leads、orderiq、forecast、quicklook、sop、vehicle-config 的独立包，先不要激活；已有的包无需重复构建。将 B 收到的包保留在收件目录；B 下一步从 payload/requirements.txt 准备依赖，因此无需业务源码。

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

将每个已核对的 wheel 目录连同 `SHA256SUMS` **另行完整传到 B 的本机目录**，记录它与应用版本、Python 版本及架构的对应关系。应用版本包不包含这些目录；引导包仅可能附带 A 已准备的部分 wheel，也不证明全部应用依赖齐全。B 安装时使用实际收到的目录，不假定工具目录下已有 `offline/wheels`。同一应用需要重建时保留旧目录并另选新目录。

### 第二步：准备运行环境和数据

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

### 第三步：创建站点和身份接入

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

### 第四步：安装各应用并验收

完成部门访问边界后，在 IIS 管理器启动站点。B 用部署新版本.bat 安装第一步已收到、第二步已准备好运行环境的各应用包；后续更新再由 A 构建和发送。无需额外注册旧版 SOP/Quicklook 任务。

发布工具检查固定版本文件和服务健康。业务验收另检查网页、查询、下载、导入导出、保存及 B 重启后保留数据。销量预测首次等待输入稳定一分钟后生成，/forecast/readyz 返回 200 才表示页面可用且没有生成错误。

### 第五步：启用开机恢复并验收

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

## 失败与恢复

批量打包时，单个应用构建或校验失败会记录原因并继续其他应用；最后核对成功目录和失败清单，修复后仅重试失败项。成功包保留，未完成的目录不交付。B 接收后先校验再安装；程序切换失败保留旧文件和正式数据，动态服务保持停止，避免新旧两版写同一数据库。

查看 logs/应用ID/service.log 和 state/应用ID 发布记录。回退先核对旧程序的数据兼容性，再选择记录中的旧包并用 -Rollback -DataCompatible；不会恢复数据库。数据库结构不兼容时由原项目提供恢复流程。

本机测试不代替 B 上首次建站、账号权限、网络可达、开机启动和业务操作验收。

</details>
