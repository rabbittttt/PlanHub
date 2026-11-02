# SOP 门户适配副本

来源：`D:\Projects\SOP`，基线提交 `eec3b69`（原工作区检查时干净）。此目录从受版本管理的源文件复制，不含原业务输入、数据库、运行依赖或 Git 元数据。门户发布包使用这里的适配副本。

代理模式通过 `server.py --gateway-config <服务器配置路径>` 启用。根目录本机模式继续用于独立开发。服务器配置、机密、业务输入与 SQLite/Excel 文件都放在 Web 根目录之外。

代理路径固定按配置保留前缀，例如 `/sop/api/state`，由后端识别并剥离。内网域名和写入组需在目标服务器配置。默认关闭写入，前端显示只读；IIS 和 Python 共同执行服务端校验。

外部路径使用 `SOP_SOURCE_DIR`、`SOP_DATA_DIR`、`SOP_SHARED_CONFIG`；由 gateway 配置映射，控制台开发不设置这些变量时沿用原目录。

部署使用 `SOP_EXCEL_ENGINE=python`，仅需要 Python 和 openpyxl，无需开发机的 Codex/Node 导出依赖。详细步骤见项目根目录 `docs/sop-intranet.md`。

后续更新业务源码时，将门户适配改动合入 SOP 独立仓库并运行测试；不要直接用旧版业务仓库覆盖此发布副本。此轮适配没有在原 SOP 仓库提交或推送。
