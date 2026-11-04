const ID = /^[a-z][a-z0-9-]*$/;
export function localPath(value) {
  // Only explicit root-relative application paths; reject encoded separators and traversal.
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*\/$/.test(value) || value.includes('//') || value.split('/').some(s => s === '.' || s === '..')) {
    throw new Error('应用地址必须为同源子路径，如 /orderiq/');
  }
  return value;
}
export function validateConfig(raw) {
  if (!raw || !raw.platform || typeof raw.platform.name !== 'string' || !raw.platform.name.trim() || !Array.isArray(raw.groups)) throw new Error('缺少平台信息或应用分组');
  const platform = { ...raw.platform };
  platform.loadTimeoutMs ??= 20000;
  if (!Number.isInteger(platform.loadTimeoutMs) || platform.loadTimeoutMs < 1000 || platform.loadTimeoutMs > 120000) throw new Error('加载超时必须为 1000–120000 毫秒');
  if (platform.identityEndpoint != null && !/^\/api\/[a-zA-Z0-9/_-]+$/.test(platform.identityEndpoint)) throw new Error('用户信息接口必须为同源 /api/ 路径');
  const ids = new Set(['home']);
  const groupIds = new Set();
  const groups = raw.groups.map(group => {
    if (typeof group.id !== 'string' || !ID.test(group.id) || group.id === 'all' || groupIds.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || !Array.isArray(group.apps)) throw new Error('应用分组无效或重复');
    groupIds.add(group.id);
    return { ...group, apps: group.apps.map(app => {
      if (typeof app.id !== 'string' || !ID.test(app.id) || ids.has(app.id)) throw new Error('应用 ID 无效或重复');
      ids.add(app.id);
      if (app.order !== undefined && !Number.isFinite(app.order)) throw new Error(`应用 ${app.id} 的排序必须为数值`);
      if (typeof app.name !== 'string' || !app.name.trim() || typeof app.enabled !== 'boolean' || !['ready', 'pending', 'maintenance'].includes(app.status)) throw new Error(`应用 ${app.id} 的名称、启用状态或接入状态无效`);
      return { ...app, url: localPath(app.url), groupName: group.name };
    }) };
  });
  const apps = groups.flatMap(group => group.apps).filter(app => app.enabled);
  platform.defaultApp ??= 'home';
  if (platform.defaultApp !== 'home' && !apps.some(app => app.id === platform.defaultApp && app.status === 'ready')) throw new Error('默认应用必须已启用且接入完成');
  return { platform, groups, apps };
}
export function routeFromHash(hash, config) {
  const match = /^#\/app\/([a-z][a-z0-9-]*)$/.exec(hash);
  if (hash === '#/home') return 'home';
  if (match && config.apps.some(app => app.id === match[1])) return match[1];
  return hash ? 'home' : config.platform.defaultApp;
}

export function orderedApps(apps) {
  return [...apps].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
