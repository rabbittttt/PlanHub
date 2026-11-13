# 第一次把工作台部署到 B：按这五步做

**A 是有源码的打包电脑，B 是长期运行工作台的部署电脑。** 先在 A 制作程序包，再复制到 B 安装运行，最后从部门浏览器访问。

**`start.cmd` 是 B 上的“一键部署并启动”入口。** 首次运行会安装并启动收到的版本；以后在新版本包里运行它，会更新并启动该版本。打开网页则是在浏览器输入公司提供的工作台地址。

准备好第三步的数据后，可以先用 **`preview.cmd` 在 B 本机试运行**，确认各网页能用，再继续第四步。试运行地址是 `http://127.0.0.1:4174/`，使用独立数据副本，不需要公司入口。

## 第一步：让 A、B 具备运行 Docker 的条件

**操作位置：A 和 B，各做一次。目的：让 A 能制作程序包，让 B 能运行收到的包。**

请同事安装并启动 Docker。Windows 工作站使用 [Docker Desktop 的 Linux 容器模式](https://docs.docker.com/desktop/setup/install/windows-install/)；Windows Server 由同事提供适用的 Linux 容器环境。

在两台电脑的开始菜单搜索并打开 PowerShell，分别执行：

```powershell
docker version
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

**完成标准：** 第一条能看到 Server 信息；Compose 是 v2.20 或更新版本；最后一条显示 `linux/x86_64` 或 `linux/amd64`。有报错就先请同事解决，再继续。

A 还需保留现有 Node.js 20+、Python 构建环境，并能访问公司允许的镜像和依赖源。B 的 Node.js、Python 和依赖由程序包提供。请公司接入同事先给出最终访问地址，第四步要填写它。

## 第二步：在 A 制作完整程序包

**操作位置：A 的工作台源码目录，也就是能看到 `发布应用.bat` 的文件夹。目的：生成要带给 B 的程序。**

1. 更新门户和各应用源码。
2. 双击 **`发布应用.bat`**。工具会自动创建 `config.local/` 和其中的 `publish.json`，已有配置会继续沿用，无需手动新建或复制模板。
3. **仅首次配置时：** 看到应用编号菜单后先关闭窗口，打开自动生成的 `config.local/publish.json`，请维护代码的同事核对原项目路径和 Python 构建路径。保存后重新双击 `发布应用.bat`；配置已核对好的电脑可跳过此项。
4. 在应用编号菜单输入 **`0`**，等待打包完成。

工具会构建各应用、制作 Docker 镜像并导出文件。**完成标准：** 窗口显示“打包完成”，资源管理器选中 `release/planhub-时间戳/`。

线索声量按已配置的网页来源打包；正式交付使用内网真实页面，不用接入样例。

接下来只搬这个选中的文件夹。它里面有 `start.cmd`、`stop.cmd`、`preview.cmd`、`stop-preview.cmd`、`images.tar` 和 `README.md` 等文件；`images.tar` 由脚本处理，保留原文件即可。新增试运行入口后，需要在 A 重新打包，再复制新包到 B。

## 第三步：在 B 放好程序包、配置和数据

**操作位置：B。目的：为下一步正式部署准备文件和数据。**

1. 在 B 选一个长期保留的位置，新建 `planhub` 文件夹。
2. 将 A 生成的整个 `planhub-时间戳` 文件夹复制进去。
3. 打开刚复制的版本文件夹，确认能直接看到 `start.cmd`。在资源管理器地址栏输入 `powershell` 并回车，然后执行：

```powershell
.\deploy.ps1 -Action Prepare
```

这条命令只创建配置和数据目录，**这时还没有部署、启动工作台**。它会在版本文件夹旁边生成 `planhub-runtime`。

接着将真实共享规则 `shared_config.py` 放到 `planhub-runtime/config/`；该文件默认来自订单原项目的 `../订单分析/scripts/config/shared_config.py`（路径相对门户源码目录）。将现有“共享数据”文件夹里面的内容放到 `planhub-runtime/shared/`，保留业务子目录名。

此时 B 的目录应是：

```text
planhub/                           ← B 上新建的总目录
├─ planhub-时间戳/                 ← 从 A 完整复制的程序包
│  ├─ start.cmd                    ← 下一步双击这个文件部署
│  ├─ stop.cmd
│  ├─ preview.cmd                  ← 可选：先在 B 本机试运行
│  ├─ stop-preview.cmd
│  ├─ deploy.ps1
│  ├─ images.tar
│  └─ 其他随包文件
└─ planhub-runtime/                ← 配置和数据，长期保留
   ├─ config.json
   ├─ config/
   │  └─ shared_config.py
   ├─ shared/
   │  ├─ 订单汇总/
   │  ├─ 对账资料/
   │  └─ 其他现有业务目录
   └─ data/                       ← 各应用保存的数据
```

**哪些东西放进 `data/`？**

`shared/` 放共用的原始 Excel；`data/` 放各网页已经保存的计划、批注、数据库和上传文件。**第一次部署到 B，也可能有需要保留的旧内容**：以前在 A 的本地网页里保存过，就属于旧数据。

需要保留时，先停止原应用，保留原件作备份，再将下面指定的文件或目录内容复制到 B。复制的是旧目录里面的内容，例如 `sop.sqlite3` 应直接在 `data/sop/` 下。

| 应用 | 旧电脑上取哪些内容（默认位置，相对原门户源码目录） | 放到 B 的哪里（相对 `planhub-runtime/`） |
|---|---|---|
| SOP 计划 | `../SOP维护/data/` 的内容：核心是 `sop.sqlite3`，连同 `sales.json`、`source_settings.json`、历史备份等一起保留；旧 `service.json`、`service.pid` 不必复制 | `data/sop/` |
| 订单分析批注 | `../订单分析/data/order_dashboard/` 的内容，关键文件为 `annotations.sqlite3` | `data/orderiq/annotations/` |
| 数据速查 | 本次不沿用旧数据速查文件，无需复制原 `output_file/` | `data/quicklook/` 留空，由程序创建；共享 Excel 从 `shared/` 读取 |
| 车型配置 | 原 `../共享数据/车型配置/` 的全部内容，包括 `catalog.sqlite3`、`current.json`、`drafts/`、`history/` | `data/vehicle-config/` |
| 订单分析旧报表批次（可选） | 要保留历史批次时，复制 `../订单分析/output_file/runtime/` 的全部内容，包括 `current.json` 和 `datasets/` | `data/orderiq/runtime/`；不保留旧批次时可留空，从共享 Excel 重新生成 |
| 销量预测 | 通常无需复制旧 `output_file/`，页面和缓存可从共享 Excel 重新生成 | `data/forecast/` 可留空，由程序创建 |

这些是原应用的默认位置；如果原服务配置过其他数据目录，取它**实际使用的目录**。原项目的 `output_file/releases/` 等程序发布包不属于业务数据，不用复制进来。门户和线索声量页面已包含在程序包中。

如果某个应用以前完全没用过、没有记录要保留，对应 `data/` 子目录可以留空。SOP 已保存的计划在 `sop.sqlite3` 中，不能只搬一份旧维护 Excel 代替。销量预测的网页人工参数保存在原浏览器中，复制服务器文件不会自动迁移浏览器设置。

**完成标准：** 程序包在 B；`planhub-runtime` 和 `config.json` 已生成；共享规则、共享 Excel 和需要保留的旧数据已按上述位置准备好。数据速查按全新使用准备，无需迁移旧库或修改额外路径参数。

### 第三步完成后：先在 B 本机试运行（可选）

**操作位置：B 的完整版本文件夹，即能直接看到 `preview.cmd` 的文件夹。** 此时可以不填写公司访问地址，也不接公司认证入口。

1. 确认 B 的 Docker 已启动，原来使用这份数据的服务已停止。
2. 双击 **`preview.cmd`**。首次会将第三步准备的规则、共享 Excel 和应用数据复制到旁边的 `planhub-preview/`，然后启动独立的试运行容器。数据较多时，首次复制需要等待。
3. 试运行就绪后会自动打开 B 的浏览器，地址是 **`http://127.0.0.1:4174/`**；也可手动输入这个地址。进入各应用检查页面、查询、保存和导入导出。数据速查及销量预测首次处理数据时，等页面更新完成再验收。
4. 检查结束后，双击 **`stop-preview.cmd`** 停止试运行，再继续第四步。

试运行只供 B 本机访问。你在试运行里保存、上传或生成的内容留在副本中，不会合并到正式 `planhub-runtime/`；正式配置里的地址也不受影响。停止后副本保留，再次试运行会沿用它。需要重新复制第三步的最新数据时，确认使用源数据的正式服务已停止，再在版本文件夹的 PowerShell 执行：

```powershell
.\preview.cmd -RefreshSnapshot
```

工具会先停止现有试运行，再新建一份副本，旧副本保留。副本由脚本通过显式 `-Snapshot` 选项创建，无需你手动修改配置。

**完成标准：** B 的浏览器可从上述本机地址进入工作台和各动态网页。公司入口与账号认证仍在第五步单独验收。

## 第四步：在 B 部署程序，并让它后台运行

**操作位置：B 的 `planhub/planhub-时间戳/`，就是第三步复制的版本文件夹。**

1. 如果刚做过本机试运行，先双击 `stop-preview.cmd`。然后用记事本打开旁边的 `planhub-runtime/config.json`，将 `publicOrigin` 改成同事提供的访问地址，例如 `https://planhub.company.internal`，结尾不带 `/`，保存。
2. 回到第三步复制的版本文件夹，**双击里面的 `start.cmd`。这一步就是正式部署。**

脚本会自动完成下面的工作，无需再手动导入镜像或输入 Docker 部署命令：

1. 检查程序包和配置。
2. 把 `images.tar` 中的程序镜像导入 B 的 Docker。
3. 创建并启动工作台及各应用容器，让程序在后台运行。
4. 等待各应用正常响应，再显示检查结果。

**完成标准：** 窗口显示 `Containers are healthy`，随后约 3 秒自动关闭。工作台继续在 B 后台运行，继续做第五步接入浏览器访问。

如果窗口保留并显示错误，这一步没有完成。保留错误内容交给同事排查；不要把出现 Docker 列表或窗口关闭本身当作成功。

## 第五步：让部门电脑能访问，并确认可用

**操作位置：同事负责公司入口；你从部门电脑用浏览器验收。**

1. 将下方“给接入同事的参数”交给同事，请他把 B 上已运行的工作台接到第四步填写的公司地址。
2. 接入完成后，在浏览器输入那个地址，例如 `https://planhub.company.internal`，打开门户及六个应用，确认能正常操作。
3. 做一次实际保存或导入导出，停止再启动后确认数据仍在、操作人记录正确。销量预测需要真实输入才能生成报表。
4. 请同事确认 Docker 随 B 启动，并安排一次 B 重启验收，确认重启后还能使用。

需要检查容器时，在 **B 的版本文件夹** 地址栏输入 `powershell`，执行：

```powershell
.\deploy.ps1 -Action Status
```

各应用应显示 `healthy`；`network` 是网络辅助容器，显示运行中即可。直接访问 B 的 `127.0.0.1:4173` 可能返回 403，正式使用公司接入后的地址。

**完成标准：部门电脑能进入各应用、业务操作正常、数据重启保留。到这里才算部署成功。**

## 以后更新、停止和排错

| 需要做什么 | 在哪里、怎么做 |
|---|---|
| 更新一个应用 | A 打开 `发布应用.bat`，选对应编号；把新包复制到 B 的同一个 `planhub/` 总目录，与旧包并排。等业务操作结束后，在**新版本文件夹**双击 `start.cmd`，它会停止并更新该应用。 |
| 更新整套 | A 输入 `0` 打包；B 在新版本包里运行 `start.cmd`，会停止并更新整套应用。新增应用或修改运行配置时用这一方式；新增导航入口也要交付更新后的门户。 |
| 保留原数据 | 新旧版本都使用旁边同一份 `planhub-runtime/`。日常更新沿用它，第三步的首次准备不用重做。 |
| 本机试运行 / 停止 | B 在完整包里双击 `preview.cmd`，浏览器打开 `http://127.0.0.1:4174/`；结束时双击 `stop-preview.cmd`。 |
| 停止运行 | B 双击包内 `stop.cmd`。完整包停止整套，单应用包只停止该应用，数据保留。关闭浏览器或 CMD 窗口不会停止容器。 |
| 查看错误日志 | B 在对应版本文件夹打开 PowerShell，执行 `.\deploy.ps1 -Action Logs -AppId orderiq`；将 `orderiq` 换成要检查的应用 ID。 |

手动停止后，再用 `start.cmd` 启动。回退旧版前由同事确认数据兼容，再运行旧包；工具不回滚数据库。

<details>
<summary>给接入同事的参数（转交即可）</summary>

- 默认上游：B 本机 `http://127.0.0.1:4173`；转发全部路径，保留公共 Host、Origin 和请求体。
- 公共地址：与 B 的 `planhub-runtime/config.json` 中 `publicOrigin` 一致。
- 公司认证后，覆盖 `X-PlanHub-User` 为真实 ASCII 域账号或 UPN，覆盖 `X-PlanHub-Key` 为该配置中的 `proxySecret`，不透传客户端自报身份。
- 网关不在 B 时，按公司网络规则调整 `listenAddress` 并限制上游访问。密钥仅供服务端使用。
- 宿主重启后需先有 Docker 运行；容器使用 `restart: unless-stopped`。手动停止的容器需再次启动。
- 本机试运行使用独立 Compose 项目 `planhub-preview`，只绑定 `127.0.0.1:4174`，容器不设自动恢复。操作人来自 B 当前 Windows 登录账号；现有身份契约需要 ASCII 域账号或 UPN。公司认证仍由正式入口负责。

</details>
