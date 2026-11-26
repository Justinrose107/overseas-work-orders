import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hour = 3_600_000;
const types = new Set(['Repair', 'Maintenance', 'Installation', 'FCO']);
const statuses = new Set(['In Dispatching', 'Dispatched', 'In Progress', 'Closed', 'Closed - Pending Review', 'Cancel', 'Pause', '已派单已确认', 'Other']);
const readKey = process.env.DASHBOARD_READ_KEY;
const syncKey = process.env.SHARECRM_SYNC_KEY;
const origin = process.env.PAGES_ORIGIN;
const botSecret = process.env.FEISHU_BOT_SIGNING_SECRET;
const staleHours = Number(process.env.SYNC_MAX_AGE_HOURS || 26);
const bot = process.env.FEISHU_WEBHOOK_URL ? new URL(process.env.FEISHU_WEBHOOK_URL) : null;

if (!readKey || !syncKey || readKey === syncKey || Math.min(readKey.length, syncKey.length) < 24) {
  throw new Error('Configure two distinct access keys of at least 24 characters.');
}
if (origin && (new URL(origin).origin !== origin || !origin.startsWith('https://'))) {
  throw new Error('PAGES_ORIGIN must be an HTTPS origin without a trailing slash.');
}
if (!Number.isFinite(staleHours) || staleHours <= 0) throw new Error('Invalid SYNC_MAX_AGE_HOURS.');
if (bot && (bot.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(bot.host) || !/^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(bot.pathname))) {
  throw new Error('Configure a Feishu or Lark custom robot webhook.');
}

const dbFile = resolve(process.env.WORK_ORDER_DB || 'data/work-orders.sqlite');
mkdirSync(dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    number TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, source_updated_at INTEGER NOT NULL,
    closed_at INTEGER, reminded_tier INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS source (id INTEGER PRIMARY KEY CHECK (id = 1), as_of INTEGER NOT NULL);
`);

const put = db.prepare(`
  INSERT INTO orders (number, type, status, created_at, source_updated_at, closed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(number) DO UPDATE SET type = excluded.type, status = excluded.status,
    created_at = excluded.created_at, source_updated_at = excluded.source_updated_at,
    closed_at = excluded.closed_at
  WHERE excluded.source_updated_at > orders.source_updated_at
`);
const setAsOf = db.prepare('INSERT INTO source VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET as_of = MAX(as_of, excluded.as_of)');
const getAsOf = db.prepare('SELECT as_of FROM source WHERE id = 1');
const list = db.prepare('SELECT * FROM orders ORDER BY created_at ASC, number ASC');
const mark = db.prepare('UPDATE orders SET reminded_tier = MAX(reminded_tier, ?) WHERE number = ?');

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function validKey(request, key) {
  const supplied = request.headers.authorization;
  const digest = (value) => createHash('sha256').update(value).digest();
  return typeof supplied === 'string' && timingSafeEqual(digest(supplied), digest(`Bearer ${key}`));
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error(`${name} requires an ISO timestamp with timezone.`);
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${name} is invalid.`);
  return result;
}

function parseSync(body) {
  if (!Array.isArray(body?.orders) || body.orders.length > 2000) throw new Error('Provide up to 2000 orders per request.');
  const asOf = body.sourceAsOf === undefined ? null : timestamp(body.sourceAsOf, 'sourceAsOf');
  if (asOf > Date.now() + 300000) throw new Error('sourceAsOf is in the future.');
  const orders = body.orders.map((order) => {
    if (!order || typeof order.number !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(order.number) || !types.has(order.type) || !statuses.has(order.status)) {
      throw new Error('Invalid order number, type, or status.');
    }
    const created = timestamp(order.createdAt, 'createdAt');
    const updated = timestamp(order.updatedAt, 'updatedAt');
    const closed = order.closedAt == null ? null : timestamp(order.closedAt, 'closedAt');
    if (updated < created || (closed !== null && closed < created)) throw new Error('Order timestamps are out of sequence.');
    return [order.number, order.type, order.status, created, updated, closed];
  });
  return { asOf, orders };
}

