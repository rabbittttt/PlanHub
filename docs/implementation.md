# 实施记录 · 2026-11-02

## 检查结果与边界

工作目录 `D:\Projects\DataPlatform` 初始为空，无门户仓库或 AGENTS.md。相邻目录中的业务项目只作只读检查；此轮 SOP 适配源码复制到 `services/sop` 后修改，原源代码和配置未改动。

本机已安装 IIS、W3SVC 服务正在运行。读取 `appcmd list site/vdir/modules` 因 `redirection.config` 权限不足失败，无法确认现有站点、模块、绑定、认证设置。未尝试修改本机 IIS 或替换任何现有站点。

## 实施步骤

1. 检查现有发布结构和路径兼容性。
2. 创建静态门户及公开应用注册表。
3. 将 OrderIQ 现有发布产物复制到独立应用目录，验证 iframe 接入。
4. 实现本地预览、配置测试、IIS 部署包、预检和安装脚本。
5. 输出实际冲突、接入约定及上线所需信息。

## OrderIQ

项目：`D:\Projects\OrderIQ`。

发布源：`output_file\鸿蒙智行订单分析汇总.html`，14,240,394 字节，文件修改时间 2026-11-02 05:13:04（本机显示时间；不是业务数据更新时间）。本地副本为 `apps/orderiq/index.html`。

初次复制 SHA256：`E4391D2B8F8232930BCD26881D8ECC87BEA2818E79634621F406420A7C736B6A`。

CSS、JS、图片和数据内嵌，未发现外部资源依赖。`scripts/generate_html/templates/dashboard.js` 的预测草稿键包含 `location.pathname`，改域名或路径后旧草稿不会自动出现。正式切换前需要确认草稿迁移或导出方式。

## SOP 发现的冲突与本轮适配

项目：`D:\Projects\SOP`。

| 现状 | 影响 | 所需修改 |
| --- | --- | --- |
| `server.py` 默认 127.0.0.1:8876，SQLite 与写入 API | 不能作为静态应用部署 | 归入动态服务并通过 `/sop/` 代理 |
| `server.py:100` 返回 X-Frame-Options DENY | iframe 被浏览器拒绝 | 增加受控同源嵌入部署模式 |
| `web/app.js:142` 等使用根 `/api/` | 请求逃出 `/sop/`，与其他应用冲突 | 统一 API base 为 `/sop/api/` 或相对 base |
| `server.py:110` 限制本机 Host、http Origin | 代理后尤其写入请求被拒绝 | 配置可信代理和明确的外部 Origin，保留 CSRF/来源校验 |
| 维护人来自用户输入/localStorage | 不能充当真实域用户和审计身份 | 由服务端可信身份映射域组写权限与操作人 |
| `sop_source_rules.py:9` 依赖兄弟订单分析的 shared_config.py | 独立迁移服务目录后失败 | 将共享规则路径配置化或显式部署依赖 |
| 通过命令窗口前台启动 | 窗口关闭服务停止 | 配置受控 Windows 服务与重启策略 |

上述冲突已在 `services/sop` 发布适配副本中处理：

- 增加显式 gateway 模式、`/sop/` 前缀、SAMEORIGIN/CSP 同源嵌入、Host/Origin/代理 key 校验。
- 前端资源、API、导入和下载统一使用应用前缀；增加 session 和写权限探测，失败时只读。
- IIS 独立 `/sop` 应用使用 .NET4 Integrated 的认证后身份模块，从真实 Windows 用户生成代理身份头，按配置域组限制 POST；无组时全部写入关闭。
- 后端覆盖客户端维护人并对变更请求记录审计；Excel 导入同样使用可信操作人；禁止从浏览器打开服务器桌面 Excel。
- 共享规则、原始输入、运行数据和维护表全部支持外部绝对路径，避免依赖固定兄弟目录。
- 部署采用受控后台任务、进程重启策略及 Python 原生 Excel 导出，离线依赖已准备。

来源基线 `eec3b69`；适配副本不含原运行数据。已生成源码补丁 `deploy/sop-upstream.patch`，供业务独立仓库回合并。当前本机预览身份是开发验收身份，不代表 Windows 域认证。

用户确认此处为外网开发机，最终 IIS 在内网；此次准备可带入内网的代码与发布包，真实内网地址和写入域组后填。

## 上线前必需信息

