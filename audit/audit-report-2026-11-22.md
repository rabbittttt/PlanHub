# 计划工作台（PlanHub）项目审计报告

- 审计日期：2026-11-22
- 审计对象：`计划工作台` 仓库（main @ aa61aa0，工作区干净），共 121 个 Git 跟踪文件
- 审计范围：门户前端（`portal/`）、Node 工具链（`scripts/*.mjs` 约 30 个）、部署链路（`deploy/` 全部 ps1/cmd/json）、集成配置（`integration/`）、文档与设计基准（`docs/`、`design-system/`、`README.md`、`AGENTS.md`）、Python 辅助工具（`scripts/*.py`）
- 边界说明：按 AGENTS.md 约定，六个子应用源码（SOP维护/订单分析/销量预测/线索声量/数据速查/配置管理）不属于本项目审计范围，仅审计门户对它们的集成面
- 方法：逐文件人工审读 + `npm run check` 实测 + `npm test` 两轮完整实测

## 修订说明（基于当前门户及 SOP 源码复核）

以下三处修正优先于原审计记录。

- **M1** 已有限制消息来自直接父窗口。此前用浏览器提供的父来源做比对仍会信任实际嵌入者，无法证明对方是公司系统。SOP 把门户账号用于数据请求和写入归属，网关身份校验与业务操作人归属是两项不同的检查。门户现默认仅接受同源账户消息，可在部署机显式登记一个可信父系统。浏览器的来源校验不能代替服务端核对账号。
- **M2 / M4** 并发负载可以解释部分超时，不能解释全部失败。降低并发后，持久化测试还稳定出现过 HTTP 403。旧用例缺少目前 SOP 页面会携带的账号，已按真实页面契约修正。测试仍需断言保存成功、重启后读回相同数据。
- **M3 / L7 / I4** 源码联调与 Windows 发布包试运行都经 `createContainerPortal` 或直接调用 `createServer` 进入 SOP 代理；Docker 门户也复用该代理。L7 指向的挂载根入口 ID 已限制为 ASCII，普通子目录走另一分支。目录跳转现统一保留原请求编码和查询串。实例记录带实例 ID，单个历史文件的存在不足以断定当前服务无法停止。

原记录下列计数按条目应为 4 个信息项。Docker 部署脚本的测试使用替身，真实内网认证及容器仍须实机验收。

## 总体结论

**整体质量高于一般内部工具水准，未发现可被利用的高危漏洞。** 安全设计系统性且自觉：路径穿越防护、回环代理白名单、请求头剥离、控制令牌校验、不可变产物逐文件哈希校验、密钥不进仓库不进镜像、新旧服务互斥标记等都有完整实现，且大部分约定（AGENTS.md / 设计基准）与实现一致。

主要问题集中在四类：

1. **测试门禁当前是红的**：`npm test` 140 用例中 10 失败、1 取消（两轮失败集合不固定），失败全部是进程孵化/时序敏感的集成测试在并行负载下的超时；同时这批失败暴露了两处生产代码的单次硬超时脆弱点。
2. **本机启动链路对慢环境无韧性**：PowerShell 取账户、Python 探测均为单次 spawnSync + 硬超时，超时即整个门户启动失败。
3. **账号消息来源校验存在缺口**（伪造操作人显示，影响限于前端）。
4. **少量遗留与数据卫生问题**：孤儿 IIS 配置、runtime 临时目录无清理、双源版本号等。

严重级别分布：高危 0，中 4，低 10，信息 3。

---

## 一、验证结果

### npm run check — 通过

```
检查通过：6 个已启用应用，55 个 JavaScript 文件。
```

5 条警告均为预期提示（proxy 应用不随配置检查启动独立服务）。

### npm test — 未通过（10 失败 / 1 取消 / 129 通过）

两轮完整运行结果：

| 轮次 | 通过 | 失败 | 取消 |
|---|---|---|---|
| 第一轮 | 131 | 8 | 1 |
| 第二轮 | 129 | 10 | 1 |

