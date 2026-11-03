# 单一 SOP 源码的内网接入

门户架构保持不变：IIS 统一入口、静态门户、独立 SOP 服务和同源 `/sop/` 代理。唯一业务源码在 `../PythonProject/计划看板`。门户 Git 不保留 `services/sop` 业务源码；部署目录中同名路径只存放原项目构建的运行产物。

文档中的开发路径以门户根目录为基准；以下命令从门户根目录执行。原项目不在默认相对位置时，先定位并调整本地配置。

## 开发与构建

原项目保留独立本机运行方式；显式 `--gateway-config` 才开启前缀、同源嵌入、可信身份与默认只读。业务测试和导入导出测试在原 SOP 运行。门户测试只验证接入、参数、代理和发布清单。

```powershell
$sopRelease = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'staging/sop-release-new'))
python '../PythonProject/计划看板/scripts/build_release.py' --destination $sopRelease
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\New-DeploymentPackage.ps1 -Destination .\staging\DataPlatform-new -IncludeSop -SopReleasePath $sopRelease
```

`--destination` 必须为绝对路径，上例由相对发布目录动态解析，不绑定开发机盘符。使用全新的版本目录。构建器排除数据库、Excel、真实共享规则、机密、测试输出和本地运行时；清单记录源提交、是否有未提交变更以及每个文件的 SHA256。门户拒绝缺少显式产物、哈希不符、额外文件和路径越界，不再复制仓库内的业务源码或补丁。

## 身份与权限

IIS 的 `/sop` 独立 Application 使用 .NET4 Integrated、Windows Authentication 和 ARR。原 SOP 产物中的 `integration/iis/SopIdentityBridge.cs` 在认证后确认 Windows 用户、检查写入域组和 Origin，再覆盖代理 key 与身份头。后端再次校验回环代理、key、用户、路径前缀和 Origin，并记录可信操作人。

默认 `WriteGroups` 为空、`allow_writes` 为 false；前端只读不是权限边界。用户组后填，所有 POST（包括导入及 POST 导出）受限。独立模式不启用该代理协议。代码与离线编译测试不能代替真实域认证及 IsInRole 验收。

## 目标服务器手工工作

以下是管理员后续操作说明，本轮没有执行任何 Apply、任务注册、IIS、安全设置或部署动作：

1. 核对目标服务器的 IIS、Windows Authentication、ASP.NET4、URL Rewrite、ARR、HTTPS 及正式域名。
2. 将审核后的发布包复制到独立新目录，以实际发布目录作为发布根，不约定固定盘符。IIS 网站根目录仅指向发布根下的 `portal`；要求绝对路径的服务器参数由实际发布根解析生成。
3. 配置外部 `config/sop.json`、真实共享规则和 `data/sop`；原始文件、SQLite、维护表和日志均位于 Web 根目录之外。
4. 使用包内 `Install-SopDependencies.ps1` 按 SOP 产物的 requirements 和校验过的离线 wheel 安装运行环境。
5. 通过通用配置脚本的只读预检/PlanOnly 检查；由管理员审阅后再手工决定 Apply。身份桥接编译器只接受显式的 SOP 产物源文件。
6. 明确 Python 服务账号及读取/写入目录；若使用提供的后台任务方案，S4U 不保存密码且不能访问网络共享。
7. 默认只读验收后，再由管理员配置写入域组，重启相关服务并用组内、组外用户验证接口、导入导出和审计。

部署脚本消费 `services/sop/sop-release.json` 并验证运行产物。代码更新由原 SOP 重建新产物，不在部署目录直接维护业务源码。

## 数据迁移

需要迁移现有计划时，先安排原业务停止写入，用 SQLite backup API 导出一致快照，再复制匹配的 `sales.json`、`source_settings.json` 和计划维护表；不要热拷漏掉 WAL。不要让两个写入进程指向同一维护表。本次未删除、搬迁或写入原业务数据。

## 验收

验证门户 iframe、直接 `/sop/`、资源和 API 前缀；只读用户/授权用户、伪造身份、缺失及跨源 Origin；真实计划导入导出及可信操作人；数据/输入/维护表外置路径；服务重启和回退。域组、证书、ACL 和 IIS 管线仍需要目标内网环境人工完成。
