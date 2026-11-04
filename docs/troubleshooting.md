# 本地看板排查

入口是门户根目录的 `启动本地门户.cmd` 或 `npm start`。它直接启动原 SOP 的服务代码并代理 `/sop/`，不从门户的业务源码副本运行。

先以门户根目录为当前目录，默认 SOP 原项目相对位置为 `../SOP维护`。不同机器先核对相对位置；`config.local/sop.json` 中的相对路径按门户根目录解析，不按配置文件目录解析。检查原项目是否含 `server.py`、`sop_gateway.py`、`web` 和真实数据。需要改位置时使用 `--sop-source`；`--seed-from` 仅指定数据来源。

```powershell
npm start -- --sop-source '../SOP维护' --shared-config '../订单分析/scripts/config/shared_config.py' --port 4176 --backend-port 8879
```

- `/sop/` 返回 404：检查是否误用了 `npm run dev:static`、Live Server 或未配置代理的 IIS。
- `/orderiq/` 返回 404：检查独立发布文件 `apps/orderiq/index.html` 是否已导入。业务 HTML 被 Git 忽略。
- 提示旧 SOP 未适配：在原项目完成 gateway 合并，不能改回门户副本路径或盲套历史补丁。
- 提示端口占用：停止旧预览窗口后重启，或指定两个不同的空闲端口；脚本不会停止未知进程。
- 源码与数据不在同一目录：用 `--sop-source` 选代码，用 `--seed-from` 选数据，并明确共享规则。
- 配置无效：核对忽略的 `config.local/sop.json` 中 `sourceRoot`、`dataRoot`、`sharedConfig`，或环境变量 `SOP_SOURCE_ROOT`。
- 原始文件缺失或缺依赖：按原项目 requirements 安装，提供真实数据或显式选择演示；不要拿空业务规则充当生产规则。

确认终端实际打印的地址，再直达同源 `/orderiq/`、`/sop/`。直达成功但 iframe 失败时检查同源嵌入头与缓存，Ctrl+F5 刷新。内网认证问题必须在目标 IIS 由管理员检查。
