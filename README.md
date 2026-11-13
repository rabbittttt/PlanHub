# 计划工作台 · PlanHub

统一访问 SOP计划管理、订单分析、销量预测、线索声量、数据速查和车型配置。业务网页由各自项目维护，门户只负责集成。

## 发布到 B：Docker

1. **检查环境**：A、B 能运行 Docker 的 Linux 容器和 Compose。
2. **A 打包**：双击 `发布应用.bat`，输入 `0`。
3. **在 B 放好文件**：复制整个 `release/planhub-时间戳/`，按手册创建旁边的 `planhub-runtime`，填好地址并放入真实规则、共享数据。
4. **在 B 部署并运行**：打开刚复制的版本文件夹，双击 `start.cmd`。它会自动导入镜像、创建并启动容器，等待各应用正常响应。
5. **从浏览器验收**：同事接入公司入口后，在部门电脑浏览器输入公司提供的地址，检查各应用和重启后的数据。

**具体命令：[从打包到部署的五步说明](docs/deployment.md)。**

交付文件夹内全是英文名。Node.js、Python 和依赖在离线镜像中，B 不用另装；业务数据保存在包外。后续只更新改动应用，新增入口还需更新门户。

## 开发联调

| 操作 | 入口 |
|---|---|
| 启动 / 停止开发版 | `启动本地门户.cmd` / `停止本地门户.cmd` |
| 新增网页 | `接入新网页.bat` |
| 检查 / 排查 | `npm run check` / `npm run diagnose` |
| 前台运行 | `npm start`，保留终端 |

源码目录需要 Node.js 20+ 和各原项目的 Python 环境；本机设置放在 `config.local/`。开发启动成功 3 秒后窗口关闭，后台继续运行。不要让开发版和 Docker 同时写一份数据。

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
