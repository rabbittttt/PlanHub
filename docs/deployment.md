# 内网发布与部署

适用两台 Windows 电脑：A 同步代码、开发和构建，B 长期开机给部门使用。整个流程可留在内网，无需 GitHub、云平台或 Jenkins。当前提交提供工具，未替你安装 IIS、启用远程管理或在内网实际上线。

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

准备各应用匹配版本的 Python 环境和依赖。离线环境提前准备适配 Windows/Python 的 wheel；可用 `New-OfflineWheelhouse.ps1` 按原 requirements 下载，再按原项目说明离线安装。不要复制开发电脑虚拟环境。新依赖环境使用新目录，保留旧环境用于恢复。

正式数据先单独迁移并核对，**发布包不迁移数据库或 Excel**。服务使用本工具计划任务时为 S4U，不保存密码，无法访问网络共享或映射盘；因此业务数据放 B 本机，或另行采用公司允许的可访问共享数据的服务身份方案。服务账号需要批处理登录和相关目录读写权限。

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

- **订单分析**：服务包使用原项目 `package_release.py`；显式配置 `--data-dir`、`--state-dir`、`--web-dir` 和公共 Host/Origin。第一次迁移完整 runtime 数据批次及批注数据库，升级保持原持久路径。模板将它们放在 data/orderiq 下。
- **数据速查**：使用原项目新发布包，设置 `DATA_QUICKLOOK_DATA_DIR`、`DATA_QUICKLOOK_SOURCE_BASE`、`DATA_QUICKLOOK_PUBLIC_PREFIX`、`DATA_QUICKLOOK_PUBLIC_ORIGIN`。正式前缀 `/quicklook/`，健康接口 `/healthz`。保留原 workspace.json 中数据来源含义，迁移后逐项核对。
- **SOP**：保留既有 SOP 网关和 IIS 身份桥接，先用专用 `Configure-SopProxy.ps1` 完成首次接入及匹配身份配置。新版部署绑定设 `proxyMode: existing`，提供 `--gateway-config` 和秘密文件环境绑定；不能当成普通无身份代理。旧 SOP 任务不会被通用工具接管，第一次迁移先正常停止并确认端口释放，再使用新任务。
- **静态应用**：入口与资源完整交付。线索声量当前为替代样例，内网正式页面仍需验收；仅文件名相同不能证明资源与行为一致。

`Configure-QuicklookProxy.ps1` 等旧专用 Quicklook 工具属于旧版接入，含根 API 和 HTTP 限制。新包使用本手册的通用前缀代理，不再套用旧脚本。原完整包工具仍保留供既有环境使用，日常单应用升级优先使用新发布入口。

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
