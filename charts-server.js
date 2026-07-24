/**
 * Predefined REST API chart-storage server for the TradingView Charting Library.
 * ---------------------------------------------------------------------------
 * Implements the save/load protocol the library uses when you set:
 *   charts_storage_url: "http://localhost:8001",
 *   charts_storage_api_version: "1.1",
 *   client_id: "trading-view-demo",
 *   user_id:   "public_user",
 *
 * Endpoints (per the "Save and load REST API" doc), all four operations each:
 *   {version}/charts?client=&user=[&chart=ID]           GET list|load, POST save, DELETE
 *   {version}/study_templates?client=&user=[&template=]  GET list|load, POST save, DELETE
 *
 * Storage is per (client_id, user_id) and persists to charts-store.json.
 * Zero dependencies. Node 18+. Run:  node charts-server.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = process.env.PORT || 8001;
const STORE_FILE = path.join(__dirname, 'charts-store.json');

// --------------------------------------------------------------------------
// Persistence: { charts: { "client/user": { id: chart } }, templates: {...}, seq }
// --------------------------------------------------------------------------
let store = { charts: {}, templates: {}, seq: 0 };
try {
  if (fs.existsSync(STORE_FILE)) store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
} catch (_) { /* start fresh on a corrupt file */ }

function persist() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); } catch (_) {}
}
const scope = (client, user) => `${client || ''}/${user || ''}`;
const nowSec = () => Math.floor(Date.now() / 1000);

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------
function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

// The library posts application/x-www-form-urlencoded (name, content, symbol, resolution).
function parseForm(body) {
  const out = {};
  if (!body) return out;
  for (const pair of body.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '))] =
      decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  }
  return out;
}

// --------------------------------------------------------------------------
// Charts
// --------------------------------------------------------------------------
function chartsGet(q) {
  const key = scope(q.get('client'), q.get('user'));
  const bucket = store.charts[key] || {};
  const chartId = q.get('chart');

  if (chartId) {
    // Load one chart (full content included).
    const c = bucket[chartId];
    if (!c) return { status: 'error', message: 'Chart not found' };
    return { status: 'ok', data: c };
  }
  // List all charts (metadata only, no content — keeps the list light).
  const data = Object.values(bucket).map(({ content, ...meta }) => meta);
  return { status: 'ok', data };
}

function chartsSave(q, form) {
  const key = scope(q.get('client'), q.get('user'));
  if (!store.charts[key]) store.charts[key] = {};
  const bucket = store.charts[key];

  const existingId = q.get('chart'); // present when the library updates a chart
  const id = existingId || String(++store.seq);
  bucket[id] = {
    id,
    name: form.name || 'Unnamed',
    symbol: form.symbol || '',
    resolution: form.resolution || '',
    content: form.content || '',
    timestamp: nowSec(),
  };
  persist();
  return { status: 'ok', id };
}

function chartsDelete(q) {
  const key = scope(q.get('client'), q.get('user'));
  const chartId = q.get('chart');
  if (store.charts[key] && chartId && store.charts[key][chartId]) {
    delete store.charts[key][chartId];
    persist();
  }
  return { status: 'ok' };
}

// --------------------------------------------------------------------------
// Study (indicator) templates — keyed by name, no id.
// --------------------------------------------------------------------------
function templatesGet(q) {
  const key = scope(q.get('client'), q.get('user'));
  const bucket = store.templates[key] || {};
  const name = q.get('template');

  if (name) {
    const t = bucket[name];
    if (!t) return { status: 'error', message: 'Template not found' };
    return { status: 'ok', data: t };
  }
  const data = Object.keys(bucket).map((n) => ({ name: n }));
  return { status: 'ok', data };
}

function templatesSave(q, form) {
  const key = scope(q.get('client'), q.get('user'));
  if (!store.templates[key]) store.templates[key] = {};
  store.templates[key][form.name] = { name: form.name, content: form.content || '' };
  persist();
  return { status: 'ok' };
}

function templatesDelete(q) {
  const key = scope(q.get('client'), q.get('user'));
  const name = q.get('template');
  if (store.templates[key] && name && store.templates[key][name]) {
    delete store.templates[key][name];
    persist();
  }
  return { status: 'ok' };
}

// --------------------------------------------------------------------------
// Router:  /{version}/{resource}
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { return send(res, 400, { status: 'error', message: 'bad url' }); }

  const q = url.searchParams;
  const parts = url.pathname.split('/').filter(Boolean); // [version, resource]
  const version = parts[0];
  const resource = parts[1];

  if (url.pathname === '/') {
    return send(res, 200, { ok: true, service: 'Chart storage REST API',
      versions: ['1.0', '1.1'], resources: ['charts', 'study_templates'] });
  }
  if (!['1.0', '1.1'].includes(version) || !['charts', 'study_templates'].includes(resource)) {
    return send(res, 404, { status: 'error', message: 'unknown endpoint' });
  }

  try {
    const isChart = resource === 'charts';
    if (req.method === 'GET') {
      return send(res, 200, isChart ? chartsGet(q) : templatesGet(q));
    }
    if (req.method === 'POST') {
      const form = parseForm(await readBody(req));
      return send(res, 200, isChart ? chartsSave(q, form) : templatesSave(q, form));
    }
    if (req.method === 'DELETE') {
      return send(res, 200, isChart ? chartsDelete(q) : templatesDelete(q));
    }
    return send(res, 405, { status: 'error', message: 'method not allowed' });
  } catch (err) {
    return send(res, 500, { status: 'error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Chart storage REST API on http://localhost:${PORT}  (store: ${STORE_FILE})`);
});
