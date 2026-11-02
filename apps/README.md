# 独立应用发布目录

此目录仅供本地预览和打包。业务产物可能包含真实数据，`apps/*/` 已被 Git 忽略，不提交门户仓库，也不自动发布到外部托管。

现已从现有 OrderIQ 发布产物复制 `orderiq/index.html`，未修改原项目及生成文件。重新生成后运行 `scripts/Import-OrderIQ.ps1 -SourceHtml <发布文件绝对路径>` 更新此副本，再测试与打包。

生产通过独立 IIS Application 把 `/orderiq/` 映射到站点根目录之外的 `D:\DataPlatform\apps\orderiq`。SOP 是动态服务，不能复制 web 目录冒充完整应用。