**两轮失败集合不固定**，且全部失败位于孵化子进程（PowerShell / Python / cmd.exe / fixture 服务）的集成测试，错误形态为 `ETIMEDOUT` / `ECONNRESET` / fixture 启动超时 / 断言窗口错过。node:test 默认并行跑测试文件，26 个文件同时孵化 Python/PowerShell fixture，本机负载直接放大超时概率。结论：**用例本身高负载下不稳定**，但其中两条（见 M1/M2）同时暴露了生产代码的真实脆弱点。

失败明细（第二轮）：

| # | 用例 | 位置 | 错误 |
|---|---|---|---|
| 55 | native preview uses the registered child default port… | tests/native-preview.test.mjs:110 | read ECONNRESET |
| 59 | detached preview reuses the owned actual mapping… | tests/native-preview.test.mjs:167 | Preview startup timed out |
| 60 | a runtime-free delivery starts a static preview… | tests/native-preview.test.mjs:182 | Preview startup timed out |
| 78 | stop waits for portal and backend ports… | tests/portal-instance.test.mjs:68 | Timed out starting the isolated shutdown fixture |
| 107 | default portal saves through the original SOP service… | tests/sop-persistence.test.mjs:33 | 无法读取当前 Windows 登录账户（生产路径） |
| 123 | preview executes independent source with a separate… | tests/sop-source-integration.test.mjs:169 | Python 探测 spawnSync ETIMEDOUT（生产路径） |
| 127 | the actual Windows CMD exits after the three-second… | tests/start-background.test.mjs:184 | 成功 CMD 未在窗口期退出 |
| 128 | repeated background launch reuses the running… | tests/start-background.test.mjs:222 | 后台启动等待超时（生产路径） |
| 130 | a ready message is rejected if the new worker exits… | tests/start-background.test.mjs:250 | test timed out after 15000ms |
| 131 | forged readiness cannot adopt or terminate… | tests/start-background.test.mjs:258 | The external fixture did not start |
| 132 | Windows timeout stops the launcher-owned process tree… | tests/start-background.test.mjs:274 | The unrelated fixture did not start |

另有 1 个取消用例（TAP 汇总计数，无独立条目，属文件级中断）。

### 环境核对

兄弟项目目录（SOP维护/订单分析/销量预测/线索声量/数据速查/配置管理/工作台数据）全部存在；git 分支 main 与 origin/main 同步、工作区干净；`config.local/`、`runtime/` 均正确被 .gitignore 忽略，未发现敏感文件被跟踪。

---

## 二、发现清单

### 中危（4 项）

#### M1. 外层账号消息来源校验存在缺口，可注入伪造操作人显示

- 位置：`portal/js/frame-account.js:4-25`
- 问题：`parentOrigin` 初始取 `location.ancestorOrigins?.[0]`，缺失时回退 `document.referrer`。当两者都不可得时 `parentOrigin` 为空，后续校验 `(parentOrigin && event.origin !== parentOrigin)` 短路——**任何 http(s) 来源发来的第一条含合法 `account` 字段的 postMessage 都会被接受**，并把该来源锁定为后续 `parentOrigin`。
- 影响：门户页面按约定不设置 `frame-ancestors`（允许嵌入），任意网页可嵌入门户并注入伪造的 `{account, roleCode, roleName}`；该身份会在 SOP 子页面加载时经 `deliverSopAccount` 转发给 SOP 前端展示。业务后端的操作人记录仍来自服务端身份头（`X-SOP-User` / `X-Config-User`），**不受此影响**，故危害限于前端显示误导。
- 建议：`parentOrigin` 未知时不接受账号消息（保持 identity 为 null），或在 `portal/config/apps.json` 显式登记允许的外层来源。

#### M2. 本机启动链路的两个单次硬超时使启动在慢环境下整链失败

- 位置：
  - `scripts/dev-sop.mjs:29-34` — `localSopUserHeader()` 用 spawnSync 调 PowerShell 读 Windows 账户，`timeout: 10000`，单次尝试，无重试；
  - `scripts/sop-python.mjs:11` — Python 探测（含 `import openpyxl`）`timeout: 15000`，单次尝试。
