# 智选车计划部数据平台

**职责边界：门户只做集成，不修改子应用的逻辑、UI、权限或数据规则，不注入或改写子页面。已完成的改动保留；后续严格分开，详见[集成边界](docs/integration-boundary.md)。**

界面维护请先阅读 [AI 协作约定](AGENTS.md) 与 [设计基准](design-system/planning-portal/MASTER.md)，沿用用户确认的白底灰蓝简洁风格及顶部导航。

<img src="portal/assets/planning-icon.svg" width="80" height="80" alt="计划部工作空间图标">

文档中的文件系统路径以门户根目录为基准，命令也从该目录运行。先定位包含 `package.json`、`portal/`、`deploy/` 的目录，再核对兄弟项目位置；不同电脑调整相对位置，不绑定盘符或用户名。

门户保留 HTML/CSS/JavaScript 外壳、配置菜单、iframe 与 IIS 接入架构。SOP 的唯一业务源码默认在 `../SOP维护`；门户仓库不维护第二份 SOP 业务源码或回合并补丁。

## 默认相对目录布局

| 用途 | 相对门户根目录的路径 |
| --- | --- |
| 门户源码 | `.` |
| SOP 唯一源码 | `../SOP维护` |
| OrderIQ 共享规则 | `../订单分析/scripts/config/shared_config.py` |
| 共用销售输入 | `../共享数据/订单汇总` |
| 共用计划维护表 | `../共享数据/SOP计划/SOP计划维护.xlsx` |

历史公开化示例目录并非实际原项目位置。此前已直接核对文件与 Git 提交，没有盲套历史补丁；后续也应先核对相对位置再操作。

## 本地运行

要求 Node.js 20+、符合工作区依赖要求的共享 Python（至少 3.11，SOP 自身代码最低 3.10）以及原 SOP 的 requirements 依赖。双击 `启动本地门户.cmd`，或从门户根目录运行：

```powershell
npm run check
npm test
npm start
```

本地入口为 SOP 后端及其 Python 子任务选择同一个已验证的解释器。默认从门户位置向上定位名为 `Project` 的工作区，仅使用其共享 `.venv`（Windows 为 `.venv/Scripts/python.exe`，其他系统为 `.venv/bin/python`）；Project 的上级路径可以任意改变。原 SOP 或门户自己的 `.venv` 不会抢占，也不会自动回退到 PATH 或 Codex 缓存。显式 `SOP_PYTHON_PATH`（兼容旧配置 `SOP_PYTHON`）仍可覆盖；相对路径以门户根目录为基准，例如 `../.venv/Scripts/python.exe`。旧 `SOP_PYTHON` 可使用 PATH 命令名，含目录的相对路径同样按门户根目录解析。共享环境缺失、损坏或缺依赖时明确报错。启动前检查 Python 3.10+ 和 `openpyxl`。显式生产发布流程仍使用部署包自己的 `runtime/sop-venv`，不依赖开发机工作区。

迁移到新电脑时安装符合工作区依赖要求的 Python 3.11+ 和 Node.js 20+（含 npm），保持项目位于 `Project` 内，运行 Project 根的 `初始化共享环境.cmd` 重建所有项目共用的 `.venv`，然后 `npm start`。也可从门户根目录运行 `powershell -NoProfile -ExecutionPolicy RemoteSigned -File '../SOP维护/setup-environment.ps1'`，仅向 Project 共享环境安装 SOP 依赖。虚拟环境包含本机路径，不复制旧 `.venv`；项目文件和数据目录可保持相对布局一起迁移。

默认从上述原 SOP 项目启动 `server.py`，直接使用原项目的持久数据；网页维护、导入和设置操作保存到原数据库，并按原应用规则同步计划维护表，重启后继续使用。门户只保存运行所需的临时网关配置，不再复制数据库、销售文件或计划表。保持启动窗口运行；端口被占用时先在旧窗口按 Ctrl+C 停止，或核对运行状态后指定其他端口。不要同时启动两个 SOP 服务写同一套数据。

默认数据库为 `../SOP维护/data/sop.sqlite3`，销售来源为 `../共享数据/订单汇总`，计划表为 `../共享数据/SOP计划/SOP计划维护.xlsx`。共享根不存在时沿用原项目 `input_file`。路径环境变量 `SOP_DATA_DIR`、`SOP_SOURCE_DIR`、`SOP_PLAN_DIR`、`SHARED_DATA_ROOT` 支持覆盖，相对路径统一按门户根目录解析。SOP 原有数据刷新与 Excel 同步机制继续生效，不需要重启门户复制新快照。Excel 被占用或存在冲突时仍按原应用提示处理，不由门户强制覆盖。

路径可以通过参数或忽略的 `config.local/sop.json` 配置：

```powershell
npm start -- --sop-source '../SOP维护' --shared-config '../订单分析/scripts/config/shared_config.py' --port 4176 --backend-port 8879
```

