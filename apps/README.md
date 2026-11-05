# 独立应用发布目录

接入新应用前先阅读 [应用接入手册](../docs/child-app-developer-guide.md)；手册同时包含开发者规范、门户接入步骤和对应 AI 任务。本目录只放发布物，新增文件夹不会自动创建门户入口、本地 URL 映射或 IIS 应用。

此目录仅供本地预览和打包。业务产物可能包含真实数据，`apps/*/` 已被 Git 忽略，不提交门户仓库，也不自动发布到外部托管。

现已从现有 OrderIQ 发布产物复制 `orderiq/index.html`，未修改原项目及生成文件。重新生成后运行 `scripts/Import-OrderIQ.ps1 -SourceHtml <发布文件绝对路径>` 更新此副本，再测试与打包。

生产通过独立 IIS Application 把 `/orderiq/` 映射到发布根目录下的 `apps/orderiq`；IIS 网站根目录只指向同级 `portal/`。服务器要求的物理绝对路径由实际发布根解析生成，不绑定固定盘符。SOP 是动态服务，不能复制 web 目录冒充完整应用。
