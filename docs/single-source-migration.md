# 单一 SOP 源码调整记录

> 当前边界：用户确认保留既有改动，今后门户只做集成，不修改任何子应用源码、UI 或业务行为。下文原项目适配内容描述已有实现或历史记录，不构成继续修改原项目的授权；详见[集成边界](integration-boundary.md)。

本记录中的文件系统路径以门户根目录为基准；只调整路径表示，不更改原备份或 Git 历史。

## 核对基线与实际路径

- 原项目：`../计划看板`，合并前 HEAD `eec3b69`，工作树干净。
- 门户：`.`，开始时 HEAD `885437f`，工作树干净。
- 原仓库 90 个受控文件；副本有 13 个修改、7 个新增，原业务源码没有缺失（仅未复制 AGENTS.md）。76 个文件逐字节相同。
- 旧的公开化示例目录 是公开化时替换的文档示例，不是实际源；此次核对没有应用旧补丁。
- 核心 store/grid/export/workbook/xlsx 代码与原业务测试一致，未发现需要用户裁决的业务冲突。

## 恢复备份

备份位置：`artifacts/single-source-backup-20261102-180733`。包含两仓库修改前源码 tar、完整 Git bundle 及 SHA256 清单。验证后移出的门户副本、历史补丁和身份模块源文件也保存在同一恢复目录，不删除业务数据或 Git 历史。

详细只读比对及合并清单分别保存在忽略的 `artifacts/single-source-audit.json`、`artifacts/sop-merge-applied.json`。恢复时先将 tar 或 bundle 导出到新目录核对，避免直接覆盖正在使用的项目。

## 合并与归属

原 SOP 接收 gateway/server、数据路径、可信导入操作人、前端前缀/只读/身份、图标和对应测试，保留独立模式。SOP 专属 IIS 身份模块源码归原项目 `integration/iis`；发布构建器和测试也在原仓库。

门户启动参数区分 `sourceRoot` 和 `dataRoot`；数据快照不决定源码来源。原项目未适配时明确报错，不回退副本。图标导出器只导出门户资产，不会重新创建 SOP 副本。

门户打包必须显式提供原项目构建的 SOP 发布产物，校验 manifest、路径、文件集合和哈希。部署运行目录可以叫 `services/sop`，但它不是门户仓库的业务源码。

## 验证结果

- 原 SOP 正常引擎环境：278 项 Python 回归通过，涵盖业务、根路径/子路径 HTTP、真实 Excel 导入导出、冲突与审计、只读、Origin/代理身份以及外置数据路径。排除了会创建可见窗口的 Windows 控制台生命周期模块。
- 发布构建测试：5 项通过，包含新增真实中文路径 Git 仓库的 clean/dirty、源提交及禁止父仓库误归属用例。
- 原项目 9 个前端测试文件通过；门户配置/代理/单源启动等 17 项 Node 测试通过。
- 原 SOP 独立 CLI 用隔离数据实跑：本机根页面、`/api/health`、`/api/session`、`/api/state` 正常，独立模式仍保留原本机访问边界。
- 门户从实际原项目启动 SOP，页面、API 与只读状态正常，无控制台错误；归档副本后刷新仍成功。截图：`artifacts/single-source-sop-verified.jpg`。
- 真正 PowerShell 5.1：原项目构建、发布清单验证、门户打包、身份模块编译、依赖检查 WhatIf 与任务只读计划通过；篡改哈希、额外文件/目录、路径越界、重复路径和缺少显式产物均拒绝。
- 最终 SOP 发布物：`staging/sop-release-b3ec562`，39 个文件，`sourceCommit=b3ec562d244320b7e185a002d1099815e5ab5967`、`sourceDirty=false`；门户产物为 `staging/DataPlatform-single-source-b3ec562`，保持同一来源清单。

最终构建额外发现 Git for Windows 的中文路径 UTF-8 输出被默认代码页误解码，已仅在发布溯源中修复，并新增实际中文路径仓库回归；先前缺少溯源的中间产物没有作为最终交付。

原 SOP 仅新增本地提交 `ab257db`（合入适配）、`b3ec562`（中文路径溯源修复），没有推送或改写历史。门户也只做本地记录。

## 修改文件范围

原 SOP 共 24 个文件：`server.py`、`sop_gateway.py`、`sop_data.py`、`sop_paths.py`、`sop_refresh.py`、`sop_roundtrip.py`、`sop_source_rules.py`；`web/app.js`、`web/index.html`、`web/styles.css` 及五份图标；`integration/iis/SopIdentityBridge.cs`；`requirements-intranet.txt`；`scripts/build_release.py`；四份新增接入/发布测试；`README.md`、`PORTAL-INTEGRATION.md`。具体差异可在原仓库查看 `eec3b69..b3ec562`。

门户改动为预览/启动、图标导出职责、显式发布物打包与清单校验、通用部署脚本及测试、真实路径配置模板和相关文档。移出维护范围的 `services/sop`、`deploy/sop-upstream.patch`、`deploy/SopIdentityBridge.cs` 已放入上述恢复目录，未删除。

## 仍需人工完成

1. 审核两个仓库的本地提交后，再按自己的流程决定是否推送；本轮未执行任何推送。
2. 如已有旧本地预览进程，退出后用新 `npm start` 重启；源位置不同时编辑 `config.local/sop.json` 或传 `--sop-source`。
3. 目标内网的域名、HTTPS、服务账号、部门访问边界、IIS/ARR、ACL 和可信身份留痕必须由管理员配置并验收。本轮不部署或修改这些设置。
4. Windows 可见控制台的关闭行为未在本轮自动化中运行；原启动器代码未变，可人工检查。独立 CLI 和 HTTP 已用隔离进程验证。

首次宽范围测试误全局强制 Python 引擎，导致一个 Node mock 用例走错分支；清除后该用例通过。另一次 artifact 原生回算进程出现 Windows fast-fail（0xC0000409），定点隔离验收通过；保留证据 `artifacts/single-source-node-validation.json`，不把该现象宣称为已由业务代码修复。
