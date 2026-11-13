# 从 A 打包，到 B 试运行和部署：按这五步做

**A 是有源码的打包电脑，B 是长期运行工作台的电脑。你负责前面三步：打包、复制、在 B 本机测试。第四步起交给部署同事。**

A 打包、B 本机测试都不需要 Docker，也不需要在 B 安装 Python 或 Node.js。程序包自带 Windows 运行环境；Docker 安装、容器部署和公司认证由同事后续处理。

## 第一步：在 A 准备源码和发布配置

**操作位置：A 的工作台源码目录，即能看到 `发布应用.bat` 的文件夹。**

1. 更新门户和各应用源码，保留现有 Windows 64 位 Node.js 20+、Python 3.11+ 和构建依赖。
2. 双击 **`发布应用.bat`**。首次会自动创建 `config.local/publish.json`，已有配置继续沿用。
3. 仅首次使用时，先关闭编号菜单窗口，请维护代码的同事核对该配置中的原项目路径、Python 构建路径和依赖。`runtimePython` 指向用于随包交付的 Python，默认与各应用共用 `../.venv/Scripts/python.exe`；已有配置未填写时也沿用此默认路径。已有配置核对过就跳过。

线索声量必须使用内网真实业务页面，不能把接入样例作为正式页面。

**完成标准：** 各原项目和构建环境可用，发布配置指向实际位置。A 不用安装或启动 Docker。

## 第二步：在 A 制作完整程序包

1. 双击 **`发布应用.bat`**。
2. 应用编号输入 **`0`**，等待打包完成。
3. 资源管理器会选中 `release/planhub-时间戳/`，只需把这一个文件夹完整带到 B。

工具会调用各原项目的构建入口，校验程序文件，并装入 Windows 的 Node.js、Python 和依赖。不会启动业务服务，也不会连接 B。

**完成标准：** 窗口显示“打包完成”，选中的文件夹中能看到 `prepare.cmd`、`preview.cmd`、`stop-preview.cmd`、`build-docker.cmd`、`start.cmd` 和 `README.md`。里面的子目录全部保留，不单独挑文件。

## 第三步：在 B 放好数据，并本机测试

**操作位置：B。此步骤不安装 Docker，不需要公司访问地址或认证入口。**

### 1. 复制和准备目录

在 B 选一个长期保留的位置，新建 `planhub` 文件夹，把第二步生成的整个 `planhub-时间戳` 放进去。进入版本文件夹，双击 **`prepare.cmd`**。

它只会在版本文件夹旁边创建 `planhub-runtime` 及配置、数据目录，尚未启动工作台。已有配置和数据保留。

### 2. 放入规则和共享数据

- 将真实 `shared_config.py` 放入 `planhub-runtime/config/`。默认来源是 A 的 `../订单分析/scripts/config/shared_config.py`，这里的相对路径以门户源码目录为基准。
- 将现有“共享数据”文件夹**里面的内容**复制到 `planhub-runtime/shared/`，保留 `订单汇总`、`对账资料` 等业务子目录名。
- 如果以前用过网页并保存过记录，按下表复制需要保留的数据；完全没有旧记录的应用，对应目录留空即可。

复制旧数据前先停止使用原数据的服务，并保留原件作备份。取旧目录里面的内容，例如 `sop.sqlite3` 直接放在 `data/sop/` 下。

| 应用 | 从 A 取哪些内容（默认位置，相对门户源码目录） | 放到 B 的哪里（相对 `planhub-runtime/`） |
|---|---|---|
| SOP 计划 | `../SOP维护/data/` 的内容，包括 `sop.sqlite3`、`sales.json`、`source_settings.json`、历史备份；不用旧 `service.json`、`service.pid` | `data/sop/` |
| 订单分析批注 | `../订单分析/data/order_dashboard/` 的内容，关键文件为 `annotations.sqlite3` | `data/orderiq/annotations/` |
| 车型配置 | `../共享数据/车型配置/` 的全部内容，包括 `catalog.sqlite3`、`current.json`、`drafts/`、`history/` | `data/vehicle-config/` |
| 订单旧报表批次（可选） | `../订单分析/output_file/runtime/` 的全部内容，包括 `current.json` 和 `datasets/`；不保留可从共享 Excel 重新生成 | `data/orderiq/runtime/` |
| 数据速查 | 本次全新使用，不复制旧文件 | `data/quicklook/` 留空 |
| 销量预测 | 页面和缓存可从共享 Excel 重新生成，通常不用复制旧文件 | `data/forecast/` 留空 |

