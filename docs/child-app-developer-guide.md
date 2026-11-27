# 工作台网页接入手册

**网页开发者做第一、二步，工作台接入者做第三步，两人在第四步一起验证。能从开发版工作台打开网页并完成业务操作，就完成了接入。** 已接入的网页只改内容，直接看文末的[以后更新](#以后更新)。

<a id="integration-boundary"></a>

业务页面、数据、权限和计算逻辑由网页开发者在**原项目**维护。工作台接入者在**计划工作台**登记入口、配置启动和转发。两边在内网交接。下文命令从包含 `package.json`、`portal/` 和 `deploy/` 的工作台根目录运行。

<a id="portal-ai-task"></a>

## 第一步　网页开发者准备项目和文件

把原项目放在工作台旁边。下面用“产能分析”举例，应用 ID 为 `capacity`，以后在工作台中的固定入口为 `/capacity/`。按网页实际运行方式选一列。

| 要准备什么 | 静态网页 | 动态网页（现有 Python 服务） |
|---|---|---|
| 程序放哪里 | HTML 和配套资源放在原项目，如 `../产能分析/dist/index.html` 和 `../产能分析/dist/assets/`。单文件网页只需 HTML | 服务入口、业务模块、前端资源和依赖清单放在原项目。生成报表的网页还需放好生成脚本和模板 |
| 开发者先验证什么 | 打开生成的网页，核对业务内容、图片、脚本及下载链接。交付正式业务页 | 从原项目启动、查询并停止服务，记下工作目录、启动命令、默认端口、健康地址及一份正常的 JSON 响应 |
| 交给接入者什么 | 网页名称、ID、网页文件目录、入口文件名和需要公开的文件或资源目录 | 网页名称、ID、启动命令、健康检查、访问前缀，以及服务需要读取和写入的路径 |

已有的单文件例子是 `../精品附件/boutique-dashboard.html`。网页内容保存在这个文件，接入者用 `boutique` 登记；开发者日后仍在原项目更新文件。[现有项目目录与入口](../README.md#开发联调)

<a id="页面必须满足的约定"></a>

## 第二步　网页开发者适配访问地址和数据目录

1. **从工作台入口打开也要能用。** HTML、脚本、图片、接口和下载共同使用 `/<id>/` 前缀。例如产能分析引用图片时可写 `assets/logo.svg`，由浏览器从 `/capacity/assets/logo.svg` 读取。动态页的 API 也走本应用前缀。允许同源 iframe 嵌入，响应中不要设置 `X-Frame-Options` 或 CSP `frame-ancestors`，页面脚本不要强制跳出 iframe。
2. **内嵌标题由子页自己处理。** 子页可用 `window.frameElement?.matches('#frame-container > iframe[data-app="capacity"]')` 判断是否从工作台打开，将示例 ID 换成自己的。内嵌时收起标题左侧图标和占位，独立打开时保留。门户不注入样式、脚本或改写页面响应。[内嵌业务页 UI 规范](ui-guidelines.md#内嵌业务页)
3. **动态页提供启动命令和健康接口。** 服务以前台方式监听可配置的回环端口，提供轻量只读健康接口。例如 `/healthz` 返回 HTTP 200 和 `{"ok":true,"app":"capacity"}`，即使尚未导入业务数据也能检查服务身份。如果原来已有生成 HTML 的脚本，由这个服务调用它，并从固定地址提供最新页面。

<a id="集中持久目录"></a>
<a id="共享输入目录"></a>

**数据放哪里。** 在开发电脑上，部门共享 Excel 放在 `../工作台数据/shared/`，应用自己的数据库、上传和运行中生成的报表放在 `../工作台数据/database/<id>/`，应用日志放在 `../工作台数据/logs/<id>/`。开发版的默认根目录见 `integration/apps.json` 的 `sharedDataRoot` 和 `dataRoot`。本机路径有差异时在 `config.local/apps.json` 覆盖；共享根还可由 `SHARED_DATA_ROOT` 指定。

<a id="portal-integration"></a>

## 第三步　工作台接入者在 A 登记导航和本机入口

1. 双击工作台根目录的 **`接入新网页.bat`**。填双方约定的 ID、导航名称、分组和排序。ID 以小写字母开头，后续可用小写字母、数字或连字符。已有静态页要改成动态页时，填原 ID 和导航名称，类型选 `2 动态`，在“更新它？”处输入 `y`。原来的访问地址继续有效。
2. 根据第一步的交接信息填写向导。

   | 向导里的选项 | 怎么填 |
   |---|---|
   | `1 静态` | 产能分析示例填发布目录 `../产能分析/dist`、入口 `index.html`、额外资源 `assets/`。单 HTML 的额外资源留空。多个资源用英文逗号分隔，目录名结尾加 `/` |
   | `2 动态` | 填默认端口、健康路径、返回的 JSON 顶层字段和是否去掉前缀。例如对外 `/capacity/healthz`、后端实际接收 `/healthz` 时，去掉前缀选 `y` |
   | 动态页由门户启动 | 填 `start.cwd` 和 `start.command`，两者路径都相对工作台根目录，例如 `../数据速查` 和 `../.venv/Scripts/python.exe`。参数按原服务命令写成 JSON 数组，如 `["-B","server.py","--port","{port}"]`；这里的脚本名相对 `start.cwd`。动态页尚未验收时保留 `pending` |

3. 确认保存。向导会更新下面两个文件，并将原配置备份到 `config.local/backups/registration-*/`。

   | 文件 | 保存的内容 |
   |---|---|
   | [portal/config/apps.json](../portal/config/apps.json) | 首页与侧栏的名称、入口、排序、启用状态。需要在应用目录显示一句简介时，填写该应用的 `description` |
   | `config.local/apps.json` | A 本机的静态目录和公开文件，或动态服务的启动方式与健康检查。此文件留在 A |

要由脚本重复登记，可把同样的信息保存到 `config.local/new-app.json`。先运行 `node scripts/register-app.mjs --config config.local/new-app.json --dry-run` 检查，去掉 `--dry-run` 后保存。JSON 中更新已有 ID 时加 `"replace": true`。[登记工具](../scripts/register-app.mjs)

## 第四步　双方在开发版验证网页

1. **接入者启动。** 仅调试静态页，在工作台根目录运行 `npm run dev:static` 并保持窗口打开。整套联调时，先按原方式停止占用端口的独立服务，再双击 `启动本地门户.cmd`。配置变更后重新启动开发门户。
2. **开发者看实际页面。** 先打开应用入口，如 `http://127.0.0.1:4173/capacity/`，检查页面、图片、脚本和下载。如果服务定时生成报表，更新一份测试输入，等待一次检测周期，刷新后核对报表内容。支持写入的网页还要验证保存和重启后的记录。动态页验证通过后，由接入者在 `portal/config/apps.json` 将该 ID 的 `status` 从 `pending` 改为 `ready`，刷新首页并点击导航，核对同源嵌入效果。集成配置或服务异常时运行 `npm run diagnose`。
3. **接入者检查。** 在具备全部已启用项目的开发工作区运行 `npm run check`、`npm test`。有界面或导航改动时，打开开发门户，在桌面和手机宽度检查。样式检查命令为 `..\.venv\Scripts\python.exe -B scripts/check-app-styles.py`；若新应用提示未登记导航控件，在该脚本补上实际标题、导航选择器后复测。

<a id="current-contracts"></a>

### 需要同事在其他开发电脑复用时

向导保存的 `config.local/apps.json` 只对当前电脑生效。如果其他开发电脑也要通过同一入口联调，接入者将通用设置归入 [integration/apps.json](../integration/apps.json) 的 `applications.<id>`，本机特例继续留在 `config.local/`。

- 静态页参考 `boutique`，设置 `type: static`、`root`、`entry` 和 `publicPaths`。
- 动态页参考已有代理，设置 `type: proxy`、`target: http://127.0.0.1:{port}`、`stripPrefix`、`rootRoutes: []`、`healthPath`、`healthKeys` 和 `start`。把原服务的默认端口登记在 [integration/ports.json](../integration/ports.json) 的同一 ID 下；启动参数使用 `{port}`。已有发布绑定的应用可以用 `useReleaseContract: true` 复用其健康检查与前缀设置。

<a id="docker-contracts"></a>

以后需要向 B 交付这个应用时，见[部署手册](deployment.md#新应用首次交付前的配置)。

## 以后更新

| 这次改什么 | 谁改、改哪里 | 怎样看到新版 |
|---|---|---|
| 已接入网页的 HTML、样式或业务代码 | 开发者改原项目。已有应用在固定前缀内增加页面或 API，沿用原 ID | 静态页重新生成后刷新整个开发门户；动态服务重启后验证 |
| 网页改名、换目录、增资源或换启动参数 | 接入者按第三步更新受影响的注册信息、公开文件或启动配置。单机路径写在 `config.local/` | 重启开发门户，从导航打开并核对页面 |
| 更新共享文件或业务记录 | 数据维护者操作第二步对应的数据目录，按业务要求备份或停服 | 数据刷新由原应用负责。门户切换时会保留已经加载的页面，保存手头工作后再刷新 |

### 特殊情况

- **操作人。** 外层系统在工作台 iframe 加载时，通过 `postMessage` 向工作台的准确来源发送 `{account, roleCode, roleName}`。工作台核对直接父窗口及来源，在 SOP 和车型配置子页加载或账号切换时向它们转发，两者用该账号记录操作人。直接在本机预览时使用 `local-debug`，正式服务等待外层账号。部署机可用 `accountParentOrigin` 固定父来源。公司入口的认证和可信代理设置见[部署手册第五步](deployment.md#第五步-从部门电脑验收)。
- **服务归属。** 默认开发模式下，SOP 暂不可用时，首页和其他已正常启动的应用仍可打开。修复来源或配置后，开发门户每 60 秒重试 SOP。开发门户管理 `start` 登记的进程。确需独立运行的服务显式设 `start: null`，在登记用的 JSON 配置中同时填写 `healthExpected`（例如 `{"ok":true,"app":"capacity"}`），用 `--config` 登记。独立 Python 启动器有额外入口时，可在 `standalone.entries` 或 `standalone.launchers` 登记相对 `start.cwd` 的路径，供 `停止独立网页.cmd` 识别。
- **旧数据与缓存。** 仅在旧环境迁移时，先停服并备份。旧应用数据和共享目录分别用 [应用数据迁移工具](../scripts/migrate-storage.py) 和 [共享目录迁移工具](../scripts/migrate-shared.py) 核对计划。应用自行判断输入、规则或模板变更后是否重算；更新程序时沿用已核对的持久目录。