- 目标 IIS 服务器、站点名称、域名、端口及 HTTPS 证书/终止位置。
- Windows 域环境与允许访问的域用户组；SOP 写入用户组需独立明确。
- 服务器 URL Rewrite/ARR/Windows Authentication/URL Authorization 安装状况和管理权限。
- 当前 OrderIQ 生产地址、物理路径与既有 Windows 认证设置。
- CodeHub/GitHub 项目地址和现有单向同步/发布脚本（本地检查未发现，未编造 CI 配置）。

## 官方依据

- [Microsoft：使用 URL Rewrite 与 ARR 反向代理](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing)
- [Microsoft：Windows Authentication 配置](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/authentication/windowsauthentication/)
- [Microsoft：URL Rewrite 配置参考](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/url-rewrite-module-configuration-reference)

## 验证记录

- `npm run check`：应用配置、静态产物与 JavaScript 语法检查通过。
- `npm test`：11 项通过，覆盖路由、ID 类型/重复/保留值、应用地址、HEAD/MIME、未知应用 404、目录穿越与私有目录、链接越界、缺少产物，以及 PowerShell 5.1 的实际导入/默认目录/WhatIf。
- 浏览器：OrderIQ 真实发布副本成功在 iframe 载入；搜索、分组、待接入状态、返回、浏览器后退、窄屏菜单通过；跳转工作区保留当前路由与 iframe。
- 1440 像素桌面和 375 像素窄屏已检查，无页面横向溢出；真实看板载入未发现控制台错误。截图位于 `artifacts/portal-desktop.jpg`。
- 隔离故障服务实测：HTTP 403、404、503、X-Frame-Options DENY、服务超时均显示对应提示。
- Windows PowerShell 5.1：部署离线预检、WhatIf、实际打包、产物哈希与覆盖保护通过；没有运行 `-Apply`。
- 已保留发布包 `staging/DataPlatform-0.1.0`，含门户、OrderIQ 和服务器配置。默认配置中的 `D:\DataPlatform`、8080 为部署示例，需按目标环境修改。
- 本地预览服务在验收结束后停止。再次查看运行 `npm run dev`。

本地 HTTP 预览不等于生产 IIS、域登录、应用授权或 ARR 联调通过；这些仍待目标服务器信息和相应权限。

## SOP 追加验证

- 后端 gateway 和既有 catalog/generation/grid/workbook/roundtrip 相关回归 76 项通过；追加连接拒绝回归后，在新建离线 venv 中执行 gateway、路径、来源、上传与离线 Excel 共 56 项，全部通过。
- 前端 9 个 `frontend_*.mjs` 文件全部通过，覆盖前缀、只读、身份锁定和写入授权失败。
- 新建 Python venv，从本地 wheel 使用 `--no-index` 安装成功，仅 openpyxl 3.1.5 与 et-xmlfile 2.0.0；不依赖内网访问 PyPI 或 Codex 运行时。
- SOP 原业务数据库使用 SQLite 在线备份建立隔离快照；门户内成功读取真实计划与来源数据，网页维护/导入/导出在默认只读下禁用，内部页面导航正常，无控制台错误。
- IIS 身份模块的 C# 离线编译、PowerShell 5.1 配置计划与发布脚本检查通过；实际域用户/组与 IIS ARR 需在内网验收。
- 发布包升级为 `staging/DataPlatform-0.2.0`，旧 0.1.0 包保留。生产业务数据库、源 Excel、共享规则及运行机密不自动打入新代码包。
- 门户及本地代理共 12 项 Node 测试通过；SOP 默认演示启动和现有业务快照启动均通过。验收截图为 `artifacts/portal-sop-desktop.jpg`。
- PowerShell 5.1 生成的随机代理 key 已通过 Python `GatewayConfig.load` 跨语言验证；C# 模块离线编译通过。源码补丁在原 SOP 干净工作区通过 `git apply --check`，未应用到原仓库。

## 0.2.1 计划部图标

为计划部专用门户增加统一原创图标：蓝色底、白色计划日历与青绿色推进箭头。已应用到门户标识、浏览器 favicon、移动收藏图标和 SOP 看板；门户名称调整为“智选车计划部数据平台”。提供 SVG、512/180/32 PNG、多尺寸 ICO 及开发导出脚本。

配置与 JavaScript 检查、12 项 Node 测试通过；浏览器确认门户 40px 和 SOP 26px 图标均正常加载，无控制台错误。SOP 上游补丁已包含二进制图标更新并通过原工作区的 `git apply --check`。发布包更新为 `staging/DataPlatform-0.2.1`。