如果原服务用过其他数据目录，取它实际使用的目录。SOP 已保存的计划在数据库中，不能只复制旧维护 Excel 代替。销量预测的人工参数保存在原浏览器中，不随服务器文件迁移。门户和线索声量已在程序包里，不用放进 `data/`。

此时目录应是：

```text
planhub/
├─ planhub-时间戳/             ← 从 A 完整复制的程序包
│  ├─ prepare.cmd
│  ├─ preview.cmd
│  ├─ stop-preview.cmd
│  ├─ build-docker.cmd
│  ├─ start.cmd
│  └─ 其他随包文件和子目录     ← 全部保留
└─ planhub-runtime/            ← 配置和数据，长期保留
   ├─ config.json
   ├─ config/shared_config.py
   ├─ shared/                 ← 共享数据文件夹里面的内容
   └─ data/                   ← 上表中需要保留的记录
```

### 3. 启动本机测试

1. 确认使用原数据的服务已停止。
2. 在 B 的版本文件夹双击 **`preview.cmd`**。首次会将上述规则、共享数据和应用数据复制到旁边的 `planhub-preview/`，然后用随包环境启动工作台和各应用。首次复制数据可能需要等待。
3. 就绪后自动打开浏览器，地址是 **`http://127.0.0.1:4173/`**，各网页都从这个门户入口打开，后台端口由脚本自动安排。逐一检查网页、查询、保存和导入导出；数据速查、销量预测首次处理数据时，等页面更新完成再验收。
4. 测试结束双击 **`stop-preview.cmd`**。关闭浏览器或启动窗口不会停止后台程序。

试运行只供 B 本机访问。保存、上传、生成的内容留在试运行副本中，不会合并到正式 `planhub-runtime/`。停止后副本保留，再次启动沿用它。

更新测试包时，先用旧包的 `stop-preview.cmd` 停止，再把 A 新生成的完整包与旧包并排放在同一个 `planhub/` 下，运行新包的 `preview.cmd`。新版沿用原测试副本；旧副本的 `4174` 入口会自动调整为 `4173`，无需重新复制数据。

要重新复制最新数据，先停止源服务，在版本文件夹地址栏输入 `powershell`，回车后执行：

```powershell
.\preview.cmd -RefreshSnapshot
```

工具会停止试运行并新建副本，旧副本保留。测试失败时窗口会保留错误信息，交给维护同事排查。

**完成标准：** B 本机能进入工作台及各动态网页，关键业务操作正常。把完整程序包和 `planhub-runtime/` 留在 B，交给部署同事继续第四步。此处通过说明 Windows 本机运行可用，后续仍需验收 Linux 容器和公司入口。

## 第四步：交给同事安装 Docker 并正式部署

**以下由部署同事在 B 操作。你无需提前安装 Docker。**

1. 双击 `stop-preview.cmd`，停止本机试运行，释放门户入口 `4173`。本机试运行和正式服务依次使用这个端口。
2. 安装、启动适用的 Docker Linux 容器环境，安排宿主开机启动。在 PowerShell 检查：

   ```powershell
   docker version
   docker compose version
   docker info --format '{{.OSType}}/{{.Architecture}}'
   ```

   需能看到 Docker Server，Compose 为 v2.20 或更新，平台为 `linux/x86_64` 或 `linux/amd64`。
