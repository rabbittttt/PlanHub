# 销量预测与数据速查接入

本次只修改门户；两个原项目的源码、UI、业务逻辑、数据规则及独立启动方式保持原样。库存分析入口及默认挂载已移除，不删除旧产物或业务数据。

## 默认布局与入口

所有磁盘相对路径以门户根目录解析，与启动命令当前目录无关；父目录盘符和门户文件夹名可以改变。

| 应用 | 门户地址 | 唯一源码及数据归属 | 门户消费内容 |
|---|---|---|---|
| 销量预测 | /forecast/ | ../销量预测 | output_file/鸿蒙智行销量预测.html 及 forecast_assets/ |
| 数据速查 | /quicklook/ | ../数据速查 | 独立 server.py 服务；原有 web/、output_file/ 和共享来源均由原项目维护 |

顶部导航通过 portal/config/apps.json 的 order 配置为 SOP、订单分析、销量预测、线索分析、数据速查。数据速查放在最后，线索分析仍待接入。

## 本地运行与迁移

运行 npm start 或“启动本地门户.cmd”。门户按 integration/apps.json 读取销量预测发布物，并启动或复用数据速查服务；SOP 保持已有隔离快照机制。销量预测缺产物时，先在原项目按其 README 生成。门户不会自动重算预测、修改原始 Excel 或复制业务源码。

数据速查与 SOP 预览的数据行为不同：数据速查使用原项目自己的数据库、配置和自动同步；用户在页面上的导入与设置操作按原项目规则持久保存。门户不会把它的数据库改成 SOP 快照，也不会合并各应用数据库。关闭门户只停止本次由门户启动的数据速查进程；启动前已运行的服务继续保留。

新 Windows 电脑保留各项目和共享数据的相对位置，重建父目录 .venv 并安装原项目依赖，安装 Node.js 20+。不要复制旧虚拟环境。默认解释器相对门户为 ../.venv/Scripts/python.exe，与现有共享环境一致。

路径不同时，在被 Git 忽略的 config.local/apps.json 覆盖所需字段，例如：

~~~json
{
  "applications": {
    "forecast": { "root": "../预测项目/output_file" },
    "quicklook": {
      "start": {
        "cwd": "../查询项目",
        "command": "../.venv/Scripts/python.exe",
        "args": ["-B", "server.py"]
      }
    }
  }
}
~~~

覆盖以应用为单位合并字段；start 为完整对象，设为 null 则只连接手动管理的服务。无论该配置放在何处，其中 cwd、command、root 相对值均按门户根目录解析。配置仅由 Node 读取，不向浏览器公开本机路径。

数据速查原项目目前固定监听回环地址的 8765 端口；门户默认 target 遵循这一既有契约。仅修改 target 不会让原程序更换端口。若要改变服务监听参数，应另在数据速查项目处理；之后门户只更新接入配置。服务端口不得与门户或 SOP 端口相同。端口被其他程序占用时明确提示，不结束未知进程。

npm run dev:static 提供静态挂载及代理，但不自动启动后端；数据速查需自行运行。npm start / dev / dev:sop 会按配置启动独立服务。

## 不改子页面的代理约定

数据速查页面资源使用相对地址，但其现有 JavaScript 使用根路径 /api/...。为保留原代码，门户将 /quicklook/ 前缀剥离后代理到服务根，同时仅将 integration/apps.json 中逐项登记的 rootRoutes 转发给该服务：catalog、table、workbooks、workbook、sheet、search、raw、import、sync、config、recognition。

这不是全局 /api/* 通配代理。未知 API 不转发；SOP 的 /sop/api/... 保持独立。增加其他应用时检查根接口冲突；加载配置时拒绝两个应用争用同一根接口或覆盖门户身份接口。其他根路径 API 应用若同名，不能靠 Referer 猜测来源或改写业务页面解决，须由其独立项目支持子路径，或规划独立站点。

代理原样传递正文、请求方法、查询参数和安全响应头；Host 保留浏览器访问门户时的值，Origin 不改写，原服务的同源检查继续有效。上传使用流式转发，保留 Content-Length；不得复用 SOP 的身份头和密钥。现有预览只监听本机，不代表已经部署到部门网络。

## 静态打包与服务器交付

本地预览直接读取原项目产物，不需每次复制。IIS 打包前运行：

~~~powershell
npm run prepare:apps -- forecast
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ./deploy/New-DeploymentPackage.ps1 -Destination ./staging/portal-release-new -WhatIf
~~~

prepare:apps 只把公开清单里的 HTML/资源原样收集到被忽略的 apps/forecast/，增加等字节 index.html 入口；不读取原始 Excel、数据库或日志。已有 apps/forecast 移到 artifacts/static-backup-... 保留恢复，来源和文件哈希记录在 apps/forecast.import.json。源码继续只在原项目维护。不要手工修改发布物；业务更新后重新生成、收集和打包。

部署模板已包含 forecast 静态 Application。完整部署仍需原有 SOP 发布物参数。数据速查动态服务不包含在静态包里，必须从其独立仓库交付并配置常驻服务；IIS 需另行配置 /quicklook/ 剥离前缀及上述精确 API 路由，保留公共 Host、Origin 和响应安全头，并核对上传大小/超时。Node 本地接入配置不会自动安装 IIS 规则。此任务不执行部署或 IIS/安全设置变更。

## 验收范围

自动测试覆盖相对工作区整体移动、静态白名单及目录穿越隔离、代理请求正文/查询参数/Origin/安全头、服务停止后的 502、根接口冲突、导航顺序、发布物字节一致及旧产物备份。真实服务联调通过门户、订单、SOP、销量预测及数据速查页面，629 个销量预测资源、17 个数据速查资源，以及 SOP 会话/状态和数据速查目录/工作簿接口。Edge 实测两个新入口的 iframe 加载和顶部顺序正确，无 JavaScript 异常；1440px 桌面与 375px 窄屏门户无横向溢出。不向真实共享目录上传测试 Excel，不覆盖原配置。

浏览器导入、导出、收藏及图表完整操作和内网 IIS 联调需使用可写测试数据另行验收。数据速查收藏与销量预测草稿属于浏览器站点存储；从原独立地址切换到门户地址后不会自动迁移已有浏览器收藏/草稿。
