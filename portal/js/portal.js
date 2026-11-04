import { validateConfig, routeFromHash, orderedApps } from './config.js';

const $ = id => document.getElementById(id);
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chart: '<path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-6"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v10l9 4 9-4V8M12 13v9M7.5 5.5l9 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2"/>',
  trend: '<path d="M3 17 9 11l4 4 8-10M15 5h6v6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>'
};
function icon(name) {
  const host = document.createElement('span');
  host.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
  return host.firstElementChild;
}
document.querySelectorAll('[data-icon]').forEach(el => el.replaceChildren(icon(el.dataset.icon)));
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  $('main').focus();
});
const labels = { ready: '可用', pending: '待接入', maintenance: '维护中' };
let config, current = 'home', filter = 'all', sequence = 0, controller, timer, frame;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setNavigationOpen(open) {
  $('primary-navigation').classList.toggle('open', open);
  $('nav-toggle').setAttribute('aria-expanded', String(open));
  $('nav-toggle').setAttribute('aria-label', open ? '收起应用导航' : '展开应用导航');
}
$('nav-toggle').addEventListener('click', () => setNavigationOpen($('nav-toggle').getAttribute('aria-expanded') !== 'true'));
$('primary-navigation').addEventListener('click', e => {
  if (!e.target.closest('a')) return;
  const wasOpen = $('nav-toggle').getAttribute('aria-expanded') === 'true';
  setNavigationOpen(false);
  if (wasOpen && $('nav-toggle').getClientRects().length) $('nav-toggle').focus();
});
document.addEventListener('click', e => {
  if (!$('primary-navigation').contains(e.target) && !$('nav-toggle').contains(e.target)) setNavigationOpen(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('nav-toggle').getAttribute('aria-expanded') === 'true') {
    const restoreFocus = $('primary-navigation').contains(document.activeElement);
    setNavigationOpen(false);
    if (restoreFocus && $('nav-toggle').getClientRects().length) $('nav-toggle').focus();
    return;
  }
  if (e.key === '/' && current === 'home' && !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) && !e.target.isContentEditable) {
    e.preventDefault(); $('app-search').focus();
  }
});

