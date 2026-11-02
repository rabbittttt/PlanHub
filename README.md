# 智选车计划部数据平台

<img src="portal/assets/planning-icon.svg" width="80" height="80" alt="计划部工作空间图标">

门户保留 HTML/CSS/JavaScript 外壳、配置菜单、iframe 与 IIS 接入架构。SOP 的唯一业务源码是 `D:\05 AI脚本\PythonProject\计划看板`；门户仓库不维护第二份 SOP 业务源码或回合并补丁。

## 已核对的实际项目

| 用途 | 实际路径 |
| --- | --- |
| 门户源码 | `D:\05 AI脚本\统一门户` |
| SOP 唯一源码 | `D:\05 AI脚本\PythonProject\计划看板` |
| OrderIQ 共享规则 | `D:\05 AI脚本\PythonProject\订单分析\scripts\config\shared_config.py` |

历史文档的 `D:\Projects\SOP` 只是公开化时使用的示例，并非当前原项目位置。此次已直接核对文件与 Git 提交，没有盲套历史补丁。

## 本地运行

要求 Node.js 20+、Python 3.10+ 以及原 SOP 的 requirements 依赖。双击 `启动本地门户.cmd`，或从门户根目录运行：

```powershell
npm run check
npm test
npm start
```

默认从上述原 SOP 项目启动 `server.py`，只把数据在线备份到门户忽略的临时目录，全部写入关闭。业务实现始终来自原项目；数据快照不是第二套源码。保持启动窗口运行，打开终端打印的地址。端口已被旧进程占用时，在旧窗口按 Ctrl+C 后重启，或指定其他端口。

路径可以通过参数或忽略的 `config.local/sop.json` 配置：

```powershell
npm start -- --sop-source 'D:\05 AI脚本\PythonProject\计划看板' --shared-config 'D:\05 AI脚本\PythonProject\订单分析\scripts\config\shared_config.py' --port 4176 --backend-port 8879
```

本地配置字段为 `sourceRoot`、`dataRoot`、`sharedConfig`，模板见 `integration/sop.example.json`。`dataRoot` 是包含 `data/` 和 `input_file/` 的数据源项目目录，不等同于后端配置中的 `data_dir`。源码选择优先级为 `--sop-source`、`SOP_SOURCE_ROOT`、本地配置、实际兄弟目录。`--seed-from` 只选择数据来源，不选择运行代码。原项目未完成 gateway 适配时明确报错，不回退副本。

`npm run dev` 与 `npm start` 相同；`npm run dev:static` 只提供静态门户和 OrderIQ；`npm run dev:sop -- --sop-source <原项目路径>` 使用演示数据，但仍从原项目运行代码。本地预览不能替代内网 Windows 认证验收。

## SOP 独立运行与发布

原 SOP 的 `启动工作台.cmd`、`start-sop.ps1` 与 `python server.py` 独立运行方式保留。SOP 业务、身份适配、前端、测试及发布构建器均在原仓库维护。

先从原项目生成全新发布目录，再由门户消费该产物：

```powershell
python 'D:\05 AI脚本\PythonProject\计划看板\scripts\build_release.py' --destination 'D:\05 AI脚本\统一门户\staging\sop-release-new'
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\New-DeploymentPackage.ps1 -Destination .\staging\DataPlatform-new -IncludeSop -SopReleasePath 'D:\05 AI脚本\统一门户\staging\sop-release-new'
```

目录必须为全新版本目录。SOP 产物中的 `sop-release.json` 记录源提交、工作区状态、文件哈希；门户打包验证完整性并拒绝额外文件。部署包的 `services/sop` 仅是运行时产物布局，不是门户 Git 中的业务源码。IIS 身份桥接源码由 SOP 产物提供。

数据库、原始 Excel、真实共享规则及运行机密不进入 SOP 发布产物。OrderIQ 的业务发布 HTML 也不提交 Git，需通过 `scripts/Import-OrderIQ.ps1` 导入自己的发布文件。依赖版本由原 SOP 的 `requirements-intranet.txt` 唯一维护，离线 wheel 放在忽略的 `offline/wheels`。

## 文档

- [单一源码核对、备份与验证记录](docs/single-source-migration.md)
- [SOP 内网部署](docs/sop-intranet.md)
- [IIS 通用部署](docs/iis-deployment.md)
- [应用接入规范](docs/app-integration.md)
- [本地排查](docs/troubleshooting.md)

本轮不推送、不部署，不修改仓库可见性或 IIS/安全设置。旧版本发布包保留为历史回滚产物，不作为新构建的源码输入。
