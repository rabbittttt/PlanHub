# 计划工作台 · PlanHub

统一访问 SOP计划管理、订单分析、销量预测、线索声量、数据速查和车型配置。业务网页由各自项目维护，门户只负责集成。

## 从 A 打包，到 B 试运行和部署

1. **A 准备源码**：更新门户和各应用，核对已有 Python 构建环境与本机发布配置。
2. **A 打包**：双击 `发布应用.bat`，输入 `0`，生成自带 Windows 运行环境的完整文件夹。
3. **B 本机测试**：复制整个 `release/planhub-时间戳/`，双击 `prepare.cmd`，按手册放好数据，再双击 `preview.cmd`。
4. **同事正式部署**：本机测试通过后，同事安装 Docker，在包内运行 `build-docker.cmd`，填写公司访问地址，再运行 `start.cmd`。
5. **部门验收**：同事接入公司入口后，从部门电脑检查各应用和重启后的数据。

**具体命令：[从打包到部署的五步说明](docs/deployment.md)。**

**A 打包和 B 本机测试均不需要安装 Docker。** 包内已带 Node.js、Python 和依赖，B 无需另装。`preview.cmd` 会在 B 后台运行收到的程序，就绪后自动打开 `http://127.0.0.1:4174/`；结束时双击 `stop-preview.cmd`。

试运行使用独立数据副本，公司地址和认证留给部署同事处理。交付工具和目录使用英文名，只需复制一个完整文件夹；业务数据放在包外。后续只更新改动应用，新增入口还需更新门户。

## 开发联调

| 操作 | 入口 |
|---|---|
| 启动 / 停止开发版 | `启动本地门户.cmd` / `停止本地门户.cmd` |
| 新增网页 | `接入新网页.bat` |
| 检查 / 排查 | `npm run check` / `npm run diagnose` |
| 前台运行 | `npm start`，保留终端 |

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
