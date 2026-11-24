# 计划工作台 · PlanHub

统一访问 SOP管理、订单分析、销量预测、线索声量、数据速查和车型配置。业务网页由各自项目维护，门户只负责集成。

## 从 A 打包，到 B 试运行和部署

首次交付在 A 运行 `发布应用.bat` 选 `0`。B 用完整包的 `preview.cmd` 试运行，通过后由部署同事安装 Docker 并启动正式服务。文件放置位置、各步命令和验收方法见[部署说明](docs/deployment.md)。

后续只更新代码时，B 继续使用同一份 `planhub-runtime/`。选包和换包方法见[以后更新](docs/deployment.md#以后更新)。

## 开发联调

| 操作 | 入口 |
|---|---|
| 启动 / 停止开发版 | `启动本地门户.cmd` / `停止本地门户.cmd` |
| 新增网页 | `接入新网页.bat` |
| 检查 / 排查 | `npm run check` / `npm run diagnose` |
| 回归测试 | `npm test`（Node）、`npm run test:py`（Python）、`npm run test:deploy`（Windows 部署脚本测试） |
| 前台运行 | `npm start`，保留终端 |

开发版启动后，从计划工作台目录运行 `..\.venv\Scripts\python.exe -B scripts/check-app-styles.py`，用 Edge 对照桌面和手机宽度检查真实入口的底色、标题和模块导航。可用 `--url` 指定其他预览地址。

Python 测试使用当前环境的 `python`。浏览器回归需要 Playwright 和 Edge，请核对 unittest 输出中的跳过项。

源码目录需要 Node.js 20+ 和各原项目的 Python 环境；本机设置放在 `config.local/`。开发启动成功 3 秒后窗口关闭，后台继续运行。不要让两套服务同时写同一份业务数据。

| 应用 ID | 默认源码位置 | 公共前缀 |
|---|---|---|
| sop | `../SOP维护` | `/sop/` |
| orderiq | `../订单分析/scripts` | `/orderiq/` |
| forecast | `../销量预测` | `/forecast/` |
| leads | `../线索声量` | `/leads/` |
| quicklook | `../数据速查` | `/quicklook/` |
| vehicle-config | `../配置管理` | `/vehicle-config/` |

线索声量当前接入文件是样例，正式发布必须换成内网真实页面。首页计划周期 Demo 只在页面内存中，不写业务数据。

开发契约见[应用接入手册](docs/child-app-developer-guide.md)，协作边界见 [AGENTS.md](AGENTS.md)，界面基准见[设计规范](design-system/planning-portal/MASTER.md)。

## 集中持久目录

开发版的应用记录在 `../工作台数据/database/`，共享 Excel 在 `../工作台数据/shared/`。B 上的配置和数据保存在包外的 `planhub-runtime/`。首次放置数据见[部署说明第三步](docs/deployment.md#第三步-在-b-放好数据并试运行)。

本地联调时，SOP 暂不可用仍可打开首页和其他应用。启动窗口列出失败入口的诊断；修复 SOP 配置后，门户每 60 秒重新尝试连接或启动。显式隔离测试要求 SOP 就绪。
