# 工作台发布与部署

你在 A 打包，在 B 本机验证。试运行通过后，由部署同事在 B 安装 Docker、启动正式服务并接入部门内网。前三步用不到 Docker，首次完整包自带 B 试运行所需的 Python 和 Node.js。

## 第一步 在 A 准备源码

1. 在 A 打开能看到 `发布应用.bat` 的门户源码目录。更新门户和所有已启用的子应用，确认 A 上的 Windows 64 位 Node.js、Python 构建环境和各应用依赖可用。打开下面两个 HTML，核对各自显示的业务内容。打包会原样收集这两个静态网页。

   | 门户显示顺序 | A 上的默认文件 | 发布后的入口 |
   |---|---|---|
   | 声量线索 | `../声量线索/lead-dashboard.html` | `/leads/` |
   | 精品附件 | `../精品附件/boutique-dashboard.html` | `/boutique/` |

2. 双击门户源码目录里的 **`发布应用.bat`**。首次运行会自动创建 `config.local/publish.json`。如果项目按默认目录摆放，且共用 `../.venv/Scripts/python.exe`，留在编号菜单，继续第二步。
3. 仅当路径有差异时，关闭菜单。静态网页放在其他位置时，在 `config.local/apps.json` 的 `applications.leads` 或 `applications.boutique` 下填写 `root`（目录）、`entry`（入口文件）和 `publicPaths`（随包收集的文件）。若曾为声量线索单独填过旧目录，在这里更新。动态应用的源码目录、构建程序和随包交付的 Python 在 `config.local/publish.json` 中设置。保存后重新双击 `发布应用.bat`。

## 第二步 在 A 打完整包并复制到 B

1. 首次交付在 A 的 `发布应用.bat` 菜单选 **`0`**（全部应用和 Windows 环境）。以后更新程序选 **`1`**（全部应用，复用 B 上的环境）。两种包都有 `preview.cmd`。等窗口显示“打包完成”，资源管理器会选中 `release/planhub-时间戳/`。
2. 在 B 选一个长期保留的位置，新建或打开 `planhub/` 文件夹。把 A 上**选中的整个版本文件夹**复制进去。在 B 打开 `planhub/planhub-时间戳/`，确认能看到 `prepare.cmd` 和 `preview.cmd`。

## 第三步 在 B 放好数据并试运行

1. 打开刚复制的版本文件夹，双击 **`prepare.cmd`**。它会在版本文件夹**旁边**创建 `planhub-runtime/`，准备配置、各动态应用的数据目录、共享目录（含 `原始销量/`）和日志目录。窗口会列出放置规则和数据的实际位置。重复运行会补齐缺少的目录，保留已有配置和文件。

### 部署文件架构

下面是第三步准备完成后 B 上的主要文件。**`planhub-时间戳/` 由 A 打包后整夹复制，`planhub-runtime/` 由 B 首次运行 `prepare.cmd` 创建。两个文件夹放在同一层。**

```text
planhub/
├─ planhub-时间戳/               从 A 复制的版本文件夹（首次选 0）
│  ├─ README.md                 本部署说明
│  ├─ prepare.cmd               首次创建包外的配置和数据目录
│  ├─ preview.cmd               B 本机试运行
│  ├─ stop-preview.cmd          停止本机试运行
│  ├─ build-docker.cmd          构建正式部署用的镜像
│  ├─ start-docker.cmd          启动本包对应的正式服务
│  ├─ stop-docker.cmd           停止本包对应的正式服务
│  ├─ releases/                 门户和各子应用的程序，每个应用一个子目录
│  ├─ runtime/                  随 0 包交付的 Windows Node.js 和 Python
│  ├─ launcher/                 启动、代理和校验程序
│  ├─ docker/                   构建镜像用的 Dockerfile
│  ├─ compose.json              正式容器的服务、端口和数据挂载配置
│  ├─ bindings.json             各应用的启动参数、端口和健康检查
│  └─ delivery.json             本包的应用版本和文件校验清单
└─ planhub-runtime/             B 上长期保留，后续版本共用
   ├─ config.json               B 的运行配置，第四步在这里填公司访问地址
   ├─ config/shared_config.py   首次放入的业务规则文件
   ├─ shared/                   部门共享 Excel 及业务子目录
   ├─ database/                 各应用保存的记录，按应用分目录
   └─ logs/                     prepare.cmd 创建目录，服务运行后写入日志
```

