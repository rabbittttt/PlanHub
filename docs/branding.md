# 计划部工作空间图标

图标以计划日历和推进路径表达排期、协同与执行。配色延续门户的蓝色体系，以白色主形体和青色强调层级，缩小后仍保留清晰轮廓。

应用位置：门户左上角标识、浏览器标签页、移动设备收藏图标，以及 SOP 独立看板。门户名称为“智选车计划部数据平台”，左侧标识使用“计划部 / PLANNING WORKSPACE”。

主资产为 `portal/assets/planning-icon.svg`；PNG、ICO 和移动收藏图标随源码提供，不需要用户浏览时生成。SOP 保留自己的本地资源路径，独立部署时也能显示相同图标。

修改图形时编辑 `scripts/export-planning-icon.py` 的几何定义，再执行 `python scripts/export-planning-icon.py --sync-sop`，同时生成两处使用的矢量与位图文件。Pillow 只在开发导出时使用，不是门户或 SOP 的运行依赖。

图标是带有旁侧文字的装饰性标识，页面内使用空 alt，避免读屏重复播报。浏览器 favicon 不包含小字号文字。
