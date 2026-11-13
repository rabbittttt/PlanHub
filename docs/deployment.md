# 从打包到 Docker 部署：五步完成

**A 负责打包，B 负责运行。首次只搬一个文件夹。公司认证由同事接入。**

## 第一步：检查 A、B 的 Docker

两台电脑分别打开 PowerShell，运行：

```powershell
docker version
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

应看到 Docker **Server** 信息、Compose **v2.20+**，最后一行是 `linux/x86_64` 或 `linux/amd64`。未安装或连接失败，先让同事安装并启动 Docker。Windows 工作站使用 [Docker Desktop 的 Linux 容器模式](https://docs.docker.com/desktop/setup/install/windows-install/)；Windows Server 交由同事提供适用的 Linux 容器环境。

A 继续使用现有 Node.js 20+、Python 构建环境，并能访问公司允许的镜像源及 Python 依赖源。**B 无需另装 Node.js、Python，也无需下载依赖。**

## 第二步：在 A 打包

1. 更新门户和各应用代码，确认本地功能正常；首次核对 `config.local/publish.json` 的项目路径和构建命令。
2. 双击 **`发布应用.bat`**，输入 **`0`**。
3. 等待构建、校验和镜像导出全部成功，工具会选中 **`release/planhub-时间戳/`**。

线索声量须换成内网真实页面，再在本机发布配置确认 `applications.leads.businessSourceConfirmed=true`，不能交付接入样例。其他应用会调用已有构建入口，不需要先手动生成订单业务报表。

```text
planhub-20261113-120000-000/
  README.md
  start.cmd
  stop.cmd
  deploy.ps1
  compose.json
  images.tar
  delivery.json
  runtime.example.json
```

**只复制这个文件夹。** 不搬源码、`staging` 或旧 `bundles`。`images.tar` 是离线镜像，交给 Docker 导入，不用解压。

## 第三步：复制到 B，准备运行目录

在收到的文件夹里打开 PowerShell，运行：

```powershell
.\deploy.ps1 -Action Prepare
```

它会在旁边生成 **`planhub-runtime/`**。首次完成三件事：

1. 打开 `../planhub-runtime/config.json`，把 `publicOrigin` 改成公司分配的入口，例如 `https://planhub.company.internal`，结尾不带 `/`。
2. 真实共享规则放到 `config/shared_config.py`；共享输入放到 `shared/`，保留原业务目录名。
3. 要接续旧数据时，由同事停止旧服务、接好对应持久目录并核对。新装可以没有历史数据，但不能用空样例代替共享规则。

```text
parent/
  planhub-版本号/          程序包
  planhub-runtime/        长期保留，更新不替换
    config.json
    config/shared_config.py
    shared/
    data/sop/
    data/orderiq/runtime/
    data/orderiq/annotations/
    data/forecast/
    data/quicklook/
    data/vehicle-config/
```

数据速查的历史来源需核对 `quicklookSourceBase`，Windows 绝对路径不能直接带进 Linux 容器。运行目录与程序包不能相互包含。该五步说明会原样放入交付包的 `README.md`，B 可直接查看。

## 第四步：启动，并接公司入口

双击 **`start.cmd`**。它会校验文件、导入镜像、启动容器并等待健康检查。成功 3 秒后窗口关闭，容器继续运行；失败保留窗口和日志。

把这一段交给负责公司入口的同事即可：

> 上游默认为 B 的 `http://127.0.0.1:4173`，转发全部路径并保留公共 Host、Origin、请求体。公司认证后覆盖 `X-PlanHub-User` 为真实 ASCII 域账号或 UPN，覆盖 `X-PlanHub-Key` 为 B 外置 config.json 的 proxySecret；不能透传客户端自报身份。公共入口须与 publicOrigin 一致。网关不在 B 时，按公司网络规则调整 listenAddress 并限制上游访问。

密钥不放入浏览器或交付包。直接访问上游返回 **403 是正常的**，用户从公司认证入口进入。工具不配置公司账号、DNS、防火墙。

## 第五步：确认部署成功

1. B 运行 `.\deploy.ps1 -Action Status`，应用容器应全部 **healthy**。
2. 从另一台部门电脑打开公司入口，门户及六个应用可以进入；销量预测有真实输入后能生成报表。
3. 验收查询、保存、导入导出和真实操作人记录；停止再启动后，数据仍在。
4. 同事确认 Docker 随 B 启动，再做一次重启验收。

**以上通过，才算部署成功。** healthy 只证明服务正常响应；手动停止的容器需重新启动，Docker 未运行时容器也不会自动恢复。

## 以后更新、停止、排错

- **更新一个应用**：A 选择它的编号打包，新包放在 B 的同一父目录。业务操作结束后双击新包 `start.cmd`，只更新该应用，沿用同一份数据。新增入口还需更新门户；新增应用或修改运行配置时选 `0`。
- **停止**：完整包的 `stop.cmd` 停整套，单应用包只停对应应用，均保留数据。关闭浏览器或 CMD 不会停止容器。
- **查看日志**：在包目录运行 `.\deploy.ps1 -Action Logs -AppId orderiq`，将 `orderiq` 换成要检查的应用 ID。修复后再启动。回退前确认旧程序兼容当前数据，再启动旧包；不会自动回滚数据库。

开发联调仍用源码目录的启动/停止 CMD。旧 IIS、计划任务、WinRM 和本机发布版启动器不再属于当前发布流程。