Windows 试运行直接读取 B 的 `planhub-runtime/`。正式部署时，Docker 为门户和每个已启用的子应用分别启动容器，将同一个目录挂载为容器内的 `/runtime`。两种方式共用业务数据，切换前先停止当前服务。

2. 首次准备数据时，按下表放好文件。如果 B 已有可用的规则、共享文件和应用记录，直接用 B 上的内容。

   | 从哪里取 | 放到 B 的哪里 |
   |---|---|
   | A 的 `../订单分析/scripts/config/shared_config.py`（车型配置发布、SOP 读取的规则原件） | `planhub-runtime/config/shared_config.py`（默认位置，由 `config.json` 的 `sopSharedConfig` 指定） |
   | 部门共享 Excel 及其业务子目录；A 上默认在 `../工作台数据/shared/` | 将目录**里面的内容**放到 `planhub-runtime/shared/`，保留子目录名，包括预留的 `原始销量/` |
   | 需要带到 B 的应用记录；A 上在 `../工作台数据/database/` | 停止写入源数据的服务并备份，再把所需应用子目录放到 `planhub-runtime/database/`。跳过 SOP 的 `service.json`、`service.pid`。从空数据开始的应用保留空目录即可 |

   A 的相对路径均从门户源码目录算起。表中列的是首次准备的默认位置；B 已有配置时，以 `prepare.cmd` 窗口显示的实际目录为准。数据速查首次只从共享文件建库时，可留空 `database/quicklook/`。要沿用已有上传、设置或分析记录时，停服后迁移完整的 `database/quicklook/`，并在 B 核对原始文件路径。

3. 双击版本文件夹中的 **`preview.cmd`**。浏览器会打开 **`http://127.0.0.1:4173/`**。本机试运行优先使用各子应用的默认端口，遇到冲突会自动选空闲端口，门户入口固定为 4173。从门户打开各网页，核对能否看到 B 上的实际数据。试运行中的保存和上传会写入这份 `planhub-runtime/`。
4. 验证完成后双击 **`stop-preview.cmd`**。确认停止成功后，将 B 上的版本文件夹和旁边的 `planhub-runtime/` 一起留给部署同事。

## 第四步 由同事在 B 启动 Docker 正式服务

1. **停止本机试运行。** 在 B 上打开第三步用的版本文件夹，双击 **`stop-preview.cmd`**。成功后窗口会自动关闭，继续下一项；如果窗口停留并报错，先处理错误。如果第三步已经确认停止，直接继续下一项。
2. 安装并启动支持 Linux 容器的 Docker，设置为随 B 开机启动。在 PowerShell 执行以下命令，确认能看到 Server 信息，Compose 版本至少为 2.20，平台为 `linux/amd64` 或 `linux/x86_64`。

   ```powershell
   docker version
   docker compose version
   docker info --format '{{.OSType}}/{{.Architecture}}'
   ```

3. 在版本文件夹双击 **`build-docker.cmd`**。这一步根据包内程序构建镜像。首次构建需能访问基础镜像、系统软件包及 Python 依赖源。看到 `Docker images are ready` 后继续。
4. 用记事本打开 **`planhub-runtime/config.json`**，将 `publicOrigin` 改成公司的实际访问地址，例如 `https://planhub.company.internal`，结尾不带 `/`。公司网关在 B 本机时，保留默认 `listenAddress`。网关在另一台电脑时，由部署同事把 `listenAddress` 设为 B 上供网关连接的内网 IP，并按公司要求限制访问范围。保存配置。跨来源嵌套默认从浏览器识别直接父页面。需要固定父系统来源，或浏览器未提供父来源时，可在同一个 `config.json` 设置 `accountParentOrigin`，填写协议、主机及非默认端口。
5. 在版本文件夹双击 **`start-docker.cmd`**。看到 **`Containers are healthy`** 表示正式容器已启动并通过健康检查。以后要停止整套服务，使用完整包里的 `stop-docker.cmd`。

