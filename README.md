# 智选车统一门户

纯 HTML / CSS / JavaScript 门户，通过同源 iframe 承载独立业务应用；生产入口为 IIS。本仓库无需前端构建、npm 安装或外部 CDN。Node.js 仅用于本地预览和测试。

## 当前进度

- 完成配置驱动分组菜单、应用搜索、工作台、地址直达、浏览器前进/后退、加载状态、超时、错误提示和重试。
- 已接入本地 OrderIQ 发布副本，原业务项目保持独立。
- SOP 动态服务已完成门户适配，源码副本位于 `services/sop`；使用 `/sop/` 路径、可信代理身份与默认只读策略。
- 提供 IIS 部署包生成、预检/安装脚本及 ARR 规则示例；尚未修改本机或生产 IIS。
- Windows 登录名需要服务端接口才能显示。未配置接口时仅显示“企业工作空间”，不伪造当前登录用户。

## 本地运行

要求 Node.js 20+（开发机实际使用 22.23.2）。在项目根目录运行：

```powershell
npm run check
npm test
npm run dev
```

打开 `http://127.0.0.1:4173/`。`npm run dev` 仅预览静态门户与 OrderIQ；SOP 联调使用下面命令。本地预览仅监听回环地址，没有 Windows 认证，不能用它代替生产 IIS。停止时按 Ctrl+C。

## 一并预览 SOP

安装 Python 3.10+ 和已固定依赖后运行：

```powershell
python -m pip install --no-index --find-links .\offline\wheels -r .\services\sop\requirements-intranet.txt
npm run dev:sop
```

默认使用演示数据且关闭写入。使用现有本机 SOP 的隔离数据快照验收：

```powershell
npm run dev:sop -- --seed-from 'D:\Projects\SOP' --shared-config 'D:\Projects\OrderIQ\scripts\config\shared_config.py'
```

预览会通过 SQLite 在线备份建立隔离副本，原业务库不被该预览写入。可选 `--shared-config <原始共享规则路径>`。内网部署不需要 Node.js；仅开发预览使用 Node。

## 带入内网

公开 Git 仓库只保存源代码、测试和配置模板。OrderIQ 发布网页、SOP 业务数据、本地截图、离线 wheel 及发布 ZIP 均不上传 Git；文中的 `staging/` 和 `offline/` 是开发机生成目录。新克隆仓库需先导入自己的 OrderIQ 发布文件；联网开发机可用 `python -m pip install -r services/sop/requirements-intranet.txt` 安装 SOP 依赖，再运行演示预览。

完整步骤见 [SOP 内网部署](docs/sop-intranet.md)。当前提供 `staging/DataPlatform-0.2.0` 发布包，含门户、OrderIQ、SOP 源码、离线 Python wheel、IIS 身份模块源码及脚本。内网 IIS 的 ARR、URL Rewrite、ASP.NET 4.x 和 Windows Authentication 仍需由管理员安装并验收。

域名和写入域用户组在内网填写；默认不开放写入。业务数据库、原始 Excel 和真实共享规则应从内网现有系统迁移到 Web 根目录外，不随代码包自动复制。`deploy/sop-upstream.patch` 可用于将本轮适配回合并到原 SOP 独立仓库，已做 `git apply --check` 验证。

入口 `portal/index.html` 必须通过 HTTP(S) 打开，不支持直接双击文件。OrderIQ 产物不提交 Git；在其他开发机需先导入发布副本：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\Import-OrderIQ.ps1 -SourceHtml 'D:\实际路径\鸿蒙智行订单分析汇总.html'
```

导入时间/产物文件修改时间并不等于业务数据更新时间。门户只在应用配置明确提供时显示数据更新时间，否则由应用自身说明。

## 目录

```text
portal/        IIS 门户根目录，可直接发布
  config/      公开的应用注册表，不放任何凭据
  css/ js/     门户样式和逻辑
apps/          本地独立应用发布副本（业务产物被 Git 忽略）
deploy/        IIS 配置模板与部署脚本
scripts/       本地预览、检查、OrderIQ 导入
services/sop/  SOP 门户适配源码副本
offline/wheels/ 已校验的 Python 离线安装包（不提交 Git）
tests/         配置与本地服务测试
docs/          实施记录、应用接入和部署文档
```

生产目录结构、参数和命令见 [IIS 部署说明](docs/iis-deployment.md)。应用配置约定见 [应用接入规范](docs/app-integration.md)。现有系统发现及未完成项见 [实施记录](docs/implementation.md)。

## 版本发布约定

门户与业务应用独立版本、独立仓库。发布新门户只替换 portal，发布新 OrderIQ 只替换 apps/orderiq。各自先生成新版本目录并验证，再切换 IIS 物理路径；保留上一个版本目录便于回退。不要把数据目录、服务代码、日志、仓库或凭据放进门户 Web 根目录。

当前未配置 GitHub/CodeHub remote 或 CI，因为现有目录未提供同步脚本、项目地址及内网发布凭据。可在现有单向同步链路中调用本仓库的检查与打包命令；门户不承担业务数据生成。
