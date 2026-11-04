# 智选车计划部数据平台

**职责边界：门户只做集成，不修改子应用的逻辑、UI、权限或数据规则，不注入或改写子页面。已完成的改动保留；后续严格分开，详见[集成边界](docs/integration-boundary.md)。**

界面维护请先阅读 [AI 协作约定](AGENTS.md) 与 [设计基准](design-system/planning-portal/MASTER.md)，沿用用户确认的白底灰蓝简洁风格及顶部导航。

<img src="portal/assets/planning-icon.svg" width="80" height="80" alt="计划部工作空间图标">

文档中的文件系统路径以门户根目录为基准，命令也从该目录运行。先定位包含 `package.json`、`portal/`、`deploy/` 的目录，再核对兄弟项目位置；不同电脑调整相对位置，不绑定盘符或用户名。

门户保留 HTML/CSS/JavaScript 外壳、配置菜单、iframe 与 IIS 接入架构。SOP 的唯一业务源码默认在 `../SOP看板`；门户仓库不维护第二份 SOP 业务源码或回合并补丁。

## 默认相对目录布局

| 用途 | 相对门户根目录的路径 |
| --- | --- |
| 门户源码 | `.` |
| SOP 唯一源码 | `../SOP看板` |
| OrderIQ 共享规则 | `../订单分析/scripts/config/shared_config.py` |
| 共用销售输入 | `../共享数据/订单汇总` |
| 共用计划维护表 | `../共享数据/SOP计划/SOP计划维护.xlsx` |

历史公开化示例目录并非实际原项目位置。此前已直接核对文件与 Git 提交，没有盲套历史补丁；后续也应先核对相对位置再操作。

## 本地运行

要求 Node.js 20+、Python 3.10+ 以及原 SOP 的 requirements 依赖。双击 `启动本地门户.cmd`，或从门户根目录运行：

```powershell
npm run check
npm test
npm start
```

默认从上述原 SOP 项目启动 `server.py`，只把数据在线备份到门户忽略的临时目录，可进行维护、导入导出等操作，修改仅保存在隔离快照，不会回写原项目；重新启动会创建新快照。业务实现始终来自原项目；数据快照不是第二套源码。保持启动窗口运行，打开终端打印的地址。端口已被旧进程占用时，在旧窗口按 Ctrl+C 后重启，或指定其他端口。

销售来源优先采用 `SOP_SOURCE_DIR`、`SHARED_DATA_ROOT/订单汇总`；这些环境变量的相对路径均按门户根目录解析，例如 `SHARED_DATA_ROOT=../共享数据`，也兼容绝对路径。未设置这两个变量时，显式 `--seed-from` 或本地配置 `dataRoot` 使用所选数据项目的 `input_file/`，保留历史或测试种子的完整来源。仅默认数据模式自动读取 SOP 同级 `../共享数据/订单汇总`，且只在共享根不存在时兼容原项目的 `input_file/`；共享根存在但缺少 `订单汇总/` 时会报错，不读取旧副本。预览启动时将销售文件复制到隔离目录，计划表优先按环境变量 `SOP_PLAN_DIR` 选择（相对值按门户根目录解析）；未指定时，显式种子始终从其 `input_file/SOP计划维护.xlsx` 复制，默认数据模式则从共享根 `SOP计划/SOP计划维护.xlsx` 复制（无共享根时兼容原项目 `input_file/`），数据库和规则仍按既有配置建立快照。共享源的后续更新需重启预览获取；网关 `plan_file` 始终指向隔离副本，所有维护操作只写隔离快照，不回写共享文件或原项目。

路径可以通过参数或忽略的 `config.local/sop.json` 配置：

```powershell
npm start -- --sop-source '../SOP看板' --shared-config '../订单分析/scripts/config/shared_config.py' --port 4176 --backend-port 8879
```

本地配置字段为 `sourceRoot`、`dataRoot`、`sharedConfig`，模板见 `integration/sop.example.json`。本地配置、路径环境变量及 CLI 的 `--sop-source`、`--seed-from`、`--shared-config` 相对值统一按门户根目录解析，不受启动时的当前目录或 `config.local/` 位置影响。默认模板省略 `dataRoot`，以采用共享销售和计划目录；仅需完整历史或测试种子时才配置 `dataRoot` 或 `--seed-from`。`dataRoot` 是包含 `data/` 和 `input_file/` 的数据源项目目录，不等同于后端配置中的 `data_dir`。源码选择优先级为 `--sop-source`、`SOP_SOURCE_ROOT`、本地配置、实际兄弟目录。`--seed-from` 只选择数据来源，不选择运行代码。原项目未完成 gateway 适配时明确报错，不回退副本。

`npm run dev` 与 `npm start` 相同；`npm run dev:static` 只提供静态门户和 OrderIQ；`npm run dev:sop -- --sop-source <原项目路径>` 使用演示数据，但仍从原项目运行代码。本地预览不能替代内网 Windows 认证验收。

## SOP 独立运行与发布

原 SOP 的 `启动工作台.cmd`、`start-sop.ps1` 与 `python server.py` 独立运行方式保留。SOP 业务、身份适配、前端、测试及发布构建器均在原仓库维护。

先从原项目生成全新发布目录，再由门户消费该产物：

```powershell
$sopRelease = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'staging/sop-release-new'))
python '../SOP看板/scripts/build_release.py' --destination $sopRelease
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

门户目录为 `计划部工作台/`，与 `SOP看板/`、`订单分析/` 并列放在同一父目录。默认 SOP 使用 `../SOP看板`，共享规则使用 `../订单分析/scripts/config/shared_config.py`；双击当前目录的 `启动本地门户.cmd` 或在此目录运行 `npm start`。部署配置中的服务器路径独立于开发工作区位置。已有历史发布包与恢复备份保留原样，不自动改写其中的绝对路径；更新发布需从当前源码重新构建。

2026-11-03 迁移验收：2,732 个原文件的 SHA256 与目录链接核对一致；Git、忽略的发布文件及恢复备份随项目保留。原本运行的隔离预览已备份并停止；迁移后的默认启动、门户/OrderIQ/SOP 资源和 SOP 会话接口返回 200，17 项 Node 测试与 PowerShell 离线构建/打包检查通过。门户导入器同时统一了 Windows 长短路径归一化，保留目录越界检查。旧位置 `../../统一门户` 仅余被当前会话占用的空目录，关闭占用后可删除，不再从那里启动。