function dashboard() {
  const now = Date.now();
  const lastSync = getAsOf.get()?.as_of ?? null;
  const rows = list.all().map((row) => {
    const state = row.status === 'Closed' ? 'closed' : row.status === 'Cancel' ? 'cancelled' : 'open';
    const hours = Math.max(0, Math.floor(((state === 'open' ? now : row.closed_at ?? row.source_updated_at) - row.created_at) / hour));
    const ageHours = state === 'open' || row.closed_at !== null ? hours : null;
    const tier = state === 'open' ? ([72, 48, 24].find((value) => hours >= value) ?? 0) : 0;
    return { number: row.number, type: row.type, status: row.status, state, createdAt: row.created_at, ageHours, tier, remindedTier: row.reminded_tier };
  });
  const summary = { open: 0, 24: 0, 48: 0, 72: 0 };
  for (const row of rows) {
    if (row.state !== 'open') continue;
    summary.open++;
    if (row.tier) summary[row.tier]++;
  }
  return { orders: rows, lastSync, stale: lastSync === null || now - lastSync > staleHours * hour, remindersEnabled: !!bot, summary };
}

const assetTypes = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
const assets = Object.fromEntries(Object.entries(assetTypes).map(([path, [file, type]]) =>
  [path, { type, body: readFileSync(new URL(`./docs/${file}`, import.meta.url)) }],
));

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/api/dashboard') {
      if (origin && request.headers.origin === origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization');
        response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      }
      if (request.method === 'OPTIONS') return response.writeHead(204).end();
      if (request.method === 'GET') {
        if (!validKey(request, readKey)) return json(response, 401, { error: 'Unauthorized' });
        return json(response, 200, dashboard());
      }
    }
    if (path === '/api/sync' && request.method === 'POST') {
      if (!validKey(request, syncKey)) return json(response, 401, { error: 'Unauthorized' });
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) return json(response, 413, { error: 'Request body is too large.' });
        chunks.push(chunk);
      }
      let intake;
      try {
        intake = parseSync(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        return json(response, 400, { error: error.message });
      }
      db.exec('BEGIN');
      try {
        for (const data of intake.orders) put.run(...data);
        if (intake.asOf !== null) setAsOf.run(intake.asOf);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(response, 200, { accepted: intake.orders.length, sourceAsOf: getAsOf.get()?.as_of ?? null });
    }
    if (request.method === 'GET' && Object.hasOwn(assets, path)) {
      const { type, body } = assets[path];
      return response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(body);
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed:', error.name);
    if (!response.headersSent) return json(response, 500, { error: 'Internal error' });
    response.end();
  }
});

let sending = false;
async function sendReminders() {
  if (!bot || sending) return;
  const snapshot = dashboard();
  if (snapshot.stale) return;
  const due = snapshot.orders.filter((order) => order.tier > order.remindedTier).slice(0, 50);
  if (!due.length) return;
  sending = true;
  try {
    const lines = due.map((order) => `${order.number} · ${order.type} · ${order.tier} 小时档（已 ${order.ageHours} 小时）`);
    const stamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(snapshot.lastSync);
    const body = { msg_type: 'text', content: { text: `海外工单待跟进\n${lines.join('\n')}\n状态截至 ${stamp}（北京时间）` } };
    if (botSecret) {
      body.timestamp = String(Math.floor(Date.now() / 1000));
      body.sign = createHmac('sha256', `${body.timestamp}\n${botSecret}`).digest('base64');
    }
    const response = await fetch(bot, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
    const result = await response.json();
    if (!response.ok || (result.code ?? result.StatusCode) !== 0) throw new Error('Delivery failed');
    db.exec('BEGIN');
    try {
      for (const order of due) mark.run(order.tier, order.number);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch {
    console.error('Reminders were not recorded as sent. The next check will retry.');
  } finally {
    sending = false;
  }
}

if (bot) setInterval(() => { void sendReminders(); }, 60000).unref();
server.listen(Number(process.env.PORT || 8787), process.env.BIND_ADDRESS || '127.0.0.1', () => {
  console.log(`Work order service listening on ${server.address().address}:${server.address().port}`);
});
