# IIS 部署与验收

使用一个新的 IIS 站点作为入口，`portal/` 原样发布；OrderIQ 作为独立 IIS Application 挂载到 `/orderiq/`。基础配置示例默认只创建静态应用。SOP 的子路径、同源嵌入和身份协议现已提供适配副本；其独立代理应用、可信 Windows 身份桥接、后台任务及离线依赖按照 [SOP 内网部署](sop-intranet.md) 配置，默认只读。

工作机已发现运行中的 IIS，但当前进程读取配置时因 `redirection.config` 权限不足失败。本次只生成可审核的文件和脚本，没有创建、修改或启动 IIS 站点，也没有验证 Windows 域登录和 ARR。

## 文件用途

| 文件 | 用途 |
| --- | --- |
| `deploy/config.example.json` | 新站点名称、端口、域名、部署根目录、静态应用开关；部署前复制并修改 |
| `deploy/New-DeploymentPackage.ps1` | 在全新目录生成发布包，拒绝覆盖，支持 `-WhatIf` |
| `deploy/Install-IisSite.ps1` | 默认只读预检；`-PlanOnly` 离线检查；`-Apply` 创建新的、停止状态站点，支持 `-WhatIf` |
| `deploy/portal.web.config` | 门户默认文档、同源嵌入响应头、配置继承边界；打包时写入 `portal/web.config` |
| `deploy/arr-rules.example.xml` | 动态服务的可选 URL Rewrite 规则片段，不自动应用 |
| `deploy/Configure-SopProxy.ps1` | SOP 专用后认证身份桥接与代理配置，默认计划/预检；Apply 才修改指定应用 |

脚本兼容 Windows PowerShell 5.1。IIS 检查和安装使用 64 位 PowerShell；安装需要服务器管理员权限。

若本机执行策略禁止本地脚本，按组织规范使用签名脚本；在允许执行已审核本地脚本的环境，可用 `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File <脚本路径> <参数>`，该参数只影响本次进程，不修改机器执行策略。本次 PS5.1 验证采用此方式。

## 1. 准备发布目录

在项目根目录执行，先准备本地发布包：

```powershell
Copy-Item -LiteralPath '.\deploy\config.example.json' -Destination '.\deploy\config.local.json'
# 编辑 config.local.json，填写目标服务器真实参数。
.\deploy\Install-IisSite.ps1 -ConfigPath '.\deploy\config.local.json' -PlanOnly
.\deploy\New-DeploymentPackage.ps1 -ConfigPath '.\deploy\config.local.json' -Destination '.\deploy\releases\DataPlatform-001' -WhatIf
.\deploy\New-DeploymentPackage.ps1 -ConfigPath '.\deploy\config.local.json' -Destination '.\deploy\releases\DataPlatform-001'
```

发布包包含 `portal/` 和本仓库 `apps/<name>/` 中已启用静态应用的发布文件。启用的静态应用必须有 `index.html`。脚本拒绝源目录、父目录和目标父目录中的重解析点，避免目录联接意外入包，还拒绝常见非公开条目。这里仅放已审核发布产物，不放业务应用完整源码、数据库、导入 Excel、密钥或备份。

新版本打包加 `-IncludeSop` 时，还包含受控 SOP 发布源码和离线 Python wheel；发布包现附带 deploy 工具与 docs。SOP 的业务数据、Excel 和身份秘密仍不入包。

```text
DataPlatform-001/
  portal/                 -> IIS 网站根目录
  apps/orderiq/           -> IIS 独立应用 /orderiq/
  apps/inventory/         -> 预留，默认不启用
  services/               -> 服务程序，不映射到 IIS 静态目录
  data/                   -> 业务数据，不映射到 IIS 静态目录
  logs/                   -> 服务日志，不映射到 IIS 静态目录
  config/iis.json         -> 服务器部署参数，不映射到 IIS 静态目录
```

