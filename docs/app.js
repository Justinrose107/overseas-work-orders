const byId = (id) => document.getElementById(id);
const dialog = byId('connection');
const connect = byId('connect');
const refresh = byId('refresh');
const badge = byId('sync-badge');
const filters = ['search', 'type', 'state', 'tier'].map(byId);
const types = { Repair: '维修', Maintenance: '保养', Installation: '安装', FCO: 'FCO' };
const formatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});
let connection;
let dashboard;
let refreshing = false;
const localChannel = 'overseas-work-orders-local-v1';

function message(id, value) {
  const node = byId(id);
  node.textContent = value;
  node.hidden = !value;
}

function showConnection() {
  message('connection-error', '');
  byId('endpoint').value = connection?.origin ?? (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? location.origin : '');
  byId('read-key').value = '';
  dialog.showModal();
}

function render() {
  if (!dashboard) return;
  const { orders, lastSync, stale, remindersEnabled, summary } = dashboard;
  badge.textContent = lastSync ? (stale ? '同步滞后' : dashboard.mode === 'local' ? '本机同步' : '已连接') : '等待首次同步';
  badge.className = `badge${lastSync ? (stale ? ' warning' : ' ok') : ''}`;
  byId('last-sync').textContent = lastSync ? `数据截至 ${formatter.format(new Date(lastSync))}` : '等待 ShareCRM 数据';
  byId('reminder-status').textContent = remindersEnabled ? (stale ? '数据滞后，提醒暂停' : '飞书提醒已配置') : '飞书提醒待配置';
  byId('open-count').textContent = lastSync ? summary.open : '—';
  for (const tier of [24, 48, 72]) byId(`tier-${tier}`).textContent = lastSync ? summary[tier] : '—';

  const [search, type, state, tier] = filters.map((node) => node.value);
  const matching = orders.filter((order) =>
    (!search || order.number.toLowerCase().includes(search.trim().toLowerCase())) &&
    (!type || order.type === type) && (!state || order.state === state) &&
    (!tier || (order.state === 'open' && order.tier === Number(tier))),
  );
  const rows = document.createDocumentFragment();
  for (const order of matching) {
    const row = document.createElement('tr');
    row.insertCell().textContent = order.number;
    row.insertCell().textContent = types[order.type];
    row.insertCell().textContent = order.status;
    row.insertCell().textContent = formatter.format(new Date(order.createdAt));
    const age = row.insertCell();
    age.textContent = order.ageHours === null ? '—' : `${order.ageHours} 小时`;
    if (order.state === 'open' && order.tier >= 48) age.className = 'warn';
    row.insertCell().textContent = order.remindedTier ? `${order.remindedTier} 小时` : '—';
    rows.append(row);
  }
  byId('rows').replaceChildren(rows);
  byId('empty').hidden = matching.length > 0;
  byId('empty-title').textContent = lastSync ? '没有符合条件的工单' : '等待首次同步';
  byId('empty-text').textContent = lastSync ? '可以调整搜索条件。' : dashboard.mode === 'local' ? '请在浏览器扩展中开始同步，完成后这里会显示当前未结工单。' : '同步服务已连接，收到工单后会自动显示。';
  byId('empty-connect').hidden = true;
  byId('result-count').textContent = lastSync ? `显示 ${matching.length} 条` : '';
  if (dashboard.mode === 'local') message('feedback', dashboard.issue || '');
}

function loadLocal() {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const receive = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== localChannel ||
          event.data.kind !== 'response' || event.data.nonce !== nonce) return;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      resolve(event.data.data);
    };
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('本机同步扩展尚未连接'));
    }, 1700);
    window.addEventListener('message', receive);
    window.postMessage({ channel: localChannel, kind: 'request', nonce }, location.origin);
  });
}

async function load(config) {
  if (config.mode === 'local') return loadLocal();
  const response = await fetch(new URL('/api/dashboard', config.origin), {
    headers: { Authorization: `Bearer ${config.key}` },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 401) throw new Error('只读访问令牌无效。');
  if (!response.ok) throw new Error('同步服务暂时无法读取。');
  const body = await response.json();
  if (!Array.isArray(body.orders) || !body.summary) throw new Error('这个地址没有返回工单看板数据。');
  return body;
}

byId('settings').addEventListener('click', showConnection);
byId('empty-connect').addEventListener('click', showConnection);
byId('cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { byId('read-key').value = ''; });
filters.forEach((field) => field.addEventListener('input', render));

byId('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const endpoint = new URL(byId('endpoint').value.trim());
  const loopback = ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) {
    message('connection-error', '请填写 HTTPS 服务地址。本机预览可以使用 localhost。');
    return;
  }
  const config = { origin: endpoint.origin, key: byId('read-key').value.trim() };
  connect.disabled = true;
  message('connection-error', '');
  try {
    dashboard = await load(config);
    connection = config;
    refresh.disabled = false;
    message('feedback', '');
    render();
    dialog.close();
  } catch (error) {
    message('connection-error', error instanceof TypeError ? '无法连接。请检查地址以及服务是否允许此 GitHub Pages 域名。' : error.message);
  } finally {
    connect.disabled = false;
  }
});

async function reload() {
  if (!connection || refreshing) return;
  refreshing = true;
  refresh.disabled = true;
  const config = connection;
  try {
    const updated = await load(config);
    if (connection !== config) return;
    dashboard = updated;
    message('feedback', '');
    render();
  } catch {
    if (connection !== config) return;
    badge.textContent = '刷新失败';
    badge.className = 'badge warning';
    message('feedback', '无法刷新。当前展示的是上一次成功读取的数据。');
  } finally {
    refresh.disabled = false;
    refreshing = false;
  }
}

refresh.addEventListener('click', reload);
setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 60000);

if (location.protocol === 'https:') {
  const local = { mode: 'local' };
  loadLocal().then((data) => {
    if (connection) return;
    connection = local;
    dashboard = data;
    refresh.disabled = false;
    render();
  }).catch(() => {});
}