本地配置字段为 `sourceRoot`、`dataRoot`、`sharedConfig`，模板见 `integration/sop.example.json`。相对路径统一按门户根目录解析。`dataRoot` 或 `--data-root` 指定包含 `data/` 与 `input_file/` 的持久数据项目；默认无需填写，使用原 SOP 数据与共享目录。`SOP_DATA_DIR` 则直接指定数据库所在目录。源码选择仍为 CLI、环境变量、本地配置、默认相对位置。原项目缺少接入能力时明确报错，不回退副本。

只有测试人员显式加 `--snapshot` 才创建隔离副本；历史 `--seed-from` 必须同时加 `--snapshot`，避免旧测试命令误写真实数据。演示命令为 `npm run dev:sop -- --snapshot --demo`。正常双击启动、`npm start`、`npm run dev` 和 `npm run dev:sop` 均默认持久模式。历史隔离数据保留，不自动覆盖或合并到正式库。详见[SOP 持久数据接入](docs/sop-persistence.md)。

`npm run dev` 与 `npm start` 相同；`npm run dev:static` 提供门户、OrderIQ、销量预测及数据速查代理（不启动后端）；`npm run dev:sop -- --sop-source <原项目路径>` 同样使用持久数据。本地预览不能替代内网 Windows 认证验收。

## 销量预测与数据速查

销量预测直接挂载原项目生成的 HTML 与资源；数据速查从独立项目启动或复用服务，放在导航最后。库存分析入口已移除。路径、服务及公共文件清单集中在 `integration/apps.json`，可用忽略的 `config.local/apps.json` 覆盖，相对路径统一按门户根目录解析。数据速查使用原项目自己的持久数据与自动同步；SOP 也使用原项目的持久数据。详见[接入与换电脑指南](docs/forecast-quicklook-integration.md)。

打包销量预测前运行 `npm run prepare:apps -- forecast`，只收集原样发布物并备份旧产物，不复制业务源码。

## SOP 独立运行与发布

原 SOP 的 `启动工作台.cmd`、`start-sop.ps1` 与 `python server.py` 独立运行方式保留。SOP 业务、身份适配、前端、测试及发布构建器均在原仓库维护。

先从原项目生成全新发布目录，再由门户消费该产物：

```powershell
$sopRelease = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'staging/sop-release-new'))
python '../SOP维护/scripts/build_release.py' --destination $sopRelease
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\New-DeploymentPackage.ps1 -Destination .\staging\DataPlatform-new -IncludeSop -SopReleasePath $sopRelease
```

构建器要求绝对产物路径，上例从相对产物目录动态解析得到，不写死盘符。目录必须为全新版本目录。SOP 产物中的 `sop-release.json` 记录源提交、工作区状态、文件哈希；门户打包验证完整性并拒绝额外文件。部署包的 `services/sop` 仅是运行时产物布局，不是门户 Git 中的业务源码。IIS 身份桥接源码由 SOP 产物提供。

数据库、原始 Excel、真实共享规则及运行机密不进入 SOP 发布产物。OrderIQ 的业务发布 HTML 也不提交 Git，需通过 `scripts/Import-OrderIQ.ps1` 导入自己的发布文件。依赖版本由原 SOP 的 `requirements-intranet.txt` 唯一维护，离线 wheel 放在忽略的 `offline/wheels`。

## 文档

- [单一源码核对、备份与验证记录](docs/single-source-migration.md)
- [SOP 内网部署](docs/sop-intranet.md)
- [IIS 通用部署](docs/iis-deployment.md)
- [新业务页面接入指南（静态页面 / 动态服务）](docs/app-integration.md)
- [可直接转给其他 AI 的接入任务模板](docs/ai-app-integration-prompt.md)
- [本地排查](docs/troubleshooting.md)

后续修改通过必要检查后，默认提交并推送到当前分支已配置的上游；不自动部署，不修改仓库可见性或 IIS/安全设置。旧版本发布包保留为历史回滚产物，不作为新构建的源码输入。

## 工作区位置

门户文件夹名称可按需调整。启动器、预览器、导入器和打包脚本从自身位置确定门户根目录；相对业务路径按该根目录解析，不依赖父目录或门户文件夹的固定名称。目录更名后，从新目录运行启动入口；无需改网页标题、平台名称或历史备份。

门户目录为 `计划工作台/`，与 `SOP维护/`、`订单分析/` 并列放在同一父目录。默认 SOP 使用 `../SOP维护`，共享规则使用 `../订单分析/scripts/config/shared_config.py`；双击当前目录的 `启动本地门户.cmd` 或在此目录运行 `npm start`。部署配置中的服务器路径独立于开发工作区位置。已有历史发布包与恢复备份保留原样，不自动改写其中的绝对路径；更新发布需从当前源码重新构建。

2026-11-03 迁移验收：2,732 个原文件的 SHA256 与目录链接核对一致；Git、忽略的发布文件及恢复备份随项目保留。原本运行的隔离预览已备份并停止；迁移后的默认启动、门户/OrderIQ/SOP 资源和 SOP 会话接口返回 200，17 项 Node 测试与 PowerShell 离线构建/打包检查通过。门户导入器同时统一了 Windows 长短路径归一化，保留目录越界检查。旧位置 `../../统一门户` 仅余被当前会话占用的空目录，关闭占用后可删除，不再从那里启动。
