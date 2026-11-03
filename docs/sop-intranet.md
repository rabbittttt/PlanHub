# 单一 SOP 源码的内网接入

> 当前边界：用户确认保留既有改动，今后门户只做集成，不修改任何子应用源码、UI 或业务行为。下文原项目适配内容描述已有实现或历史记录，不构成继续修改原项目的授权；详见[集成边界](integration-boundary.md)。

门户架构保持不变：IIS 统一入口、静态门户、独立 SOP 服务和同源 `/sop/` 代理。唯一业务源码在 `../PythonProject/计划看板`。门户 Git 不保留 `services/sop` 业务源码；部署目录中同名路径只存放原项目构建的运行产物。

文档中的开发路径以门户根目录为基准；以下命令从门户根目录执行。原项目不在默认相对位置时，先定位并调整本地配置。

## 开发与构建

原项目保留独立本机运行方式；显式 `--gateway-config` 才开启前缀、同源嵌入、可信身份与服务级写入开关。业务测试和导入导出测试在原 SOP 运行。门户测试只验证接入、参数、代理和发布清单。

```powershell
$sopRelease = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'staging/sop-release-new'))
python '../PythonProject/计划看板/scripts/build_release.py' --destination $sopRelease
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\New-DeploymentPackage.ps1 -Destination .\staging\DataPlatform-new -IncludeSop -SopReleasePath $sopRelease
```

`--destination` 必须为绝对路径，上例由相对发布目录动态解析，不绑定开发机盘符。使用全新的版本目录。构建器排除数据库、Excel、真实共享规则、机密、测试输出和本地运行时；清单记录源提交、是否有未提交变更以及每个文件的 SHA256。门户拒绝缺少显式产物、哈希不符、额外文件和路径越界，不再复制仓库内的业务源码或补丁。

## 身份与权限

IIS 的 `/sop` 独立 Application 使用 .NET4 Integrated、Windows Authentication 和 ARR。原 SOP 产物中的 `integration/iis/SopIdentityBridge.cs` 在认证后确认 Windows 用户、检查 Origin，再覆盖代理 key 与身份头。后端再次校验回环代理、key、用户、路径前缀和 Origin，并记录可信操作人。

部门成员拥有相同业务功能，不再检查写入域组。部署模板使用 `AllowWrites: true`，与后端 `allow_writes: true` 配对，统一允许计划维护、导入及导出。将两者同时改为 false 仅用于暂停全服务写入；不是成员角色。仍保留 Windows 登录、可信操作人、Origin、代理 key 与回环校验。独立模式不启用该代理协议。部门入口只允许内部成员访问的条件仍需在内网验收，不能把 Windows 登录本身当作部门成员筛选。

## 目标服务器手工工作

以下是管理员后续操作说明，本轮没有执行任何 Apply、任务注册、IIS、安全设置或部署动作：

1. 核对目标服务器的 IIS、Windows Authentication、ASP.NET4、URL Rewrite、ARR、HTTPS 及正式域名。
2. 将审核后的发布包复制到独立新目录，以实际发布目录作为发布根，不约定固定盘符。IIS 网站根目录仅指向发布根下的 `portal`；要求绝对路径的服务器参数由实际发布根解析生成。
3. 配置外部 `config/sop.json`、真实共享规则和 `data/sop`；原始文件、SQLite、维护表和日志均位于 Web 根目录之外。
4. 使用包内 `Install-SopDependencies.ps1` 按 SOP 产物的 requirements 和校验过的离线 wheel 安装运行环境。
5. 通过通用配置脚本的只读预检/PlanOnly 检查；由管理员审阅后再手工决定 Apply。身份桥接编译器只接受显式的 SOP 产物源文件。
6. 明确 Python 服务账号及读取/写入目录；若使用提供的后台任务方案，S4U 不保存密码且不能访问网络共享。
7. 确认入口仅供部门访问后，使用不同部门成员验证相同的接口、维护、导入导出能力和各自的操作记录；额外验证入口外用户无法访问。

部署脚本消费 `services/sop/sop-release.json` 并验证运行产物。代码更新由原 SOP 重建新产物，不在部署目录直接维护业务源码。

## 数据迁移

需要迁移现有计划时，先安排原业务停止写入，用 SQLite backup API 导出一致快照，再复制匹配的 `sales.json`、`source_settings.json` 和计划维护表；不要热拷漏掉 WAL。不要让两个写入进程指向同一维护表。本次未删除、搬迁或写入原业务数据。

## 验收

验证门户 iframe、直接 `/sop/`、资源和 API 前缀；不同部门成员相同业务能力、未获准进入部门入口的访问、伪造身份、缺失及跨源 Origin；真实计划导入导出及可信操作人；数据/输入/维护表外置路径；服务重启和回退。部门入口、证书、ACL 和 IIS 管线仍需要目标内网环境人工完成。

## 从旧写入域组配置迁移

本次仅更新源码、模板和本地预览，没有执行 IIS Apply。已有服务器必须先保留配置与发布物备份，由管理员重新构建唯一 SOP 原项目发布物及其身份桥接模块，并审阅新配置。将旧 `WriteGroups` 字段移除，显式配置服务级 `AllowWrites: true`；重新生成匹配的 `sop-auth.json` 与 `sop.json` 后再重启服务。不能只改一个开关或继续使用旧 DLL。旧字段、缺失开关或两端开关不一致会被拒绝，不会静默扩大旧配置的写入范围。

本地 `npm start` 与 `npm run dev:sop` 使用可写的隔离快照；修改不会回写原 SOP 数据，重启创建新快照。预览身份只用于本机验收，不能作为真实 Windows 登录证明。

## 部门统一功能验收（2026-11-03）

- 门户 `npm run check`、17 项 Node 测试通过；预览测试实际写入隔离文件并确认源数据不变。
- SOP 16 项网关接口测试、5 项 Excel 上传下载 HTTP 测试及前端网关测试通过；覆盖不同成员相同写入能力、独立操作人留痕、伪造身份/错误 Origin 拒绝、服务暂停与独立运行。
- Windows PowerShell 5.1 部署测试通过：布尔开关校验、旧字段拒绝、C# 编译、原项目构建、发布清单与打包核验、仅计划/WhatIf 检查；未执行 IIS 或任务变更。
- 浏览器使用隔离演示数据验证计划保存（123）、导出接口 200 与页面成功提示，桌面/375px 手机无门户横向溢出，导航、Escape 焦点、搜索与分组正常，无控制台错误。浏览器自动化的下载事件回调超时，未取得浏览器下载文件路径；Excel 文件内容与上传下载协议由上述 HTTP 测试验证。
- 本地截图位于忽略目录 `artifacts/department-access-desktop.jpg`、`artifacts/department-access-mobile.jpg`；原 SOP 改动前备份位于 `artifacts/uniform-access-before-20261103/`，不提交业务数据或备份。
- 真实 Windows 部门入口、不同域账号访问、目标服务器导入导出和重启仍需在内网人工验收。