## 第五步 从部门电脑验收

1. 部署同事将第四步填写的公司地址转发到 B 的门户。网关在 B 本机时，上游填 `http://127.0.0.1:4173`；网关在另一台电脑时，上游填 `http://<B 的内网 IP>:4173`。子应用共用这个门户入口。
2. 公司入口转发所有路径并保留公共 Host、Origin 和请求体。认证完成后，由入口覆盖 `X-PlanHub-User` 为真实域账号或 UPN、`X-PlanHub-Key` 为 `config.json` 中的 `proxySecret`。
3. 在部门电脑打开公司地址，打开各个应用。声量线索和精品附件应能显示对应页面；对提供维护功能的应用，核对保存、导入导出和操作人记录。
4. 由部署同事安排 B 重启一次，再从部门电脑打开同一地址。确认各应用恢复、已保存的记录仍在，即完成部署。

## 以后更新

### B 正在本机试运行时更新程序

1. 在 A 选 **`1`**。把新版本文件夹复制到 B，和旧包、`planhub-runtime/` 并排放好。保留同层一个可用的 `0` 包供复用环境。提示环境缺失或不兼容时，在 A 选 `0` 重新打包。
2. 在旧看板保存正在编辑的内容，等导入、导出和后台维护结束。**直接双击新包的 `preview.cmd`**，跳过 `stop-preview.cmd` 和 `prepare.cmd`。校验新包和环境期间旧服务继续工作；校验失败时仍可用旧版。
3. 窗口开始切换后，暂停查询和保存。等窗口显示新版就绪，使用自动打开的新页面。网址仍使用 `4173` 端口。若要继续用原来的标签页，先刷新整个工作台。

窗口会显示从请求停止旧服务到新版就绪的实际秒数。窗口关闭后，也可以在 `planhub-runtime/native-direct.json` 查 `switchSeconds`。若旧服务已停、新服务启动失败，请按窗口提示查看 `planhub-runtime/logs/`，解决问题后再次双击新包的 `preview.cmd`。

### B 已运行 Docker 正式服务时更新程序

- **更新程序**：A 选 `1`，把新包复制到 B。在新包双击 `build-docker.cmd`，构建成功、当前业务操作结束后再双击 `start-docker.cmd`，按第五步验收。若要切回 Windows 本机试运行，先由部署同事用完整包停止 Docker。

### 更新数据或配置

- **更新共享 Excel**：替换 B 的 `planhub-runtime/shared/` 中对应文件，等待使用该文件的应用按自己的周期处理，再刷新页面核对。
- **更新应用数据或配置**：停止使用这些文件的服务，备份待改内容，只替换 `planhub-runtime/` 中本次需要更新的文件，再启动并验证。

运行日志在 `planhub-runtime/logs/`；查 Docker 服务日志可在版本目录运行 `.\deploy.ps1 -Action Logs -AppId orderiq`，应用编号按需替换。

### 从共享目录核对 B 的版本

A 的交付包在 `delivery.json` 的 `versions` 列出应用版本。B 使用正式 Docker 时，打开 `planhub-runtime/deployment-state.json` 核对 `versions` 和 `updatedAt`；B 使用默认 Windows 试运行时，看同目录 `native-direct.json` 的 `versions` 和 `confirmedAt`。这些值记录 B 上最近一次成功启动时确认的版本。旧包或尚未完成启动时可能没有版本记录。查看当前进程健康状态仍需访问 B 的服务。共享这些状态文件时只授予读取权限，含密钥的运行配置仅供部署机使用。
