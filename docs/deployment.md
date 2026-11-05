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
| 访问入口 | 内网域名或地址、HTTP/HTTPS 端口、证书、部门访问范围 |
| IIS 功能 | 静态内容、默认文档、Windows Authentication、管理工具；SOP 另需 ASP.NET 4.x、URL Rewrite、ARR |
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
  deploy/                 # 发布工具
```

**IIS 网站物理路径只指向 `portal/`，不能指向整个发布根。** `portal/config/apps.json` 是公开的导航注册表；它与发布根下存放服务器配置和机密的 `config/` 是不同目录。静态报表若已嵌入真实数据，所有能取得该 HTML 的访问者也能取得其中的数据。

| 配置或接口 | 路径解析方式 |
|---|---|
| 开发机文档中的文件路径 | 相对门户根目录；命令从该根执行 |
| `config.example.json` / `sop-iis.example.json` 的 `DeploymentRoot` | 相对配置文件所在目录；模板 `..` 表示发布包根 |
| `ProxySecretPath` | 相对解析后的发布根，且必须位于 `config/` 内 |
| `deploy/sop.example.json` 的数据、来源、规则、计划路径 | 相对发布根；由配置脚本生成运行时绝对路径 |
| SOP 构建器 `--destination`、IIS 物理路径、SOP 网关路径、部分部署脚本参数 | 要求绝对路径；用 `Resolve-Path`、`Join-Path`、`GetFullPath` 从当前环境生成 |

部署配置兼容明确的本地绝对值，但模板和指南不绑定开发机盘符。通用发布根校验拒绝 UNC、仅带盘符的相对路径及磁盘根；服务运行时需绝对路径的地方不能直接传模板相对值。数据、规则和秘密必须在 Web 根之外；现有配置中的自定义业务路径应保留，不因升级覆盖成默认目录。

## 3. 从原项目准备发布物

### 静态网页

订单分析和销量预测先在各自原项目生成并审核最终发布物；本地默认直接读取原项目目录。打包前，从门户根收集到发布目录：

```powershell
npm run prepare:apps -- orderiq forecast
```

该命令只收集公开清单中的原样发布文件，已有目标产物移到 `artifacts/static-backup-...` 保留恢复。来源与哈希记录在忽略的 `apps/<应用ID>.import.json`。订单最终发布入口仍为 `apps/orderiq/index.html`，销量预测保留完整资源目录；旧订单导入器生成的本机覆盖仍可作为打包来源。数据库、原始 Excel、日志、秘密及整套业务源码不入静态目录或公开 Git。

### SOP 发布物与完整包

先在原 SOP 项目准备并验证依赖，再从门户根目录执行。以下以工作区共享 Python 为例；实际环境不同时使用已验证的解释器路径：

```powershell
if (-not (Test-Path -LiteralPath './deploy/config.local.json')) {
    Copy-Item -LiteralPath './deploy/config.example.json' -Destination './deploy/config.local.json'
}
# 编辑或核对本机配置：站点、域名/端口、静态清单和实际目标参数。
$sopRelease = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'staging/sop-release-new'))
& '../.venv/Scripts/python.exe' '../SOP维护/scripts/build_release.py' --destination $sopRelease
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/Install-IisSite.ps1 -ConfigPath ./deploy/config.local.json -PlanOnly
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/New-DeploymentPackage.ps1 -ConfigPath ./deploy/config.local.json -Destination ./deploy/releases/DataPlatform-new -IncludeSop -SopReleasePath $sopRelease -WhatIf
```

预检通过并审阅发布计划后，去掉最后一条的 `-WhatIf` 才生成发布包。仅包含静态网页的包可不带 SOP 两个参数；完整工作台需要 SOP 时不得遗漏它们。所有源产物和发布目的地均使用**全新版本目录**，打包器拒绝覆盖已有目录。

SOP 原项目的 `sop-release.json` 记录源提交、工作区状态及每个文件的 SHA256。门户打包校验 manifest、文件集合、哈希和路径，拒绝额外文件、缺少显式来源及路径越界；拒绝重解析点和常见非公开条目。`services/sop` 在发布包中只是被验证的运行产物，不是门户 Git 的业务源码。

包内可附带原项目 `requirements-intranet.txt` 对应的离线 wheel；放入忽略的 `offline/wheels` 并提供 `SHA256SUMS`。业务数据、真实共享规则和代理秘密需另外安全迁移，不随源码发布。

## 4. 在目标电脑配置 IIS

先将审核后的包复制到目标电脑的新版本目录。在该目录打开管理员 PowerShell，核对 `config/iis.json` 解析后的发布根与实际位置一致：

```powershell
$deploymentRoot = (Resolve-Path '.').Path
./deploy/Install-IisSite.ps1 -ConfigPath ./config/iis.json
./deploy/Install-IisSite.ps1 -ConfigPath ./config/iis.json -Apply -WhatIf
```

默认命令只读预检：检查目标文件、必需模块、同名站点/应用池、绑定冲突及可选 ARR 开关。`-PlanOnly` 只校验配置和打印离线计划，不能代替服务器预检。管理员确认后，执行同命令的 `-Apply` 才创建站点。

创建脚本只适用于**新站点**，会拒绝同名站点/应用池；不用于给现有站点追加应用或覆盖升级。它创建无托管 CLR 的新静态应用池、停止状态站点和已启用的静态 Application，开启 Windows 认证、关闭匿名认证，并将认证设置写到 apphost 对应 location。它不切换现有站点，不开启全局 ARR，不配置 DNS、HTTPS 证书、ACL 或防火墙。

模板的 HTTP 端口和空主机名只用于隔离验收；正式入口由管理员填写真实域名及组织认可的 HTTPS 绑定。需要动态代理时将 `RequireReverseProxy` 设为 true，并先评估服务器其他站点后安装/开启 URL Rewrite 和 ARR。全局 ARR 开关需另行设置，脚本只检查。

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

先将 `deploy/sop-iis.example.json` 复制到发布根 `config/sop-iis.json`，核对真实 `SiteName`、`DeploymentRoot`、`PublicOrigin`、`BackendPort`、应用池和秘密路径。后端端口以该配置为准，不与本机预览或其他服务的端口混用。

以下在目标发布根执行。`$serviceAccount` 和 `$pythonPath` 应先由管理员填写为实际服务账号与已安装的 Python 可执行文件；示例不代填域名、账号或解释器位置：

```powershell
$deploymentRoot = (Resolve-Path '.').Path
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json -PlanOnly
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json
./deploy/Configure-SopProxy.ps1 -ConfigPath ./config/sop-iis.json -ServiceAccount $serviceAccount -Apply -WhatIf
./deploy/Install-SopDependencies.ps1 -DeploymentRoot $deploymentRoot -PythonPath $pythonPath -WhatIf
./deploy/Register-SopTask.ps1 -DeploymentRoot $deploymentRoot -ServiceAccount $serviceAccount
```

这些示例为计划、只读预检或 WhatIf。管理员审阅后才去掉 WhatIf 或增加 `-Apply`：

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

销量预测为静态发布物，按第 3 节收集后创建 `/forecast/` 独立 Application。数据速查是独立服务，**不包含在静态发布包中**；需从自己的仓库交付依赖和程序，配置常驻运行、日志、账号及重启恢复。

数据速查现有页面资源可用 `/quicklook/` 剥离前缀代理，但原前端使用根 API。IIS 还需逐项配置现有精确接口：`/api/catalog`、`/api/table`、`/api/workbooks`、`/api/workbook`、`/api/sheet`、`/api/search`、`/api/raw`、`/api/import`、`/api/sync`、`/api/config`、`/api/recognition`。不得扩大成全站 `/api/*` 转发；保留公共 Host、Origin 和安全响应头，核对上传大小与超时，不占用门户管理接口。新应用应优先支持自己的完整子路径。

`deploy/arr-rules.example.xml` 只演示 `/leads/` 剥离前缀，不是 SOP 或数据速查的即用配置。普通代理与 SOP 的身份桥接不能混用。Node 本地 `integration/apps.json` 不会自动生成 IIS 代理、安装依赖或配置后台服务。

按实际应用协调前缀保留/剥离、资源、Location、表单、Cookie Path、Host/Origin 与身份信任。history 回退只作用于对应业务应用，不设置全站 SPA fallback。需 WebSocket 的应用必须另行配置 IIS WebSocket 并专项验收；当前通用 Node 本地代理不支持 WebSocket upgrade。完成目标环境的页面、接口及持久保存验收后，再将入口设为 ready。

## 7. 验收、升级与回退

| 检查 | 通过条件 |
|---|---|
| 门户及应用直达 | 认证后页面、配置、资源和接口成功；无匿名或跨前缀旁路 |
| 部门范围与统一能力 | 获准成员均可查看、维护、导入导出并正确留痕；入口外用户不能取得业务数据 |
| SOP 代理校验 | 缺失/伪造身份、错误 key、错误或跨源 Origin 被拒绝；正常成员操作成功 |
| iframe 与浏览器 | 同源嵌入、刷新、内部跳转、下载正常，无资源 404、混合内容、跨域或 CSP 冲突 |
| 数据外置 | 数据库、输入、秘密及日志不能通过静态地址下载；服务路径与计划表归属正确 |
| 业务操作 | 使用测试数据验证计划保存、导入导出和冲突处理；停止并重启后读回一致 |
| 运行恢复 | 服务器重启后 IIS 与各服务按运维设置恢复；没有两个服务写同一维护表 |
| 访问与菜单 | 即使隐藏菜单，直接业务 URL 仍受 IIS/后端访问规则约束 |

迁移持久数据前安排停止写入，用 SQLite backup API 导出一致快照，并保留匹配的 `sales.json`、`source_settings.json` 和计划维护表。不能仅热拷主数据库而漏掉 WAL，也不能由新旧服务同时写同一套数据库/维护表。文件归属与日常持久位置见[使用说明](usage.md)。

首次上线保留原站点、产物和配置，验收后再切入口。门户与业务应用分别版本化，升级只发布对应应用的新产物，保留上一版本与匹配配置；SOP 每次重新验证来源清单。回退先停止相关写入、确认数据库版本兼容，再恢复受影响应用上一版；不为单应用回退覆盖整个 IIS 全局配置。失败的新站点保持停止并查日志，不自动删除归属不明的站点、目录或业务数据。

## 参考依据

- [Microsoft：Windows Authentication](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/authentication/windowsauthentication/)
- [Microsoft：URL Rewrite 与 ARR 反向代理](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing)
- [Microsoft：URL Rewrite 配置参考](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/url-rewrite-module-configuration-reference)
- [Microsoft：配置继承边界](https://techcommunity.microsoft.com/blog/iis-support-blog/how-to-prevent-web-config-files-to-be-overwritten-by-config-files-in-application/297627)