- 问题：两者超时或 spawn 失败时直接抛错、**门户启动整体失败**。冷启动的 venv Python 首次 `import openpyxl` 可能超过 15 秒；杀毒软件扫描 `powershell.exe`、系统高负载时 PowerShell 也可能超过 10 秒。
- 实证：本轮 npm test 的 #107（`无法读取当前 Windows 登录账户。`）与 #123（`spawnSync … ETIMEDOUT`）正是在并行负载下从这两条生产路径失败。日常双击 `启动本地门户.cmd` 走同一链路，存在相同的偶发失败模式。
- 建议：对两个探测增加 1–2 次重试（或放宽超时并在错误信息中说明"机器繁忙请重试"）；`localSopUserHeader` 失败时可回退 `os.userInfo()` 拼域名的弱保证并告警，而不是硬失败。

#### M3. SOP 本地代理 30 秒不活动超时可能切断长耗时的 Excel 导入/导出

- 位置：`scripts/dev-server.mjs:66`（`upstream.setTimeout(30000, …)`）
- 问题：SOP 桥接代理对上游设置 30 秒超时；该超时是**不活动超时**。SOP 处理大 Excel 导入/导出时可能长时间无 socket 数据流动，连接会被中途销毁。同仓库通用代理 `scripts/proxy-request.mjs:20` 用的是 120 秒，两者不一致。
- 影响：仅影响本地开发/预览（`npm run dev`、preview.cmd 直连模式）；Docker 正式链路不走此分支。
- 建议：与通用代理统一为 120 秒，或确认 SOP 业务侧有流式响应后再收敛。

#### M4. 测试门禁红 + Python/PowerShell 测试无统一入口

- 位置：`package.json:13`（`"test": "node --test tests/*.test.mjs"`）、`tests/test_*.py`（5 个）、`deploy/tests/Test-*.ps1`（6 个）
- 问题：(a) `npm test` 当前 10 失败 1 取消（见上表），失败集合在两轮间漂移，无法作为可靠门禁；(b) Python 测试（`test_app_navigation.py` 等 5 个）与 `deploy/tests/` 的 PowerShell 验证脚本不在任何 npm script 中，AGENTS.md/MASTER.md 又只要求"运行 npm run check 与 npm test"——按文档执行会漏跑两套测试。
- 建议：① 修复/隔离负载敏感用例（降低文件级并行度 `--test-concurrency`，或对孵化型用例放宽超时/加重试）；② 增加 `test:py` / `test:deploy` script，并在文档中列明完整验证命令组合。

### 低危（10 项）

#### L1. 旧 IIS 部署的孤儿配置文件仍留在 deploy/ 下

- 位置：`deploy/config.local.json`（SiteName "DataPlatform"、Port 8080、RequireReverseProxy）
- 问题：全仓库无任何脚本引用它；AGENTS.md 明确 2026-11-13 起"不再维护旧 IIS/计划任务/WinRM 部署流程"。文件虽被 .gitignore 忽略，但留在目录里会误导后来者以为 IIS 配置仍被消费。
- 建议：删除，或在文件头加一行注释标记其已废弃。

#### L2. 本机 publish 配置含脚本不消费的遗留字段

- 位置：`config.local/publish.json`（`inbox`、`remote` 对象）
- 问题：`deploy/publish.example.json` 与 `Publish-App.ps1` 均无这两个字段，属于旧发布流程遗留。
- 建议：清理。

#### L3. 平台版本号双源维护

- 位置：`package.json:3` 与 `portal/config/apps.json:6`（均 0.2.2，当前一致）
- 问题：无任何校验保证两者同步，发版漏改一处会出现版本漂移；且应用级 `version: null` 字段无代码消费。
- 建议：发布流程由单一来源生成（如打包时从 package.json 注入），或在 check.mjs 中加一致性断言。

#### L4. 应用注册表中存在无消费字段与数据不完整项

- 位置：`portal/config/apps.json`
- 问题：应用级 `subtitle`/`description`/`dataUpdatedAt`/`version` 当前无任何代码读取；`vehicle-config` 缺 `subtitle`/`description`，`leads` 的 `description` 为空。字段"看起来会展示"但实际不展示，容易让维护者误以为改这里能改界面。
- 建议：删除无用字段，或在文档中注明哪些字段当前被消费。

#### L5. CSS 存在两个被覆盖的死规则

