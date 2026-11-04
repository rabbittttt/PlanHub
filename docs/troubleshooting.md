# 本地看板排查

入口是门户根目录的 `启动本地门户.cmd` 或 `npm start`。它直接启动原 SOP 的服务代码并代理 `/sop/`，不从门户的业务源码副本运行。

先以门户根目录为当前目录，默认 SOP 原项目相对位置为 `../SOP维护`。不同机器先核对相对位置；`config.local/sop.json` 中的相对路径按门户根目录解析，不按配置文件目录解析。检查原项目是否含 `server.py`、`sop/gateway.py`、`web` 和真实数据。需要改位置时使用 `--sop-source`；`--data-root` 指定持久数据项目；仅测试使用 `--snapshot --seed-from`。

```powershell
npm start -- --sop-source '../SOP维护' --shared-config '../订单分析/scripts/config/shared_config.py' --port 4176 --backend-port 8879
```

- `/sop/` 返回 404：检查是否误用了 `npm run dev:static`、Live Server 或未配置代理的 IIS。
- `/orderiq/` 返回 404：检查独立发布文件 `apps/orderiq/index.html` 是否已导入。业务 HTML 被 Git 忽略。
- 提示旧 SOP 未适配：在原项目完成 gateway 合并，不能改回门户副本路径或盲套历史补丁。
- 提示端口占用：停止旧预览窗口后重启，或指定两个不同的空闲端口；脚本不会停止未知进程。
- 源码与数据不在同一目录：用 `--sop-source` 选代码，用 `--data-root` 选持久数据项目，并明确共享规则。
- 配置无效：核对忽略的 `config.local/sop.json` 中 `sourceRoot`、`dataRoot`、`sharedConfig`，或环境变量 `SOP_SOURCE_ROOT`。
- 原始文件缺失或缺依赖：按原项目 requirements 安装，提供真实数据或显式选择演示；不要拿空业务规则充当生产规则。

确认终端实际打印的地址，再直达同源 `/orderiq/`、`/sop/`。直达成功但 iframe 失败时检查同源嵌入头与缓存，Ctrl+F5 刷新。内网认证问题必须在目标 IIS 由管理员检查。

## 进程在运行，但 SOP 和数据速查同时超时

2026-11-04 已定位一次具体原因：Windows 启动控制台处于文本选择状态（GetConsoleSelectionInfo flags=7），两个 Python 服务继承同一个控制台输出；请求处理中的日志输出被暂停，导致后端端口仍监听但直接请求和门户代理都超时。不要仅凭端口存在判定服务正常。

门户现将后端 stdout/stderr 直接连接到独立文件，不继承控制台，也不使用无人消费的管道。日志路径在启动时打印：SOP 位于 artifacts/sop-runtime-*/logs/，其他服务位于 artifacts/service-<id>-*/。该目录不包含另一套业务数据；不修改子应用源码或日志实现，不改 Windows 控制台/安全设置。

旧进程不会自动获得代码修复，需要重启一次。排查时先核对进程命令行及父子关系，只重启确认属于本门户的进程；复用的外部独立服务不由门户停止。Windows 虚拟环境可能启动第二层 Python 进程，门户现在停止自己创建的完整子进程树，避免只结束启动器而遗留占用端口的后端。