function prioritizedApps(apps) {
  return orderedApps(apps);
}
function renderNavigation() {
  $('app-nav').replaceChildren();
  for (const app of prioritizedApps(config.apps)) {
    const link = element('a', 'nav-item');
    link.href = `#/app/${app.id}`;
    link.dataset.app = app.id;
    link.append(icon(app.icon), element('span', '', app.name));
    if (app.status !== 'ready') link.append(element('span', 'nav-pending', labels[app.status]));
    $('app-nav').append(link);
  }
  const groups = [{ id: 'all', name: '全部应用', apps: config.apps }, ...config.groups];
  $('group-filters').replaceChildren();
  for (const group of groups) {
    const count = group.apps.filter(app => app.enabled).length;
    if (!count && group.id !== 'all') continue;
    const button = element('button', 'filter', group.name);
    button.append(element('span', '', count));
    button.dataset.group = group.id;
    button.setAttribute('aria-pressed', String(filter === group.id));
    button.addEventListener('click', () => { filter = group.id; renderCards(); });
    $('group-filters').append(button);
  }
}
function renderCards() {
  const query = $('app-search').value.trim().toLocaleLowerCase();
  const group = config.groups.find(g => g.id === filter);
  const apps = prioritizedApps((group ? group.apps.filter(a => a.enabled) : config.apps).filter(app =>
    [app.name, app.description, app.subtitle, app.groupName, group?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
  const ready = apps.filter(app => app.status === 'ready');
  const pending = apps.filter(app => app.status !== 'ready');
  $('app-grid').replaceChildren();
  $('pending-grid').replaceChildren();
  document.querySelectorAll('[data-group]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.group === filter)));
  for (const app of apps) {
    const card = element('article', `app-card app-card-${app.status === 'ready' ? 'ready' : 'pending'}`);
    card.dataset.app = app.id;
    const badge = element('span', `status-badge ${app.status}`);
    badge.append(element('span', 'status-dot'), document.createTextNode(labels[app.status]));
    if (app.status === 'ready') {
      const top = element('div', 'card-top');
      const iconBox = element('span', `app-icon ${Object.hasOwn(paths, app.icon) ? app.icon : 'grid'}`);
      iconBox.append(icon(app.icon));
      top.append(iconBox, badge);
      const bottom = element('div', 'card-bottom');
      bottom.append(element('span', 'card-group', app.groupName || group?.name));
      const link = element('a', 'card-link', app.id === 'sop' ? '打开计划看板' : '进入应用');
      link.href = `#/app/${app.id}`;
      link.setAttribute('aria-label', `进入${app.name}`);
      link.append(icon('arrow'));
      bottom.append(link);
      card.append(top, element('h3', '', app.name), element('p', 'card-subtitle', app.subtitle || ''), element('p', 'card-description', app.description || ''), bottom);
      $('app-grid').append(card);
    } else {
      const iconBox = element('span', 'pending-icon');
      iconBox.append(icon(app.icon));
      const copy = element('div', 'pending-copy');
      copy.append(element('h3', '', app.name), element('p', 'card-description', app.description || ''));
      card.append(iconBox, copy, badge);
      $('pending-grid').append(card);
    }
  }
  $('ready-section').hidden = ready.length === 0;
  $('pending-section').hidden = pending.length === 0;
  const counts = [`${ready.length} 个可用`];
  for (const status of ['pending', 'maintenance']) {
    const count = apps.filter(app => app.status === status).length;
    if (count) counts.push(`${count} 个${labels[status]}`);
  }
  $('apps-summary').textContent = counts.join(' · ');
  $('no-results').hidden = apps.length > 0;
}
function stopLoading() {
  sequence++;
  controller?.abort();
  clearTimeout(timer);
  frame?.remove();
  frame = null;
}
function overlay(title, detail, loading = false) {
  $('frame-overlay').hidden = false;
  $('frame-spinner').hidden = !loading;
  $('retry-app').hidden = loading || config.apps.find(app => app.id === current)?.status !== 'ready';
  $('frame-message').textContent = title;
  $('frame-detail').textContent = detail;
}
async function openApp(app) {
  stopLoading();
  const ownSequence = sequence;
  $('app-title').textContent = app.name;
  $('retry-app').hidden = app.status !== 'ready';
  if (app.status !== 'ready') {
    overlay(app.status === 'maintenance' ? '应用正在维护' : '应用尚未接入', app.status === 'maintenance' ? '请稍后重试，或先返回工作台使用其他应用。' : '该应用接入完成后将在这里开放，请先使用工作台中已接入的应用。');
    return;
  }
  overlay('正在打开' + app.name, '正在连接业务应用，请稍候…', true);
  controller = new AbortController();
  const signal = controller.signal;
  timer = setTimeout(() => {
    if (ownSequence !== sequence) return;
    controller.abort();
    frame?.remove(); frame = null;
    sequence++;
    overlay('应用加载超时', '服务暂未响应。请点击“重新加载”重试，或联系应用负责人检查服务。');
  }, config.platform.loadTimeoutMs);
  try {
    // HEAD avoids downloading a large report twice, while exposing HTTP failures before embedding.
    const response = await fetch(app.url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal });
    if (ownSequence !== sequence) return;
    if (!response.ok && response.status !== 405 && response.status !== 501) {
      const description = { 401: '当前登录未通过验证，请检查 Windows 登录或联系管理员。', 403: '当前账号没有访问权限，请联系管理员。', 404: '尚未找到应用页面，请联系负责人完成发布。', 502: '业务服务暂不可用，请联系应用负责人。', 503: '业务服务正在维护，请稍后重试。' };
      throw new Error(description[response.status] || `服务返回 HTTP ${response.status}，请稍后重试。`);
    }
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== location.origin || !finalUrl.pathname.startsWith(app.url)) throw new Error('应用跳转到了约定路径之外，请联系负责人检查认证或路由配置。');
    if (/\bDENY\b/i.test(response.headers.get('x-frame-options') || '') || /frame-ancestors\s+'none'/i.test(response.headers.get('content-security-policy') || '')) throw new Error('该应用禁止嵌入工作区，请联系负责人调整同源嵌入配置。');
    frame = element('iframe');
    frame.id = 'app-frame';
    frame.title = `${app.name}工作区`;
    frame.referrerPolicy = 'same-origin';
    frame.addEventListener('load', () => {
      if (ownSequence !== sequence) return;
      try {
        const doc = frame.contentDocument;
        const url = new URL(frame.contentWindow.location.href);
        if (!doc || url.origin !== location.origin || !url.pathname.startsWith(app.url) || !doc.body) throw new Error('未能显示应用页面，请检查同源嵌入策略与应用路由。');
        clearTimeout(timer);
        $('frame-overlay').hidden = true;
      } catch {
        clearTimeout(timer);
        overlay('应用未能显示', '请联系应用负责人检查页面错误、同源地址和 iframe 嵌入设置，再重新加载。');
      }
    });
    frame.addEventListener('error', () => {
      if (ownSequence !== sequence) return;
      clearTimeout(timer);
      overlay('应用连接失败', '请检查网络后重新加载，或联系应用负责人。');
    });
    frame.src = app.url;
    $('frame-container').append(frame);
  } catch (error) {
    if (ownSequence !== sequence || signal.aborted) return;
    clearTimeout(timer);
    overlay('暂时无法打开应用', error instanceof TypeError ? '无法连接业务应用，请检查网络或联系应用负责人。' : error.message);
  }
}
function navigate() {
  if (!config) return;
  current = routeFromHash(location.hash, config);
  const canonical = current === 'home' ? '#/home' : `#/app/${current}`;
  if (location.hash !== canonical) history.replaceState(null, '', canonical);
  const app = config.apps.find(app => app.id === current);
  $('home-view').hidden = current !== 'home';
  $('app-view').hidden = current === 'home';
  $('current-location').textContent = app?.name || '工作台';
  document.title = `${app?.name || '工作台'} · ${config.platform.name}`;
  document.querySelectorAll('.nav-item').forEach(link => {
    const active = (link.dataset.app || 'home') === current;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  setNavigationOpen(false);
  if (app) openApp(app); else stopLoading();
}
async function loadIdentity() {
  if (!config.platform.identityEndpoint) return;
  try {
    const response = await fetch(config.platform.identityEndpoint, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const user = await response.json();
    if (typeof user.displayName !== 'string' || !user.displayName.trim()) throw new Error();
    $('identity-name').textContent = user.displayName;
    $('identity-detail').textContent = '企业用户';
  } catch { $('identity-detail').textContent = '用户信息暂不可用'; }
}
async function boot() {
  try {
    const response = await fetch('./config/apps.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`配置请求失败（HTTP ${response.status}）`);
    config = validateConfig(await response.json());
    $('brand-organization').textContent = config.platform.organization || '智选车';
    $('brand-name').textContent = config.platform.shortName || config.platform.name || '计划管理平台';
    $('today').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' }).format(new Date());
    renderNavigation(); renderCards();
    $('boot-state').hidden = true;
    navigate(); loadIdentity();
  } catch (error) {
    const title = element('h1', '', '工作空间暂时无法加载');
    const hint = element('p', '', location.protocol === 'file:' ? '请通过本地预览服务或 IIS 地址打开门户，不要直接双击 HTML 文件。' : `请检查应用配置后重试。${error.message}`);
    const retry = element('button', 'secondary-button', '重新加载');
    retry.addEventListener('click', () => location.reload());
    $('boot-state').replaceChildren(title, hint, retry);
  }
}
$('app-search').addEventListener('input', renderCards);
$('retry-app').addEventListener('click', () => { const app = config.apps.find(a => a.id === current); if (app) openApp(app); });
window.addEventListener('hashchange', navigate);
boot();