- 位置：`portal/css/portal.css:65`（`.home-heading h1{font-size:28px…}`）、`:127`（`.empty-state h1{font-size:24px…}`）被末尾 Workbench typography 段（:181-182）统一覆盖为 19px。
- 建议：删除早声明，避免误读当前字号来源。

#### L6. 侧栏导航项的 title 与 aria-label 不一致

- 位置：`portal/js/portal.js:83-85`
- 问题：非 ready 应用 `aria-label` 为"名称 · 待接入"，而 `title` 仅 `app.name`——悬停提示与读屏标签不一致。
- 建议：title 同步使用 aria-label 文案。

#### L7. 静态应用目录重定向的 Location 未编码

- 位置：`scripts/dev-server.mjs:78`（对比 :93 已用 `encodeURI`）
- 问题：静态挂载子目录 308 重定向直接拼接解码后的 pathname；含空格或非 ASCII 字符的子路径会生成带空格/非 ASCII 的 Location 头，浏览器行为不一致。
- 建议：与 L93 统一使用 `encodeURI`。

#### L8. 本机预览网关默认监听 0.0.0.0

- 位置：`scripts/local-preview-gateway.mjs:69`（`startLocalPreviewPortal(… {host='0.0.0.0'})`）
- 问题：当前两个调用方分别显式传 `127.0.0.1`（native preview）和依赖默认值（容器内，语义正确）；默认值偏外露，未来新增调用方若漏传会把本机预览暴露到局域网。
- 建议：默认改为 `127.0.0.1`，容器路径显式传 `0.0.0.0`。

#### L9. build-docker.ps1 的 `docker image inspect … 2>$null` 在 PS5.1 + EAP=Stop 下会误判

- 位置：`deploy/docker/build-docker.ps1`（`$existing=& docker image inspect $image.tag 2>$null; $hasImage=$LASTEXITCODE -eq 0`，包在 try/catch 中）
- 问题：PowerShell 5.1 中原生命令 stderr 重定向在 EAP=Stop 下会抛 NativeCommandError 进入 catch，把"镜像存在"误判为"不存在"进而重复构建；docker 输出 stderr 警告时触发。因镜像 tag 内含指纹且构建后校验 label，**不会造成内容错配**，仅产生重复构建与误导日志。
- 建议：改用 `2>&1` 显式收集或 `-ErrorAction Ignore` 的包装写法。

#### L10. 健康探测无响应大小上限

- 位置：`scripts/health-check.mjs:7-14`
- 问题：`response.json()` / `response.text()` 无大小限制（`container-runtime.mjs:68` 的 checkService 有 64KB 上限，两处不一致）。目标均为本机回环服务，风险低。
- 建议：统一加同样的上限。

### 信息（3 项）

#### I1. 安全设计正面确认（审计过、可放心保持）

- 静态服务路径防穿越链完整：`scripts/dev-server.mjs:18-28` 在 WHATWG URL 归一化之前校验原始串，拒绝编码分隔符、反斜杠、冒号、`//`、点段、前导点、私有目录名（deploy/data/logs/scripts/tests/node_modules/web.config），首尾句点，再叠加 realpath 后的 `inside()` 双重校验（:82-88）。
- 代理只允许固定 HTTP 回环 target，禁止凭据/路径/查询（`scripts/app-integrations.mjs:98-99`）；`{port}` 只能来自 `integration/ports.json` 唯一登记。
- 请求头剥离防注入：`scripts/proxy-request.mjs:13`、`dev-server.mjs:57`、`local-preview-gateway.mjs:21` 均剥 `x-sop-*/x-config-*/x-planhub-*/x-forwarded-*/forwarded`。
- 门户控制面安全：停止端点要求 Host 白名单 + Origin 校验 + 32 字节令牌 timingSafeEqual + 回环来源 + 工作区哈希匹配（`scripts/portal-instance.mjs:60-108`）；`stopPortal` 明确拒绝按端口强杀未知进程。
- 交付链不可变：`release-validation.mjs` / `delivery-validation.mjs` 逐文件 SHA256 校验 + 文件集合一致性 + 拒绝符号链接/junction；Docker 镜像指纹与构建记录互验（`deploy/docker/deploy.ps1:108-118`）；Compose 项目归属 runtime 标签校验（:85-89）。
- 密钥管理：三个外部密钥仅生成到包外 `planhub-runtime/config.json`，不进镜像不进仓库；快照模式下每次随机重生成（`preview.ps1:231`）。
- 新旧服务互斥：`deployment.lock` / `preview.lock` / `native-direct.json` / `deployment-active.json` 标记链完整，本机与 Docker 双向拒绝（`preview.ps1:120-122,199-209`、`deploy.ps1:29-33`）。
- 新增业务数据防呆：日常持久数据禁止指向 runtime 临时目录（`dev-sop.mjs:105-110`）；`--snapshot --demo` 不允许接触真实数据（:52）。