3. 在 B 的版本文件夹双击 **`build-docker.cmd`**。它使用随包的应用产物制作容器镜像，不需要 A 的源码目录；首次构建需能访问公司允许的镜像和 Python 依赖源。等待成功再继续。
4. 用记事本打开 `planhub-runtime/config.json`，将 `publicOrigin` 改为同事提供的访问地址，例如 `https://planhub.company.internal`，结尾不带 `/`，保存。
5. 回到版本文件夹，双击 **`start.cmd`**。这一步正式启动收到的容器版本；脚本会检查配置、创建并启动容器、等待健康检查通过。

**完成标准：** 显示 `Containers are healthy`，约 3 秒后窗口关闭，容器继续在后台运行。出现错误时保留输出排查，不继续接入公司入口。

## 第五步：接入部门网络并验收

**同事负责公司入口和认证，你从部门电脑用浏览器验收。**

1. 同事按下方参数将 B 上的工作台接到第四步填写的公司地址。
2. 从部门电脑打开该地址，进入门户和六个应用，检查查询、保存、导入导出及操作人记录。
3. 停止、重启后确认数据保留；再安排一次 B 重启验收，确认 Docker 和工作台能恢复。

**完成标准：部门电脑能访问、业务操作正常、重启后数据仍在。到这里才算部署成功。** 直接访问 B 的 `127.0.0.1:4173` 可能返回 403，正式使用公司入口地址。

## 以后更新和排错

| 要做什么 | 操作 |
|---|---|
| 更新应用 | A 在 `发布应用.bat` 选择改动应用；B 将新文件夹与旧包并排放，同事运行新包的 `build-docker.cmd`，等业务操作结束后运行 `start.cmd`，只更新该应用 |
| 更新整套 | A 选 `0`；B 仍先构建镜像再启动。新增应用或修改运行配置时用完整包；新增导航入口还需更新门户 |
| 保留数据 | 一直沿用包外同一份 `planhub-runtime/`，日常更新不重做第三步数据复制 |
| 本机测试 | 完整包的 `preview.cmd` / `stop-preview.cmd`，使用独立副本 |
| 停止正式服务 | `stop.cmd`；完整包停止整套，单应用包只停止对应应用，数据保留 |
| 状态 / 日志 | 在版本文件夹的 PowerShell 执行 `.\deploy.ps1 -Action Status` 或 `.\deploy.ps1 -Action Logs -AppId orderiq`，应用 ID 按需替换 |

回退前请同事确认数据兼容；工具不回滚数据库。

要查 B 上是谁占用 `8765`，在 **B 的 PowerShell** 运行下面这一行。它只显示进程信息，不会停止程序；其他端口按需替换数字。

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object Id,ProcessName,Path -Unique
```

<details>
<summary>给公司入口接入同事的参数</summary>

- 默认上游：B 的 `http://127.0.0.1:4173`；转发全部路径，保留公共 Host、Origin 和请求体。
- 公共地址：与 `planhub-runtime/config.json` 的 `publicOrigin` 一致。
- 公司认证后，覆盖 `X-PlanHub-User` 为真实 ASCII 域账号或 UPN，覆盖 `X-PlanHub-Key` 为配置中的 `proxySecret`，不透传客户端自报身份。密钥只供服务端使用。
- 网关不在 B 时，按公司网络规则调整 `listenAddress` 并限制上游访问。
- 正式容器使用 `restart: unless-stopped`；宿主需先启动 Docker。手动停止后需再次启动。
- `preview.cmd` 是 Windows 原生本机测试，公共入口固定为 `127.0.0.1:4173`。子服务优先使用 `43171–43176` 的回环端口，遇到占用或无法绑定时自动选择空闲端口；启动、代理和健康检查使用同一份映射，记录在当前测试副本的 `native-ports.json`，无需人工改端口。脚本不复用或关闭占用者；若公共入口 `4173` 被占用，则明确报错，由同事确认并停止旧门户后重试。
- 正式 Docker 使用容器内固定后台端口，只向宿主发布门户端口；同事无需开放子服务端口。本机测试和正式服务共用默认门户端口 `4173`，切换前先停止当前服务。测试操作人来自 B 的实际 Windows 登录身份，正式认证仍由公司入口负责。

</details>