将发布包复制到目标服务器的新目录，例如 `D:\DataPlatform`。`config/iis.json` 的 `DeploymentRoot` 必须与最终位置相同。IIS 物理根目录只能设为其中的 `portal`，不要设为 `D:\DataPlatform`。公开的 `portal/config/apps.json` 是前端菜单配置，不存放凭据或授权规则；它与外部的服务器 `config/` 是两个目录。

本次 OrderIQ 静态 HTML 已嵌入业务数据快照，所有能访问 `/orderiq/` 的用户都能获得这些数据。发布前需确认允许访问人群；后续把 Excel/SQLite 放到 `data/` 不会撤回 HTML 内已有数据。

## 2. 预检并创建新站点

服务器需要 IIS 静态内容、默认文档、Windows 身份验证及管理工具。仅静态门户与 OrderIQ 不要求 ARR。动态应用上线时才需 URL Rewrite、ARR；需要 WebSocket 的应用还需 IIS WebSocket 功能与单独验收。

在目标服务器的管理员 PowerShell 中，使用本项目部署脚本：

```powershell
.\deploy\Install-IisSite.ps1 -ConfigPath 'D:\DataPlatform\config\iis.json'
.\deploy\Install-IisSite.ps1 -ConfigPath 'D:\DataPlatform\config\iis.json' -Apply -WhatIf
.\deploy\Install-IisSite.ps1 -ConfigPath 'D:\DataPlatform\config\iis.json' -Apply
```

默认预检检查目标文件、模块、同名站点/应用池、HTTP 绑定冲突及可选 ARR 开关。`-PlanOnly` 仅检查 JSON 并打印计划，不能替代服务器预检。同名站点或应用池已存在时直接拒绝，本脚本不覆盖升级现有站点。

`-Apply` 创建一个不加载 .NET CLR 的新应用池、一个**停止状态**的新站点及启用的静态应用。Windows 认证开启、匿名认证关闭，设置写入 `applicationHost.config` 对应站点和应用的 location，避开 `web.config` 中常被锁定的认证节。一次 IIS 管理配置提交完成创建。脚本不更改现有站点、全局 ARR、DNS、证书、文件 ACL 或防火墙。

默认 HTTP 8080、空主机名用于隔离验收。同端口有通配主机绑定时预检拒绝。正式上线应填写真实域名，配置组织认可的 HTTPS 证书和绑定，再切换入口；脚本不猜测域名或证书。

启动前，由服务器管理员为应用池身份及需要的 Windows 用户/组配置相应读取权限。IIS 认证和 NTFS 权限都会影响访问；业务数据写权限只授予实际服务身份。按组织要求配置 IIS URL Authorization 或后端授权，菜单 `enabled` 不能实现访问控制。

在 IIS 管理器核对新站点物理路径、应用路径和认证后启动站点。`ServerAutoStart` 默认关闭，验收后按运维要求启用。现有站点的域名和绑定不由此脚本切换。

## 3. 门户与业务应用的嵌入策略

所有应用采用相同协议、主机、端口。业务应用响应应允许同源 iframe，例如 `X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: frame-ancestors 'self'`。业务应用返回 `DENY` 时必须修改业务应用；只改门户响应头无效。

门户 IIS 配置通过 `inheritInChildApplications="false"` 隔离默认文档、缓存和响应头。业务应用必须创建为 **IIS Application**，普通虚拟目录无法取得这一继承边界。子应用自行维护 CSP 和静态资源设置，避免门户严格脚本策略破坏旧 HTML 内联脚本。

ARR 响应属于门户根应用，所以根配置只发送 `frame-ancestors 'self'`，不限制代理应用内联脚本/样式。门户自身 HTML 用 CSP meta 限定脚本、样式和 iframe 来源；`frame-ancestors` 仍由 HTTP 响应头提供。后端已经返回安全头时，检查最终响应是否有重复或冲突的策略。

纯静态页面无法直接获得 IIS 当前 Windows 用户名。显示真实用户名需要经过 IIS 认证的 `/api/me` 服务；不要从浏览器提交的 `X-User` 或查询参数认定身份。

## 4. 后续接入动态服务

