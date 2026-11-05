import { orderedApps } from './config.js';
import { workbenchDemo as demo } from './workbench-demo.js?v=cycle-demo-20261105';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// All demo state lives in this page only. No storage, child DOM access or API writes.
export function mountWorkbench(root, apps) {
  const find = id => root.querySelector('#' + id);
  const registeredApps = orderedApps(apps.filter(app => app.enabled));
  const stageButtons = new Map(), taskRows = new Map(), checks = new Map(), windowButtons = new Map(), recordButtons = new Map();
  let stageId, windowId, completed, recordId;
  const appLabels = { ready: '已接入', pending: '待接入', maintenance: '维护中' };

  function appAction(appId, label, className = 'cycle-action') {
    const app = registeredApps.find(item => item.id === appId);
    if (!app || app.status !== 'ready') {
      const unavailable = node('span', 'cycle-app-unavailable', app ? appLabels[app.status] : '待接入');
      unavailable.setAttribute('aria-label', (app?.name || label) + '：' + unavailable.textContent);
      return unavailable;
    }
    const link = node('a', className, label);
    link.href = '#/app/' + app.id;
    link.setAttribute('aria-label', '打开' + app.name);
    return link;
  }

  function update() {
    for (const [id, button] of stageButtons) {
      const active = id === stageId;
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.cycle-stage-state').textContent = active ? '当前演示' : '查看阶段';
    }
    for (const [id, row] of taskRows) {
      const task = demo.tasks.find(item => item.id === id);
      row.classList.toggle('is-current', task.stageId === stageId);
      row.classList.toggle('is-complete', completed.has(id));
      checks.get(id).checked = completed.has(id);
    }
    find('cycle-focus').textContent = '当前：' + demo.stages.find(stage => stage.id === stageId).title;
    find('cycle-task-summary').textContent = '示例已完成 ' + completed.size + ' / ' + demo.tasks.length;
    for (const [id, button] of windowButtons) button.setAttribute('aria-pressed', String(id === windowId));
    for (const [id, button] of recordButtons) button.setAttribute('aria-pressed', String(id === recordId));
    const record = demo.records.find(item => item.id === recordId);
    const detail = find('cycle-record-detail');
    detail.hidden = !record;
    if (record) detail.replaceChildren(node('strong', '', record.title + ' · Demo'), node('p', '', record.description));
  }
  function showRecord(id) { recordId = id === recordId ? null : id; update(); }
  function reset() {
    stageId = demo.activeStageId;
    windowId = demo.activeWindowId;
    completed = new Set(demo.tasks.filter(task => task.done).map(task => task.id));
    recordId = null;
    update();
  }

  const stages = find('cycle-stages');
  stages.replaceChildren();
  demo.stages.forEach((stage, index) => {
    const item = node('li'), button = node('button', 'cycle-stage');
    button.type = 'button';
    button.setAttribute('aria-controls', 'cycle-tasks');
    const top = node('span', 'cycle-stage-top');
    top.append(node('span', 'cycle-stage-number', String(index + 1).padStart(2, '0')), node('span', 'cycle-stage-state'));
    button.append(top, node('strong', '', stage.title), node('span', 'cycle-stage-description', stage.description));
    button.addEventListener('click', () => { stageId = stage.id; update(); });
    stageButtons.set(stage.id, button);item.append(button);stages.append(item);
  });

  const tasks = find('cycle-tasks');
  tasks.replaceChildren();
  for (const task of demo.tasks) {
    const row = node('div', 'cycle-task-row');row.dataset.stage = task.stageId;
    const label = node('label', 'cycle-task-check'), check = node('input');
    check.type = 'checkbox';check.setAttribute('aria-describedby', 'cycle-demo-note');
    const copy = node('span');copy.append(node('strong', '', task.title), node('small', '', task.description));
    label.append(check, copy);
    check.addEventListener('change', () => { if (check.checked) completed.add(task.id); else completed.delete(task.id); update(); });
    const action = node('div', 'cycle-task-action');
    if (task.appId) action.append(appAction(task.appId, task.action + ' →'));
    else {
      const button = node('button', 'cycle-action', task.action);button.type = 'button';
      button.setAttribute('aria-controls', 'cycle-record-detail');
      button.addEventListener('click', () => showRecord(task.recordId));action.append(button);
    }
    row.append(label, action);tasks.append(row);taskRows.set(task.id, row);checks.set(task.id, check);
  }

  const windows = find('cycle-windows');
  windows.replaceChildren();
  for (const window of demo.windows) {
    const button = node('button', 'cycle-window');button.type = 'button';
    button.setAttribute('aria-describedby', 'cycle-demo-note');
    button.append(node('strong', '', window.name), node('span', '', window.description), node('small', '', window.offset));
    button.addEventListener('click', () => { windowId = window.id; update(); });
    windowButtons.set(window.id, button);windows.append(button);
  }
  const records = find('cycle-records');
  records.replaceChildren();
  for (const record of demo.records) {
    const button = node('button', 'cycle-action', record.title);button.type = 'button';
    button.setAttribute('aria-controls', 'cycle-record-detail');
    button.addEventListener('click', () => showRecord(record.id));
    recordButtons.set(record.id, button);records.append(button);
  }
  const appLinks = find('home-apps');
  appLinks.replaceChildren();
  for (const app of registeredApps) {
    const item = appAction(app.id, app.name, 'cycle-app-link');
    if (app.status !== 'ready') {
      item.className = 'cycle-app-unavailable';
      item.textContent = app.name + ' · ' + appLabels[app.status];
    }
    appLinks.append(item);
  }
  if (!registeredApps.length) appLinks.append(node('span', 'cycle-app-unavailable', '暂无已登记的应用'));
  find('cycle-reset').addEventListener('click', reset);
  reset();
}
