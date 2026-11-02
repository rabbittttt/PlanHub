# 应用接入规范

## 公开应用注册表

编辑 `portal/config/apps.json` 后执行 `npm run check`。新增应用须先完成服务器映射，再设置 `status: "ready"`。

```json
{
  "id": "new-app",
  "name": "新应用",
  "subtitle": "New App",
  "description": "应用的业务用途",
  "url": "/new-app/",
  "icon": "chart",
  "enabled": true,
  "status": "pending",
  "version": null,
  "dataUpdatedAt": null
}
```

- `id` 为不重复的小写字母/数字/连字符，以字母开头，`home` 保留给工作台。
- 分组 ID 同样必须是字符串且不重复，`all` 保留给“全部应用”筛选。
- `url` 必须是同源根相对子路径，含末尾 `/`；禁止外域地址、查询参数、编码路径及 `..`。门户部署在站点根目录。
- `enabled` 控制导航和工作台是否显示，不代表访问授权。
- `status` 为 `ready`、`pending`、`maintenance`。后两种状态显示说明而不会请求业务页面。
- `ready` 是管理员确认接入完成的标记，不是实时健康状态。打开应用时才探测状态。
- 图标支持 `chart`、`box`、`calendar`、`trend`、`users`、`grid`，其他值回退为通用图标。
- 可选 `version`、`dataUpdatedAt` 由业务负责人维护；时间建议使用带时区的 ISO 8601 格式。
- `platform.defaultApp` 为 `home` 或已启用且 ready 的应用 ID。支持 `/#/app/orderiq` 深链接，不需要 IIS SPA 回退。
- `platform.loadTimeoutMs` 范围 1000–120000，默认 20000 毫秒。

## 静态应用

应用以独立 IIS Application 托管于 `/应用名/`，与门户同协议、同域名、同端口；文件放在 portal 之外。应用内部使用相对资源路径或应用前缀，避免 `/css/`、`/api/` 抢占根路径。Vue 等 SPA 需同时设置构建 base、路由 base 和应用自己的 IIS 回退；门户不提供通用回退，缺失路径必须保留 404。

OrderIQ 是资源内联的单 HTML，可复制为 `apps/orderiq/index.html`。旧地址的 localStorage 草稿不会随新地址自动迁移，切换前需由业务负责人确认旧草稿处理方式。

## 动态应用

每个服务使用独立回环端口并由受控 Windows 服务运行。`/leads/` 等路径通过 ARR 转发，前缀处理必须和应用约定一致。当前规则样例剥离前缀，因此应用生成静态 URL、重定向地址和 Cookie Path 时仍需知道外部前缀。

不要在平台根目录统一转发 `/api/` 给某个业务应用；应用 API 应位于各自命名空间，例如 `/sop/api/`。服务接口权限仍由业务端执行。Windows Authentication 不会自动把 NTLM 身份转换为可信 Python 用户；未来传递身份时必须由可信 IIS 层覆盖客户端伪造的身份头，并限制后端只能从受控代理访问。

Streamlit 等使用 WebSocket 的应用还需安装/启用 IIS WebSocket 并专项验证，不能仅凭首页 HTTP 200 即认定接入完成。

现有 SOP 已提供专用适配方案，见 [SOP 内网部署](sop-intranet.md)。SOP 代理保留 `/sop/` 前缀，并由后端剥离；与通用 leads 示例的剥离策略不同。SOP 使用认证后 IIS 模块注入身份，不能用 BeginRequest 阶段的 URL Rewrite `{LOGON_USER}` 直接替代该模块。

## iframe 兼容性和加载反馈

受信任的内部业务应用应允许同源嵌入，可设置 `X-Frame-Options: SAMEORIGIN` 和 `Content-Security-Policy: frame-ancestors 'self'`，不能设置 DENY 或 `'none'`。门户自身严格 CSP 放在 HTML meta 中，不约束子应用的内联脚本。各应用需要自行维护 CSP；根站点的其他继承配置也需检查。

门户先发 HEAD 请求探测 HTTP 错误与明确禁止嵌入的响应头，避免把大型 OrderIQ 下载两遍。不支持 HEAD（405/501）的应用仍会尝试 iframe GET。iframe 的 load 只代表文档载入，不能证明业务接口或数据全部正常。浏览器无法可靠公开 iframe 内全部网络错误；通用提示、超时和人工验收仍不可省略。

业务应用与门户同源，彼此属于同一个信任边界；不要接入不可信第三方 HTML。门户没有添加会破坏既有下载、打印和本地存储功能的 sandbox 限制。

## 当前用户

静态 JavaScript 无法直接读取 IIS 的 Windows 用户。若需要显示姓名，服务端提供受 Windows 认证保护的同源接口，例如 `/api/me`，仅返回：

```json
{"displayName":"真实登录用户的显示名"}
```

然后将 `platform.identityEndpoint` 设置为该路径。响应应禁止公共缓存。返回值必须来自服务端已验证身份，不得相信查询参数、localStorage 或客户端自报的用户名。当前接口未实现，配置为 null 不影响 IIS 的访问认证。

## 接入验收

1. 直接访问应用 URL、刷新子路由、资源加载、API GET/POST 均通过。
2. 从门户打开、浏览器后退/前进、切换应用、重新加载正常。
3. 已登录/未登录/无权限用户分别验证，直接输入应用 URL 不能绕过权限。
4. 下载、导入、打印、浏览器存储与 Cookie Path 按业务验收。
5. 检查 404/500/502、服务停止、超时、禁止 iframe 时的反馈。
6. 动态服务重启后恢复，日志与业务数据均在非公共目录。