`arr-rules.example.xml` 使用未接入的 `/leads/` 与 `127.0.0.1:8501` 演示，**不是 SOP 的部署配置**。适配后的 SOP 使用 `127.0.0.1:8876`、保留 `/sop/` 前缀，并由专用后认证模块注入可信身份；使用 [SOP 内网部署](sop-intranet.md) 中的专项脚本。下列通用示例仅用于其他后续动态应用。

1. 服务以受控 Windows 服务运行，绑定回环地址，设置崩溃恢复、日志和服务身份，不能依赖个人命令行窗口。
2. 安装 URL Rewrite、ARR。ARR 代理开关属于服务器全局配置，由管理员评估其他站点影响后开启；本脚本只检查，不自动开启。
3. 按实际应用修改示例规则，将 `<rewrite>` 合入门户 `web.config` 的 `<system.webServer>`。这是片段，不能直接替换整个配置。将 `RequireReverseProxy` 改为 `true`，使预检检查 ARR。
4. 示例把 `/leads/item?q=1` 转发为 `http://127.0.0.1:8501/item?q=1`，剥离 `/leads/` 前缀。后端仍必须生成 `/leads/` 开头的资源、跳转、表单、Cookie Path、WebSocket 地址，不能让 `/static`、`/api` 落到门户根。也可让后端原生挂载 `/leads/` 并保留前缀，但代理规则须同步修改，二者择一。
5. Vue 等前端按公共前缀构建；history 路由回退只配置在对应业务应用内。门户不需要全站 SPA fallback，也不应依靠通用 HTML 替换掩盖资源路径错误。
6. 核对后端 Host/Origin/代理信任与重定向设置。示例不注入或信任用户身份头；Windows 认证代理不自动赋予后端逐用户授权。需要身份桥接时，另行设计 IIS 覆盖写入、后端只信任受控代理的方案，防止请求头伪造。

先从门户同域地址完成接口读写、权限验收，再启用动态应用菜单；`apps.json` 不登记回环端口 URL。

## 5. 验收与回退

| 检查 | 预期 |
| --- | --- |
| 门户 `/`、`/config/apps.json` | 认证后返回成功，无匿名旁路 |
| 未认证请求直达 `/orderiq/` | IIS 发起身份验证，禁用用户不能获取数据 |
| 门户打开 OrderIQ | 工作区内加载，无 iframe 拒绝或资源 404 |
| 直接访问 `/orderiq/` 及刷新 | 能独立使用，资源路径保持应用内 |
| `/data/`、`/services/`、`/logs/` | 无文件映射，业务数据不能静态下载 |
| 隐藏菜单后直接访问应用 URL | 访问权仍由 IIS/后端决定 |
| 代理资源、跳转、Cookie、写 API | 公共路径及权限正确，服务重启后恢复 |
| 浏览器网络与控制台 | 无混合内容、跨域错误或 CSP 冲突 |
| 服务器重启 | IIS 站点及业务服务按运维设置恢复 |

首次上线保留原站点和原产物，验收后再切入口。门户与各业务应用分别版本化；升级只发布对应目录，保留上一版本和配置。回退恢复受影响应用上一版，不为单应用回退覆盖全局 IIS 配置。新站点失败时保持停止并检查日志，不自动删除归属不明的站点或目录。

## 官方依据

- [Microsoft：Windows Authentication 与 apphost 提交](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/authentication/windowsauthentication/)：企业域认证，以及在 apphost 对应 location 开启 Windows、禁用匿名的配置方法。
- [Microsoft：URL Rewrite + ARR 反向代理](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing)：ARR 代理开关与公共/后端路径协调。
- [Microsoft：URL Rewrite 配置参考](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/url-rewrite-module-configuration-reference)：规则匹配、重写及查询参数行为。
- [Microsoft：配置继承边界](https://techcommunity.microsoft.com/blog/iis-support-blog/how-to-prevent-web-config-files-to-be-overwritten-by-config-files-in-application/297627)：`inheritInChildApplications` 的作用。
