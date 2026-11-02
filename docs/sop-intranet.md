# SOP 接入与内网部署

当前目录是外网开发/验收环境，最终部署在内网 IIS。`services/sop/` 为独立 SOP 项目的适配发布副本，包含源代码及测试，不携带原项目数据库、Excel 或本机依赖。部署参数在内网填写；本次没有创建 IIS 应用、计划任务或域组权限。

## 接入方式与可信身份

- 入口 `/sop/` 是独立 IIS Application，使用专用 **.NET Framework 4.x / Integrated** 应用池。IIS 负责 Windows Authentication，匿名认证关闭。
- ARR 只转发到 `127.0.0.1:8876/sop/`，保留 `/sop/` 前缀；Python 服务仅监听回环地址。门户和 SOP 使用同一个协议、主机与端口。
- URL Rewrite 的分布式规则在 BeginRequest 执行，早于 Windows 身份验证。因此不使用 `{LOGON_USER}` 重写头。受审 C# `SopIdentityBridge` 在 PostAuthenticateRequest 验证真实 WindowsIdentity，再覆盖 `X-SOP-User` 和 `X-SOP-Proxy-Key`。用户名以 `b64:` 加 UTF-8 Base64 传递，以支持中文账号。
- 桥接模块先移除客户端同名头；Python 再校验每个请求的秘密、可信用户名和路径前缀。服务端记录登录身份，不把页面填写的维护人当作真实操作人。
- 每个 POST 都由桥接模块调用 WindowsPrincipal.IsInRole 校验显式域组，并校验 Origin；Python 的 `allow_writes` 为第二道开关。`WriteGroups: []` 时所有 POST 均拒绝，包含导入、导出 POST、计划维护、源刷新和写权限探测。GET/HEAD 可供已认证用户查看。
- 只读界面是使用反馈，真正的访问限制在 IIS 模块和后端。前端无法通过伪造 owner 或自报用户头提权。

内网必须安装 IIS 静态内容、Windows Authentication、ASP.NET 4.x（含 .NET Extensibility/ISAPI）、IIS 管理 API、URL Rewrite 及 ARR。仅基础门户和 OrderIQ 不需要 ASP.NET；SOP 的可信身份桥接需要该组件。ARR 全局代理开关由管理员评估后开启，脚本不会更改全局设置。

## 1. 在开发机生成带 SOP 的发布包

```powershell
npm run check
npm test
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\New-DeploymentPackage.ps1 -Destination .\staging\DataPlatform-0.2.0 -IncludeSop
```

发布包包含门户、OrderIQ、SOP Python/静态源、部署工具、此文档，以及 `offline/wheels/` 中固定版本的 openpyxl/et_xmlfile。默认不含 Python 安装程序；内网服务器需预先安装组织认可的 Python 3.10+。生产 Excel 引擎设置为 Python，不依赖外网、Node.js 或 Codex artifact-tool。

`config/sop.example.json` 与 `deploy/sop-iis.example.json` 是示例。不会把外网机器的用户名、路径、凭据或业务数据自动当作生产配置。不要使用旧的 0.1.0 发布包覆盖新包。

## 2. 内网准备目标目录与基础站点

将发布包复制到新的目录，例如 `D:\DataPlatform`。按照 [IIS 部署说明](iis-deployment.md) 创建并保持基础站点停止状态，确认 `config/iis.json` 的目录、域名及端口与内网一致。

运行离线安装（以下命令从发布包根目录执行）：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Install-SopDependencies.ps1 -DeploymentRoot D:\DataPlatform -PythonPath C:\Python314\python.exe -WhatIf
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Install-SopDependencies.ps1 -DeploymentRoot D:\DataPlatform -PythonPath C:\Python314\python.exe
```

脚本核对 SHA256SUMS 中固定的两个 wheel，只从包内安装到 `runtime/sop-venv`，使用 `--no-index`，不访问 PyPI。

## 3. 配置真实 Origin、服务账号与域组

```powershell
Copy-Item .\deploy\sop-iis.example.json .\config\sop-iis.local.json
# 编辑副本中的真实 SiteName、DeploymentRoot、PublicOrigin、BackendPort。
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Configure-SopProxy.ps1 -ConfigPath .\config\sop-iis.local.json -PlanOnly
```

`PublicOrigin` 必须精确填写用户访问的源，如 `https://data.company.internal` 或 `http://data.company.internal:8080`，不含末尾 `/` 和其他路径。HTTPS 在此 IIS 终止时配置正式证书及 HTTPS 绑定；本脚本不猜测证书和域名。

`WriteGroups` 初始保持空数组，只读验收时无需猜测域组。确定写入范围后填写明确的 `DOMAIN\Group` 字符串数组；JSON 中反斜杠要转义，例如 `["COMPANY\\SOP-Editors"]`。

为 Python 后台任务准备专用低权限域账号，例如 `COMPANY\svc-sop`，授予“作为批处理作业登录”和所需本地目录权限。不要使用 SYSTEM 或管理员账号。应用池身份只读取代理配置与秘密；Python 服务账号读取源数据/共享规则，在 `data/sop` 和 `logs/sop` 写入，不需要写门户根目录。

