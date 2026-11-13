# 第一次把工作台部署到 B：按这五步做

**A 是有源码的打包电脑，B 是长期运行工作台的部署电脑。** 先在 A 制作程序包，再复制到 B 安装运行，最后从部门浏览器访问。

**`start.cmd` 是 B 上的“一键部署并启动”入口。** 首次运行会安装并启动收到的版本；以后在新版本包里运行它，会更新并启动该版本。打开网页则是在浏览器输入公司提供的工作台地址。

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

A 还需保留现有 Node.js 20+、Python 构建环境，并能访问公司允许的镜像和依赖源。B 的 Node.js、Python 和依赖由程序包提供。请公司接入同事先给出最终访问地址，第三步要填写它。

## 第二步：在 A 制作完整程序包

**操作位置：A 的工作台源码目录，也就是能看到 `发布应用.bat` 的文件夹。目的：生成要带给 B 的程序。**

1. 更新门户和各应用源码。
2. 双击 **`发布应用.bat`**。工具会自动创建 `config.local/` 和其中的 `publish.json`，已有配置会继续沿用，无需手动新建或复制模板。
3. **仅首次配置时：** 看到应用编号菜单后先关闭窗口，打开自动生成的 `config.local/publish.json`，请维护代码的同事核对原项目路径和 Python 构建路径。线索声量须使用内网真实网页，再将 `applications.leads.businessSourceConfirmed` 设为 `true`。保存后重新双击 `发布应用.bat`；配置已核对好的电脑可跳过此项。
4. 在应用编号菜单输入 **`0`**，等待打包完成。

工具会构建各应用、制作 Docker 镜像并导出文件。**完成标准：** 窗口显示“打包完成”，资源管理器选中 `release/planhub-时间戳/`。

接下来只搬这个选中的文件夹。它里面有 `start.cmd`、`stop.cmd`、`images.tar` 和 `README.md` 等文件；`images.tar` 由部署脚本处理，保留原文件即可。

## 第三步：在 B 放好程序包、配置和数据

**操作位置：B。目的：为下一步正式部署准备文件和数据。**

1. 在 B 选一个长期保留的位置，新建 `planhub` 文件夹。
2. 将 A 生成的整个 `planhub-时间戳` 文件夹复制进去。
3. 打开刚复制的版本文件夹，确认能直接看到 `start.cmd`。在资源管理器地址栏输入 `powershell` 并回车，然后执行：

```powershell
.\deploy.ps1 -Action Prepare
```

这条命令只创建配置和数据目录，**这时还没有部署、启动工作台**。它会在版本文件夹旁边生成 `planhub-runtime`。

接着在 B 完成两件事：

- 用记事本打开 `planhub-runtime/config.json`，将 `publicOrigin` 改成同事提供的访问地址，例如 `https://planhub.company.internal`，结尾不带 `/`，保存。
- 将真实共享规则 `shared_config.py` 放到 `planhub-runtime/config/`；该文件默认来自订单原项目的 `../订单分析/scripts/config/shared_config.py`（路径相对门户源码目录）。将现有“共享数据”文件夹里面的内容放到 `planhub-runtime/shared/`，保留业务子目录名。

此时 B 的目录应是：

```text
planhub/                           ← B 上新建的总目录
├─ planhub-时间戳/                 ← 从 A 完整复制的程序包
│  ├─ start.cmd                    ← 下一步双击这个文件部署
│  ├─ stop.cmd
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

如果要接续旧数据库、上传或设置，请同事先停止旧服务，再按原项目的数据目录契约迁移到 `data/`。数据速查的历史来源还需核对配置中的 `quicklookSourceBase`，原 Windows 绝对路径不能直接带进 Linux 容器。

**完成标准：** 程序包在 B；`config.json` 已填真实访问地址；共享规则和数据已放好。

## 第四步：在 B 部署程序，并让它后台运行

**操作位置：B 的 `planhub/planhub-时间戳/`，就是第三步复制的版本文件夹。**

完成第三步后，**双击这个文件夹里的 `start.cmd`。这一步就是正式部署。**

脚本会自动完成下面的工作，无需再手动导入镜像或输入 Docker 部署命令：

1. 检查程序包和配置。
2. 把 `images.tar` 中的程序镜像导入 B 的 Docker。
3. 创建并启动工作台及各应用容器，让程序在后台运行。
4. 等待各应用正常响应，再显示检查结果。

**完成标准：** 窗口显示 `Containers are healthy`，随后约 3 秒自动关闭。工作台继续在 B 后台运行，继续做第五步接入浏览器访问。

如果窗口保留并显示错误，这一步没有完成。保留错误内容交给同事排查；不要把出现 Docker 列表或窗口关闭本身当作成功。

## 第五步：让部门电脑能访问，并确认可用

**操作位置：同事负责公司入口；你从部门电脑用浏览器验收。**

1. 将下方“给接入同事的参数”交给同事，请他把 B 上已运行的工作台接到第三步填写的公司地址。
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

</details>
