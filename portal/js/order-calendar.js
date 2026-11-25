// The order dashboard owns both feeds. Dates are business dates, independent of the browser timezone.
const DAY = 86400000;
const dateKey = date => date.toISOString().slice(0, 10);
function today() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const value = name => parts.find(part => part.type === name).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function weekOf(monday) {
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { year, number };
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function createOrderCalendar(panel, orderApp) {
  const find = selector => panel.querySelector(selector);
  const body = find('tbody'), detail = find('.calendar-detail');
  const status = find('.calendar-status'), retry = find('.calendar-retry');
  let month = new Date(today().slice(0, 7) + '-01T00:00:00Z');
  let selected = null, manual = [], subjects = [], request;
  let pending = 0, errors = [];

  function render() {
    const days = new Map(), names = new Map(), seenStages = new Set();
    function add(entry, source) {
      if (!entry || typeof entry.text !== 'string' || !entry.text.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return;
      if (!days.has(entry.date)) days.set(entry.date, []);
      days.get(entry.date).push({ text: entry.text, source });
    }
    for (const subject of subjects) {
      if (!subject) continue;
      names.set(subject.id, subject.name);
      for (const entry of Array.isArray(subject.stage_annotations) ? subject.stage_annotations : []) {
        if (!entry) continue;
        const key = JSON.stringify([entry.date, entry.text]);
        if (seenStages.has(key)) continue;
        seenStages.add(key);
        add(entry, '阶段事件');
      }
    }
    for (const entry of manual) {
      if (entry) add(entry, entry.subject === '*' ? '全部范围' : names.get(entry.subject) || entry.subject);
    }

    const focused = body.contains(document.activeElement) ? document.activeElement.closest('td')?.dataset.date : null;
    const first = month.getTime(), next = new Date(first);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const currentDay = today();
    find('.calendar-month').textContent = `${month.getUTCFullYear()}年${month.getUTCMonth() + 1}月`;
    const rows = document.createDocumentFragment();
    for (let start = first - ((month.getUTCDay() + 6) % 7) * DAY; start < next; start += 7 * DAY) {
      const row = node('tr'), week = weekOf(new Date(start));
      const header = node('th', 'W' + String(week.number).padStart(2, '0'));
      header.scope = 'row';
      header.setAttribute('aria-label', `${week.year}年第${week.number}周`);
      row.append(header);
      for (let offset = 0; offset < 7; offset++) {
        const date = new Date(start + offset * DAY), key = dateKey(date);
        const cell = node('td'), entries = days.get(key) || [];
        cell.dataset.date = key;
        if (date < first || date >= next) cell.className = 'adjacent-day';
        const tile = node(entries.length ? 'button' : 'div', undefined, 'calendar-day');
        const day = node('time', String(date.getUTCDate()));
        day.dateTime = key;
        if (key === currentDay) day.setAttribute('aria-current', 'date');
        tile.append(day);
        if (entries.length) {
          tile.type = 'button';
          tile.setAttribute('aria-label', `${key}，${entries.length}条标注`);
          tile.setAttribute('aria-expanded', String(selected === key));
          tile.setAttribute('aria-controls', detail.id);
          for (const entry of entries.slice(0, 2)) tile.append(node('span', entry.text, 'calendar-snippet'));
          if (entries.length > 2) tile.append(node('span', '+' + (entries.length - 2), 'calendar-more'));
          tile.append(node('span', `${entries.length}条`, 'calendar-count'));
          tile.addEventListener('click', () => {
            selected = selected === key ? null : key;
            render();
            if (selected) detail.scrollIntoView({ block: 'nearest' });
          });
        }
        cell.append(tile);
        row.append(cell);
      }
      rows.append(row);
    }
    body.replaceChildren(rows);
    if (focused) body.querySelector(`[data-date="${focused}"] button`)?.focus({ preventScroll: true });
    const active = days.get(selected);
    detail.hidden = !active;
    detail.replaceChildren();
    if (active) {
      detail.append(node('h3', `${selected} · ${active.length}条标注`));
      const list = node('ul');
      for (const entry of active) {
        const item = node('li');
        if (entry.source) item.append(node('span', entry.source, 'calendar-source'));
        item.append(document.createTextNode(entry.text));
        list.append(item);
      }
      detail.append(list);
    }
    let message = '';
    if (orderApp?.status !== 'ready') message = '订单分析暂未接入，无法显示标注';
    else if (errors.length) message = errors.join('、') + '暂未加载';
    else if (pending) message = '正在读取订单标注…';
    else if (![...days.keys()].some(key => key.startsWith(dateKey(month).slice(0, 7)))) message = '本月暂无订单标注';
    status.textContent = message;
    retry.hidden = !errors.length;
  }

  function hide() {
    request?.abort();
    request = null;
  }
  async function refresh() {
    hide();
    errors = [];
    if (orderApp?.status !== 'ready') { render(); return; }
    const controller = new AbortController();
    request = controller;
    pending = 2;
    render();
    async function read(path, field, label, apply) {
      try {
        const response = await fetch(orderApp.url + path, { cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (!Array.isArray(data?.[field])) throw new Error('Invalid order feed');
        if (request === controller) apply(data[field]);
      } catch {
        if (request === controller) { apply([]); errors.push(label); }
      } finally {
        if (request === controller) { pending--; render(); }
      }
    }
    await Promise.all([
      read('api/annotations', 'entries', '订单批注', rows => { manual = rows; }),
      read('api/catalog', 'subjects', '阶段事件', rows => { subjects = rows; })
    ]);
  }
  for (const button of panel.querySelectorAll('[data-month-step]')) {
    button.addEventListener('click', () => {
      const step = Number(button.dataset.monthStep);
      if (step) month.setUTCMonth(month.getUTCMonth() + step);
      else month = new Date(today().slice(0, 7) + '-01T00:00:00Z');
      selected = null;
      render();
    });
  }
  retry.addEventListener('click', refresh);
  return { refresh, hide };
}