在内网管理员 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Configure-SopProxy.ps1 -ConfigPath .\config\sop-iis.local.json -ServiceAccount 'COMPANY\svc-sop' -Apply -WhatIf
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Configure-SopProxy.ps1 -ConfigPath .\config\sop-iis.local.json -ServiceAccount 'COMPANY\svc-sop' -Apply
```

脚本预检模块/目标站点，拒绝替换不属于此部署的 `/sop` 应用或池。Apply 生成 `proxy/sop/web.config` 和编译后的受审身份模块 DLL，在 `applicationHost.config` 只设置该应用的 Windows/匿名认证。不会开放全局 serverVariables 或解锁认证节。

秘密仅在内网 Apply 时用加密随机数生成到 `config/sop-proxy.secret`，不输出到日志和参数，也不放进发布包。ACL 限制为管理员、SYSTEM 及指定 Python 账号/应用池身份读取。`config/sop-auth.json` 保存域组和秘密路径；`config/sop.json` 保存后端配置。写开关依据 WriteGroups 自动生成，二者必须一致。重配完成后需重启 Python 任务，确保加载新配置。

## 4. 迁移业务数据与共享规则

先编辑 `config/sop.json` 中的 `data_dir`、`source_dir`、`shared_config`、`plan_file`，全部指向服务器非 Web 目录。不能使用开发机盘符路径或空汇总规则冒充生产口径。

- 复制内网既有 OrderIQ 使用的真实 shared_config.py 到配置路径；该文件属于业务配置，不在本发布包中造默认值。
- 首次初始化必须有经过验证的 `sales.json` 快照，或完整真实原始 Excel（包括应用需要的锁单/大定源）。空 source_dir 不能初始化业务销量。
- 迁移已有计划时停止原 SOP 写入，使用 SQLite backup API 导出一致快照后复制到新 `data_dir/sop.sqlite3`，并迁移相匹配的 sales.json、source_settings.json 和计划维护表。不要对运行中的 sqlite3 文件做普通热拷贝而遗漏 WAL。
- 新数据库与旧数据库不要同时指向同一维护 Excel，避免两个写入进程。首次启动前保留原始文件和上一版数据库的备份。

SOP 服务的运行数据和备份都应位于 `data/sop`，服务源代码位于 `services/sop`；这些目录均不映射为 IIS 静态目录。

## 5. 注册受控后台任务

本方案使用 Windows Task Scheduler 开机运行，不依赖开发人员的命令窗口。S4U 任务不保存密码，但不能访问网络共享或 EFS；源码、数据和配置都必须在该服务器本地。若组织要求专用 Windows 服务或网络共享数据，应改用组织认可的服务宿主/托管账号流程，不在脚本中硬编码密码。

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Register-SopTask.ps1 -DeploymentRoot D:\DataPlatform -ServiceAccount 'COMPANY\svc-sop'
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Register-SopTask.ps1 -DeploymentRoot D:\DataPlatform -ServiceAccount 'COMPANY\svc-sop' -Apply -WhatIf
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\deploy\Register-SopTask.ps1 -DeploymentRoot D:\DataPlatform -ServiceAccount 'COMPANY\svc-sop' -Apply
```

默认只打印计划，Apply 注册后也不立刻启动。任务设置开机启动、单实例、无最长运行时间、故障后 1 分钟重试，最多 3 次；需要运维监测超过重试次数后的失败状态。`Start-SopService.ps1` 从同一受保护秘密文件读取到子进程环境，启动虚拟环境 Python 并设置 `SOP_EXCEL_ENGINE=python`；秘密不会出现在进程参数中。服务输出写入 `logs/sop/service.log`。

在任务计划程序启动任务，检查进程/日志后再启动 IIS 站点。通过 IIS `/sop/api/health` 检查服务，直接访问 8876 会因缺少可信代理信息被拒绝，属于预期行为。

## 6. 内网验收后开放写入

1. 只读阶段：WriteGroups 为空，认证用户可打开门户和 SOP，修改、导入、刷新源和 POST 导出被拒绝；手工请求写 API 也不能成功。
2. 配置真实域组后重配/重启：组内用户可以通过写权限探测与正常业务写入，组外用户保持只读。修改应在历史中记录真实 Windows 登录人。
3. 使用伪造 X-SOP-User/Key、空 Origin、跨源 Origin、根 `/api/`、直接回环地址分别检查，都不能绕过权限。
4. 在 `/sop/` 内验证 JS/CSS、API、Excel 下载/导入、刷新数据和 iframe；计划写入/导入须用经过授权的验收数据完成，确认备份及回退。
5. 检查服务器重启、Python 崩溃重启、计划任务权限、维护表冲突和磁盘日志清理；正式启用基础站点自动启动。

本机验证覆盖源码、编译、计划和 HTTP 协议，不能替代内网真实 Windows 域组和 IIS 管线验收。

启用并保留 IIS W3C 日志中的用户、请求方法、URI、状态和时间字段；在身份桥接层被拒绝的请求不会到达 Python，需从 IIS 日志审查。Python 日志记录到达业务服务的可信用户和写入结果，两者结合排查权限与操作审计。

## 官方依据

- [Microsoft：URL Rewrite 规则执行时机](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/url-rewrite-module-configuration-reference)：分布式规则在 BeginRequest 执行。
- [Microsoft：IIS/ASP.NET Integrated 管线](https://learn.microsoft.com/en-us/iis/application-frameworks/building-and-running-aspnet-applications/aspnet-integration-with-iis)：认证、PostAuthenticateRequest 及后续处理的顺序。
- [Microsoft：WindowsPrincipal.IsInRole](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsprincipal.isinrole)：依据 Windows 身份检查组角色。
- [Microsoft：Task Scheduler S4U](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)：不存储密码，不能访问网络或加密文件。