#### I2. 约定符合性正面确认

- Demo 约定：演示状态全部在页面内存（`workbench.js:11` 注释与实现一致），内容集中在 `workbench-demo.js`，页面有 DEMO 徽标与刷新重置说明；未发现编造业务指标、假图表或虚假账号状态。
- iframe/嵌入约定：页面未设置 X-Frame-Options / frame-ancestors，CSP（`index.html:7`）完整且允许同源嵌入；`portal.js:169` 主动探测子应用 DENY 头并给出明确错误。
- XSS 面：门户渲染全部使用 `textContent`/`replaceChildren`，SVG 图标来自固定路径表；`localPath()` 校验应用地址必须为同源子路径并拒绝点段。
- pending/maintenance 状态不伪装 ready（`config.js:24` 强制三态枚举，导航与首页入口按状态展示）。

#### I3. 文档一致性正面确认

- `README.md`、`docs/deployment.md`、`docs/child-app-developer-guide.md` 中抽查的锚点（`#以后更新`、`#第三步-在-b-放好数据并试运行`、`#integration-boundary` 等）全部有效；`deploy.ps1 -Action Logs`、菜单 0/8 语义、4173 固定入口、`planhub-runtime/` 结构描述与实现一致。
- `design-system/planning-portal/MASTER.md` 的侧栏宽度（56/48/145px）、颜色令牌、字号（19/16/14/12px）、字体栈与 `portal.css` 实现一致。
- 端口唯一登记：`integration/ports.json` 六应用 + 门户端口无重复；`integration/apps.json` 全部使用 `{port}` 占位；`deploy/docker/bindings.json` 不含端口（由打包生成）——"配置只维护一个来源"落实到位。

#### I4. 本机运行残留（随 L 一并留意）

`runtime/` 下现有 6 个 `sop-runtime-*` 临时目录与 1 个陈旧的 `portal-instances/4173-*.json` 记录（共 11KB）。`unregisterPortal` 仅在正常 close 时清理，进程被杀/崩溃后永久残留；陈旧记录会让 `stopPortal` 报"缺少当前门户的本机实例记录"需要人工确认。影响小但会累积，建议在启动或 diagnose 流程中顺带清理无主记录。

---

## 三、建议的处理顺序

1. **先修门禁（M4 + M2）**：给两个单次探测加重试/放宽超时，再处理测试并行度与超时参数，让 `npm test` 稳定转绿；补 `test:py`/`test:deploy` 入口。
2. **补账号来源校验（M1）**：parentOrigin 未知时不接受消息，改动小、收益明确。
3. **统一 SOP 代理超时（M3）与 Location 编码（L7）**。
4. **清理遗留（L1/L2/L4/L5）**：删除孤儿 IIS 配置、遗留字段、死 CSS 规则。
5. **剩余小项（L3/L6/L8/L9/L10、I4）** 按顺手程度处理。

## 四、审计覆盖说明

- 已逐行审读：`portal/` 全部 7 个源文件 + CSS + index.html + 配置；`scripts/` 全部 30 个 .mjs；`deploy/` 全部 12 个 ps1 + 7 个 cmd/bat + json；`integration/` 全部；`docs/` 两篇；`design-system/MASTER.md`；Python 工具抽查（迁移/打包/兼容性检查）。
- 实测：`npm run check` 通过；`npm test` 两轮完整运行（共约 16 分钟）。
- 未覆盖：Docker 实际构建与容器内运行（需 B 机环境）；子应用源码（超出本项目边界）；浏览器端手工视觉验收（本次为静态审计，未起本地门户做交互验证）。
