# 本地看板打不开的排查

使用根目录 `启动本地门户.cmd` 或运行 `npm start`，它会同时启动门户、静态应用映射和 SOP 服务代理。打开终端实际打印的地址，保持该窗口运行。`npm run dev` 也使用相同入口。

旧版 `npm run dev` 只启动了静态门户；`/orderiq/` 可以正常响应，而 `/sop/` 返回 404。该静态模式现改为明确的 `npm run dev:static`。如果旧进程仍在 4173 上运行，新启动命令会报告端口占用；在旧终端按 Ctrl+C 后再启动。也可为新入口指定独立端口：

```powershell
npm start -- --port 4176 --backend-port 8879
```

将 `/orderiq/` 和 `/sop/` 分别接在当前门户域名和端口后直接访问。如果直达也返回 404，问题在应用发布、映射或启动方式；直达可看、门户不可看时，再检查嵌入策略、缓存及加载报错。

常见情况：

- “尚未找到应用页面”：应用请求为 404。SOP 优先检查是否误用了静态服务器；订单优先检查 `apps/orderiq/index.html` 是否已导入。
- 端口占用：退出旧窗口后重启，或明确换端口。
- 从 Git 新克隆：业务 HTML 和数据库不上传仓库，需要先导入订单发布文件，为 SOP 指定真实源项目。
- 缺少 Python/openpyxl：按 README 安装依赖；启动失败时终端保留具体错误。
- `file:///` 或普通 Live Server：缺少应用映射和动态代理，改用统一启动入口。
- 旧标题或旧错误：确认地址与终端一致，Ctrl+F5 刷新。

原项目目录不同于默认布局时：

```powershell
npm start -- --seed-from 'D:\Projects\SOP' --shared-config 'D:\Projects\OrderIQ\scripts\config\shared_config.py'
```

内网 IIS 使用部署说明中的独立 Application 和反向代理，不运行此开发启动器。
