# 从 A 打包，到 B 试运行和部署：按这五步做

**A 是有源码的打包电脑，B 是长期运行工作台的电脑。你负责前面三步：打包、复制、在 B 本机测试。第四步起交给部署同事。**

A 打包、B 本机测试都不需要 Docker，也不需要在 B 安装 Python 或 Node.js。首次程序包自带 Windows 运行环境；Docker 安装、容器部署和公司认证由同事后续处理。

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

下面的 `database/` 是首次准备环境的默认目录。**B 已经运行过旧包时，不要重新搬数据或直接修改 `databaseDirectory`。** 新包会沿用旧 `config.json`：没有该字段时，继续使用原来的 `data/<应用编号>/`，车型配置继续使用原共享根下的 `车型配置/`。只更新代码按[后续更新步骤](#updates)操作；统一迁移目录需另行停服、备份和核对。

### 2. 放入规则和共享数据

- 将真实 `shared_config.py` 放入 `planhub-runtime/config/`。默认来源是 A 的 `../订单分析/scripts/config/shared_config.py`，这里的相对路径以门户源码目录为基准。
- 将 `../工作台数据/shared/` **里面的内容**复制到 `planhub-runtime/shared/`，保留 `订单汇总`、`对账资料` 等业务子目录名；`原始销量/` 供其他项目使用，即使为空也保留，首次准备环境时若不存在则创建。
- 如果以前用过网页并保存过记录，按下表复制需要保留的数据；完全没有旧记录的应用，对应目录留空即可。

复制旧数据前先停止使用原数据的服务，并保留原件作备份。取旧目录里面的内容，例如 `sop.sqlite3` 直接放在 `database/sop/` 下。

| 应用 | 从 A 取哪些内容（默认位置，相对门户源码目录） | 放到 B 的哪里（相对 `planhub-runtime/`） |
|---|---|---|
| SOP 计划 | `../工作台数据/database/sop/` 的内容，包括 `sop.sqlite3`、`sales.json`、`source_settings.json`、历史备份；不用旧 `service.json`、`service.pid` | `database/sop/` |
| 订单分析批注 | `../工作台数据/database/orderiq/annotations/` 的内容，关键文件为 `annotations.sqlite3` | `database/orderiq/annotations/` |
| 车型配置 | `../工作台数据/database/vehicle-config/` 的全部内容，包括 `catalog.sqlite3`、`current.json`、`drafts/`、`history/` | `database/vehicle-config/` |
| 订单旧报表批次（可选） | `../工作台数据/database/orderiq/runtime/` 的全部内容，包括 `current.json` 和 `datasets/`；不保留可从共享 Excel 重新生成 | `database/orderiq/runtime/` |
| 数据速查 | `../工作台数据/database/quicklook/` 的数据库、上传及设置；迁移电脑须核对来源与原件路径 | `database/quicklook/` |
| 销量预测 | 页面和缓存可从共享 Excel 重新生成，通常不用复制旧文件 | `database/forecast/` 留空 |

车型配置同其他应用一样使用 `database/vehicle-config/`。旧环境如在共享目录或旧 `data/vehicle-config/` 留有记录，先停服核对唯一有效来源，再执行迁移；禁止自动合并两份记录。旧发布包保持原样，重新打包交付。

如果原服务用过其他数据目录，取它实际使用的目录。SOP 已保存的计划在数据库中，不能只复制旧维护 Excel 代替。销量预测的人工参数保存在原浏览器中，不随服务器文件迁移。门户和线索声量已在程序包里，不用放进 `database/`。

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
   ├─ shared/                 ← 工作台数据/shared 里面的内容
   └─ database/               ← 上表中需要保留的记录
```

### 3. 启动本机测试

1. 确认使用原数据的服务已停止。
2. 在 B 的版本文件夹双击 **`preview.cmd`**。它用随包环境启动工作台和各应用，直接读取 `planhub-runtime/` 中的规则、共享数据和应用数据。
3. 就绪后自动打开浏览器，地址是 **`http://127.0.0.1:4173/`**，各网页都从这个门户入口打开。后台优先使用已登记的子项目默认端口，冲突时自动选择空闲端口。逐一检查网页、查询、保存和导入导出；数据速查、销量预测首次处理数据时，等页面更新完成再验收。
4. 测试结束双击 **`stop-preview.cmd`**。关闭浏览器或启动窗口不会停止后台程序。

本机运行只供 B 本机访问。保存、上传、生成的内容直接写入 `planhub-runtime/`，停止、重启和换程序版本后继续保留。更新 `planhub-runtime/shared/` 的文件后，各应用按自己的扫描、稳定等待和页面刷新周期处理；无需重新打包或复制副本。

从旧版升级时，先用旧包的 `stop-preview.cmd` 停止副本运行，再用新包启动。旧 `planhub-preview/` 中维护过的记录不会自动合并；确需保留时先由对应应用导出、核对后导入。日常代码更新按[后续更新步骤](#updates)操作。失败时窗口保留错误信息。

**旧 `planhub-preview/` 怎么处理：** 新版日常运行不再需要它。停止旧副本服务后，确认其中没有要保留的维护记录、上传文件，或已完成迁移并核对，就可以删除整个 `planhub-preview/`。正常双击新版 `preview.cmd` 不会重新创建它；只有显式使用隔离测试参数时才会创建副本。`planhub-runtime/` 是正在使用的数据和配置目录，需要长期保留。

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

<a id="updates"></a>
## 以后更新：先选是否更新数据

A 打包时选择是否携带 Windows 运行环境：

| 在 A 的 `发布应用.bat` 选什么 | 生成什么 |
|---|---|
| `0` | 全部七个应用，加 Windows 运行环境；首次交付选这个 |
| `8` | 全部七个应用，仅程序，不含 Windows 运行环境；后续可减少打包和复制量 |

用 `8` 做 B 本机测试时，保留同一个 `planhub/` 下至少一个旧 `0` 包。工具会自动校验并复用其中的环境，不用填写路径或复制环境文件；找不到可用环境或新依赖不兼容时，按提示回 A 选 `0` 重新打包。`8` 仍会构建全部应用，A 仍需原来的开发依赖；两种选项都不需要 A 安装 Docker。

### 只更新代码，在 B 本机测试

1. **A 打包：** 更新源码，在 `发布应用.bat` 输入 **`8`**；想重新附带运行环境则选 `0`。本机测试需要全部应用，不能使用单应用包。
2. **B 换包：** 用旧包的 `stop-preview.cmd` 停止测试，将新程序文件夹放在同一个 `planhub/` 下，与旧包并排；不要覆盖或删除供其复用环境的旧 `0` 包。
3. **B 启动：** 双击新包的 `preview.cmd`。新程序直接使用原来的 `planhub-runtime/`，数据、共享文件和配置继续沿用；不用选 `1/2`，不用再运行 `prepare.cmd`。
4. **B 验收：** 浏览器打开 `http://127.0.0.1:4173/`，检查改动网页；结束时用新包的 `stop-preview.cmd`。

程序更新无需重新迁移数据；涉及业务数据格式变化时，仍按该应用的升级要求处理。

### 数据、共享文件或配置也要更新后测试

1. **B 停止并备份：** 停止试运行；如正式服务正在使用待更新文件，也先安排停止，备份要改的文件。
2. **B 准备新内容：** 将确实要更新的数据、共享文件、规则或配置放到同一份 `planhub-runtime/` 对应位置。没有变化的内容保留。
3. **B 重新运行：** 双击全部应用包（`0` 或 `8`）中的 `preview.cmd`，直接使用准备好的内容。只更新共享 Excel 时，可保持本机服务运行，等待对应应用处理；更改配置或替换数据库前应停止服务。

本机服务与 Docker 正式服务使用同一份数据，切换运行方式前必须停止当前服务。旧测试副本不参与默认运行，按第三步说明核对后可清理。

### 已正式部署 Docker，更新上线

1. **A 打包：** 只改一个应用，就在 `发布应用.bat` 选择该应用；整套更新选 `8`，需要重新附带 Windows 环境时选 `0`。新增导航入口还需更新门户；新增应用、修改运行配置或运行契约时选 `0` 或 `8`，交付全部应用。单应用包只适用于已有完整部署且环境配置未变的情况。
2. **B 放包：** 将新程序文件夹与旧包并排放在原 `planhub/` 下，继续使用旁边的同一份 `planhub-runtime/`。**只更新代码时，不再复制 `database/`、`shared/` 或配置，不重做首次迁移。**
3. **同事切换：** 在新包运行 `build-docker.cmd`，构建成功后，等当前业务操作结束，再运行新包的 `start.cmd`。单应用包只切换对应应用；全部应用包切换整套。
4. **部门验收：** 从公司入口检查改动功能和原有记录。旧包保留供同事核对，工具不回滚数据库。

如果本次还要更新正式数据或配置，由同事先停止使用这些文件的服务并备份，再按本次明确需要修改 `planhub-runtime/` 中的内容，核对后启动。程序包不会自动覆盖这些业务文件，也不要同时运行两套服务写同一数据。

## 常用操作与排错

开发版从门户目录的 `artifacts/logs/` 查日志。后台门户启动信息在 `launcher/`，SOP 维护、数据速查和配置管理分别在 `sop/`、`quicklook/`、`vehicle-config/`。各目录内的 `stdout.log` 和 `stderr.log` 按启动时间追加，启动时达到 10 MiB 的文件轮转为 `.1`。SOP 另写 `service.log`，运行中按 10 MiB 轮转，保留三份历史文件。

部署包的 Windows 本机运行使用包外 `planhub-runtime/logs/` 下的相同目录。显式快照模式写入快照自己的 `logs/`。Docker 的上述三个业务服务同时输出到 Compose 和包外应用日志目录，容器启动或镜像错误可用下表的 Logs 命令查看。订单分析和销量预测沿用原有应用日志位置。

| 要做什么 | 操作 |
|---|---|
| 本机运行 | 全部应用包（`0` 或 `8`）的 `preview.cmd` / `stop-preview.cmd`；直接读写 `planhub-runtime/` |
| 停止正式服务 | `stop.cmd`；全部应用包停止整套，单应用包只停止对应应用，数据保留 |
| 状态 / 日志 | 在版本文件夹的 PowerShell 执行 `.\deploy.ps1 -Action Status` 或 `.\deploy.ps1 -Action Logs -AppId orderiq`，应用 ID 按需替换 |

<details>
<summary>给公司入口接入同事的参数</summary>

- 默认上游：B 的 `http://127.0.0.1:4173`；转发全部路径，保留公共 Host、Origin 和请求体。
- 公共地址：与 `planhub-runtime/config.json` 的 `publicOrigin` 一致。
- 公司认证后，覆盖 `X-PlanHub-User` 为真实 ASCII 域账号或 UPN，覆盖 `X-PlanHub-Key` 为配置中的 `proxySecret`，不透传客户端自报身份。密钥只供服务端使用。
- 网关不在 B 时，按公司网络规则调整 `listenAddress` 并限制上游访问。
- 正式容器使用 `restart: unless-stopped`；宿主需先启动 Docker。手动停止后需再次启动。
- 后台默认端口只在 A 源码的 `integration/ports.json` 维护；打包时生成包内 `bindings.json` 的具体端口，B 不手改派生产物。`preview.cmd` 优先使用该默认端口，占用或无法绑定时自动选择空闲回环端口；实际映射记在运行目录的 `native-ports.json`，启动、代理和健康检查共用。脚本不复用或关闭未知占用者。公共入口固定为 `127.0.0.1:4173`，若被占用则报错，先停止已有门户或正式服务后重试。
- 正式 Docker 使用容器内固定后台端口，只向宿主发布门户端口；同事无需开放子服务端口。本机测试和正式服务共用默认门户端口 `4173`，切换前先停止当前服务。测试操作人来自 B 的实际 Windows 登录身份，正式认证仍由公司入口负责。

</details>


<details>
<summary>历史恢复备份位置</summary>

以下为开发工作区曾记录的恢复备份，路径相对于门户根目录；不随 Git 或发布包交付。本次文档清理不删除这些备份，旧实施记录可从 Git 历史查阅。

| 内容 | 原记录位置 |
|---|---|
| 单一 SOP 源码调整前的源码、Git 与补丁 | `artifacts/single-source-backup-20261102-180733/` |
| 部门功能调整前 | `artifacts/uniform-access-before-20261103/` |
| 目录迁移前数据库与迁移时版本 | `artifacts/relocation-live-preview-backup-20261103/`、`artifacts/relocation-copied-versions-20261103/` |
| 持久化切换前的数据库及相关数据 | `artifacts/sop-before-persistence-usA4Bq/` |

恢复前核对实际文件、来源和数据一致性，不直接覆盖运行中的数据。

</details>


## 集中持久目录（2026-11-17）

不新增公共数据服务项目。开发数据根默认 `../工作台数据`，由 `integration/apps.json` 的 `dataRoot` 统一配置，环境变量 `PLANHUB_DATA_ROOT` 可覆盖；各应用独立运行默认指向同一工作区的数据根。共享 Excel 统一位于 `../工作台数据/shared`，由 `sharedDataRoot` 配置；子项目独立运行也默认读取该位置。`工作台数据/shared/原始销量/` 保留给其他项目使用，即使工作台当前不读取、目录为空也不能作为无用目录清理。旧同级 `共享数据/` 不再作为默认输入。发布环境对应保留配置的共享根下的 `原始销量/`。

数据库及配套文件按 `database/sop`、`database/orderiq/annotations`、`database/orderiq/runtime`、`database/forecast`、`database/quicklook`、`database/vehicle-config` 分开保存，不建立第二份运行副本。上传、草稿、历史及运行批次随所属应用目录保留，不只复制单个数据库文件。

开发首次迁移：双击根目录 `迁移持久数据.cmd`，选 1 迁移旧数据库，再选 2 迁移旧共享目录，分别核对计划后执行；数据库已经集中时只选 2。执行前停止使用这批数据的服务，关闭正在打开这些文件的程序。工具按文件检查占用，有冲突时会列出文件路径。使用命令行时，运行 `../.venv/Scripts/python.exe -B scripts/migrate-storage.py integration/storage-migration.example.json` 核对计划，再加 `--apply` 执行。目录不同先复制模板到本机位置并修改其中相对路径；所有相对路径基于清单文件位置。选 1 时可以使用已有的“工作台数据”根目录。工具逐项迁入缺失或空的目标目录。来源缺失或目标已有内容时，会显示跳过的路径，已有记录保留，供人工核对。逐文件校验、数据库检查通过后，原目录改名为 `.pre-central-*` 恢复备份，目标根目录的 `migration.json` 记录映射，已有记录时另存为 `migration-编号.json`。数据速查的原件路径由其自己的迁移脚本调整。

新发布环境在 `planhub-runtime/config.json` 设置 `databaseDirectory: "database"`，Windows 与 Docker 共用该目录。旧配置未设置此字段时保持旧 `data/` 与车型配置共享子目录映射，不能只改字段后直接启动。旧 B 环境先停服，按原实际目录编写同格式迁移清单，使用包内 `launcher/migrate-storage.py` 迁移到尚不存在的 `planhub-runtime/central/`（清单中的目标子目录仍为 `database/...`），验证后将 `databaseDirectory` 设置为 `central/database`。迁移完成后不要再移动目标目录，以免数据速查保存的原件路径失效。数据速查迁移钩子在其发布物 `scripts/migrate_storage.py` 中；路径按实际发布物填写。首次从 A 到 B 时复制集中目录中的持久数据；数据速查先复制到 B 的临时目录，在 B 停服期间运行其 `scripts/migrate_storage.py --staged <B临时复制目录> --old <A数据速查目录> --new <B正式数据速查目录>`，检查后将临时目录移到该正式位置（正式目录必须尚不存在），并在页面重新选择实际的共享来源。后续只换程序包。

共享目录迁移：选项 2 会逐文件校验复制内容、保留 `原始销量/`，调用数据速查自己的迁移工具更新已保存的来源路径。原共享目录与迁移前的数据速查状态移入数据根的 `backups/shared-migration-*`，旧共享目录退出使用。目标已有业务文件时拒绝覆盖，需先核对冲突。非默认布局使用 `scripts/migrate-shared.py --source ... --destination ... --quicklook ... --hook ... --source-base ...`，先检查计划，再加 `--apply`；相对参数从当前命令目录解析。不得仅移动 Excel 而遗漏数据库中的来源路径。
