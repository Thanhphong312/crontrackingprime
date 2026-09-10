/**
 * Web dashboard — Express HTTP server.
 * Giao diện quản lý qua browser, thay thế UI Electron khi chạy trên server.
 *
 * Endpoints:
 *   GET  /              Dashboard HTML
 *   GET  /api/stats     Stats JSON
 *   GET  /api/settings  Settings JSON (không trả shipengineKey / apiKey)
 *   POST /api/settings  Lưu settings
 *   POST /api/run/:kind Chạy thủ công (main|pre|alert|all)
 *   GET  /api/logs      Server-Sent Events stream log realtime
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runCheck, runAlert, fetchStats } = require('./checker');

// ── Auth ──────────────────────────────────────────────────────────────────────
const WEB_USER = process.env.WEB_USER || 'admin';
const WEB_PASS = process.env.WEB_PASS || 'Qe4]%U@5=3h=gUaA';
const sessions = new Map(); // token → expiry

function genToken() { return crypto.randomBytes(24).toString('hex'); }

function createSession() {
  const token = genToken();
  sessions.set(token, Date.now() + 8 * 3600 * 1000); // 8h
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

function checkAuth(req) {
  return isValidSession(getCookie(req, 'sid'));
}

// ── Settings (shared với server.js) ──────────────────────────────────────────
const SETTINGS_PATHS = [
  '/app/settings.json',
  path.join(__dirname, '..', 'settings.json'),
];

function settingsPath() {
  for (const p of SETTINGS_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return SETTINGS_PATHS[SETTINGS_PATHS.length - 1];
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ── Log ring buffer (100 dòng cho SSE) ────────────────────────────────────────
const LOG_BUFFER = [];
const LOG_MAX = 200;
const sseClients = new Set();

function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  console.log(`[${entry.ts}] [${level.toUpperCase()}] ${message}`);
}

// ── Guard chống overlap ────────────────────────────────────────────────────────
const running = { main: false, pre: false, alert: false };

async function doRun(kind) {
  if (running[kind]) { pushLog('info', `[${kind}] đang chạy — bỏ qua.`); return; }
  running[kind] = true;
  try {
    const s = loadSettings();
    if (kind === 'alert') await runAlert(s, pushLog, 'manual');
    else await runCheck(s, pushLog, 'manual', kind);
  } catch (err) {
    pushLog('error', `[${kind}] ${err.message}`);
  } finally {
    running[kind] = false;
  }
}

// ── Router đơn giản (không dùng express để không thêm dependency) ─────────────
function router(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Login page ──
  if (pathname === '/login') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const u = params.get('username') || '';
        const p = params.get('password') || '';
        if (u === WEB_USER && p === WEB_PASS) {
          const token = createSession();
          res.writeHead(302, {
            'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
            'Location': '/',
          });
          res.end();
        } else {
          res.writeHead(302, { 'Location': '/login?err=1' });
          res.end();
        }
      });
      return;
    }
  }

  // ── Logout ──
  if (pathname === '/logout') {
    const token = getCookie(req, 'sid');
    if (token) sessions.delete(token);
    res.writeHead(302, {
      'Set-Cookie': 'sid=; Path=/; Max-Age=0',
      'Location': '/login',
    });
    res.end();
    return;
  }

  // ── Auth guard ──
  if (!checkAuth(req)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    } else {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // SSE logs stream
  if (pathname === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Gửi buffer hiện tại
    for (const entry of LOG_BUFFER) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    fetchStats(loadSettings()).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data }));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // Orders list (proxy to be-tool /api/tracking-poll/orders)
  if (pathname === '/api/orders' && req.method === 'GET') {
    const axios = require('axios');
    const s = loadSettings();
    const params = {};
    if (url.searchParams.get('status')) params.status = url.searchParams.get('status');
    if (url.searchParams.get('page')) params.page = url.searchParams.get('page');
    if (url.searchParams.get('per_page')) params.per_page = url.searchParams.get('per_page');
    axios.get(`${s.apiBase}/api/tracking-poll/orders`, { params, timeout: 15000 })
      .then(r => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.data));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  // Orders page
  if (pathname === '/orders') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ORDERS_HTML);
    return;
  }

  // Settings GET
  if (pathname === '/api/settings' && req.method === 'GET') {
    const s = { ...loadSettings() };
    // Che key nhạy cảm
    if (s.shipengineKey) s.shipengineKey = s.shipengineKey.slice(0, 6) + '…';
    if (s.apiKey) s.apiKey = s.apiKey.slice(0, 8) + '…';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: s }));
    return;
  }

  // Settings POST
  if (pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        const next = saveSettings(patch);
        // Che keys trước khi trả về
        const safe = { ...next };
        if (safe.shipengineKey) safe.shipengineKey = safe.shipengineKey.slice(0, 6) + '…';
        if (safe.apiKey) safe.apiKey = safe.apiKey.slice(0, 8) + '…';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: safe }));
        pushLog('ok', 'Settings đã lưu.');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Run
  if (pathname.startsWith('/api/run/') && req.method === 'POST') {
    const kind = pathname.replace('/api/run/', '');
    if (kind === 'all') {
      doRun('main');
      doRun('pre');
    } else if (['main', 'pre', 'alert'].includes(kind)) {
      doRun(kind);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'kind không hợp lệ' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind }));
    return;
  }

  // Dashboard HTML
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ── Login HTML ────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Login — Cron Tracking PrimeHorizon</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f111a;color:#c8cdd9;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1d2e;border:1px solid #2a2d3a;border-radius:12px;padding:32px 28px;width:320px;display:flex;flex-direction:column;gap:14px}
h2{font-size:16px;color:#e6eaf2;text-align:center;margin-bottom:4px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#aab}
input{background:#0f111a;border:1px solid #2a2d3a;border-radius:6px;padding:8px 10px;color:#e6eaf2;font-size:13px;width:100%}
input:focus{outline:none;border-color:#4dabf7}
.btn{padding:9px;border:none;border-radius:6px;background:#1a3a5c;color:#4dabf7;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.btn:hover{background:#1e4d7b}
.err{color:#f77;font-size:12px;text-align:center;display:none}
.err.show{display:block}
</style>
</head>
<body>
<div class="card">
  <h2>🔐 Cron Tracking PrimeHorizon</h2>
  <form method="POST" action="/login">
    <label>Username<input name="username" type="text" autocomplete="username" autofocus/></label>
    <label>Password<input name="password" type="password" autocomplete="current-password"/></label>
    <div class="err${(typeof location !== 'undefined' && location.search.includes('err=1')) ? ' show' : ''}" id="err">Sai username hoặc password.</div>
    <button class="btn" type="submit">Đăng nhập</button>
  </form>
</div>
<script>
if (location.search.includes('err=1')) document.getElementById('err').classList.add('show');
</script>
</body>
</html>`;

// ── Dashboard HTML (inline, không cần static files) ───────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cron Tracking PrimeHorizon</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#0f111a;color:#c8cdd9;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:100vh}
h1{font-size:17px;color:#e6eaf2}
.row{display:flex;gap:8px;flex-wrap:wrap}
.stat-box{flex:1;min-width:100px;background:#1a1d2e;border:1px solid #2a2d3a;border-radius:8px;padding:12px 8px;text-align:center}
.stat-val{font-size:24px;font-weight:700;color:#4dabf7}
.stat-lbl{font-size:10px;color:#666;margin-top:2px}
.by-status{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:#1e2235;border:1px solid #2d3148;border-radius:5px;padding:3px 8px;font-size:11px;color:#aab}
.chip.delivered{border-color:#2d6a4f;color:#74c69d}
.chip.in_transit{border-color:#1e4d7b;color:#4dabf7}
.chip.alert,.chip.return_to_sender{border-color:#7b1e1e;color:#f77}
.chip.out_for_delivery{border-color:#4a3a00;color:#ffd43b}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.btn{padding:7px 14px;border:1px solid #2a2d3a;border-radius:6px;background:#1a1d2e;color:#c8cdd9;cursor:pointer;font-size:12px;transition:background .15s}
.btn:hover{background:#252840}
.btn.primary{background:#1a3a5c;border-color:#1e4d7b;color:#4dabf7}
.btn.primary:hover{background:#1e4d7b}
.btn.warning{background:#3a2a00;border-color:#5a4200;color:#ffd43b}
.btn.warning:hover{background:#5a4200}
.btn:disabled{opacity:.4;cursor:not-allowed}
.tabs{display:flex;gap:2px;border-bottom:1px solid #2a2d3a}
.tab{padding:6px 16px;background:none;border:none;color:#666;cursor:pointer;font-size:12px;border-bottom:2px solid transparent}
.tab.active{color:#4dabf7;border-bottom-color:#4dabf7}
.panel{display:none;padding-top:8px}
.panel.active{display:block}
#logBox{height:300px;overflow-y:auto;background:#080a10;border:1px solid #1a1d2e;border-radius:6px;padding:8px;font-family:Menlo,Consolas,monospace;font-size:11px;line-height:1.6}
.ll{padding:1px 0}.ll.info{color:#aab}.ll.ok{color:#74c69d}.ll.error{color:#f77}.ll.warn{color:#ffd43b}
.lts{color:#444;margin-right:6px;font-size:10px}
form{display:flex;flex-direction:column;gap:6px;max-width:600px}
form h3{font-size:11px;color:#888;margin-top:10px;text-transform:uppercase;letter-spacing:.5px}
label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#aab}
input[type=text],input[type=number]{background:#1a1d2e;border:1px solid #2a2d3a;border-radius:5px;padding:5px 8px;color:#e6eaf2;font-size:12px;width:100%}
label:has(input[type=checkbox]){flex-direction:row;align-items:center;gap:6px}
input[type=checkbox]{accent-color:#4dabf7}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.badge.idle{background:#2a2d3a;color:#888}
.badge.running{background:#1a3a5c;color:#4dabf7}
</style>
</head>
<body>
<div class="row" style="align-items:center">
  <h1 style="flex:1">Cron Tracking PrimeHorizon</h1>
  <span id="badge" class="badge idle">Idle</span>
  <a href="/orders" style="margin-left:10px;font-size:11px;color:#4dabf7;text-decoration:none;padding:4px 10px;border:1px solid #1e4d7b;border-radius:5px">📦 Orders</a>
  <a href="/logout" style="margin-left:6px;font-size:11px;color:#666;text-decoration:none;padding:4px 10px;border:1px solid #2a2d3a;border-radius:5px">Logout</a>
</div>
<div class="row" id="statsRow">
  <div class="stat-box"><div class="stat-val" id="s_tracked">—</div><div class="stat-lbl">Tracked</div></div>
  <div class="stat-box"><div class="stat-val" id="s_pre">—</div><div class="stat-lbl">Pre-Shipment</div></div>
  <div class="stat-box"><div class="stat-val" id="s_transit">—</div><div class="stat-lbl">In Transit</div></div>
  <div class="stat-box"><div class="stat-val" id="s_delivered">—</div><div class="stat-lbl">Delivered</div></div>
  <div class="stat-box"><div class="stat-val" id="s_pending">—</div><div class="stat-lbl">Pending</div></div>
</div>
<div class="by-status" id="byStatus"></div>
<div class="actions">
  <button class="btn primary" onclick="runKind('main')">▶ Run Main</button>
  <button class="btn" onclick="runKind('pre')">▶ Run Pre</button>
  <button class="btn warning" onclick="runKind('alert')">🔔 Alert</button>
  <button class="btn" onclick="runKind('all')">▶ Run All</button>
  <button class="btn" onclick="loadStats()" style="margin-left:auto">⟳ Refresh</button>
</div>
<div class="tabs">
  <button class="tab active" onclick="switchTab('logs',this)">Logs</button>
  <button class="tab" onclick="switchTab('settings',this)">Settings</button>
</div>
<div id="panelLogs" class="panel active">
  <div style="display:flex;justify-content:flex-end;margin-bottom:4px">
    <button class="btn" style="font-size:11px;padding:3px 10px" onclick="document.getElementById('logBox').innerHTML=''">Xoá log</button>
  </div>
  <div id="logBox"></div>
</div>
<div id="panelSettings" class="panel">
  <form id="sf" onsubmit="saveSettings(event)">
    <h3>PrimeHorizon API</h3>
    <label>API Base URL<input name="apiBase" type="text" placeholder="https://api-tool.primehorizon.studio"/></label>
    <h3>ShipEngine</h3>
    <label>API Key <span id="seKeyStatus" style="color:#74c69d;font-size:10px"></span><input name="shipengineKey" type="text" placeholder="để trống nếu không đổi" autocomplete="off"/></label>
    <label>Default Carrier<input name="carrierCode" type="text" placeholder="usps"/></label>
    <h3>Cron Main (đơn in-transit)</h3>
    <label><input name="enabled" type="checkbox"/> Bật cron main</label>
    <label>Giờ chạy (VD: 0,6,12,18)<input name="runHours" type="text"/></label>
    <label>Batch limit<input name="batchLimit" type="number" min="1" max="200"/></label>
    <h3>Cron Pre (chưa transit)</h3>
    <label><input name="preEnabled" type="checkbox"/> Bật cron pre</label>
    <label>Giờ chạy<input name="preRunHours" type="text"/></label>
    <label>Batch limit<input name="preBatchLimit" type="number" min="1" max="200"/></label>
    <h3>Cron Alert Telegram</h3>
    <label><input name="alertEnabled" type="checkbox"/> Bật cron alert</label>
    <label>Giờ chạy<input name="alertRunHours" type="text"/></label>
    <label>Chưa transit sau (giờ)<input name="lateIntransitHours" type="number" min="1"/></label>
    <label>Chưa delivered sau (giờ)<input name="lateDeliveredHours" type="number" min="1"/></label>
    <label>Nhắc lại sau (giờ)<input name="repeatHours" type="number" min="1"/></label>
    <label>Cửa sổ quét (ngày)<input name="windowDays" type="number" min="1"/></label>
    <h3>Timezone</h3>
    <label>Timezone<input name="timezone" type="text" placeholder="Asia/Ho_Chi_Minh"/></label>
    <div style="margin-top:12px">
      <button type="submit" class="btn primary">💾 Lưu Settings</button>
    </div>
  </form>
</div>
<script>
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1)).classList.add('active');
}

// Logs SSE
const logBox = document.getElementById('logBox');
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function addLog({ts, level, message}) {
  const d = document.createElement('div');
  d.className = 'll ' + level;
  d.innerHTML = '<span class="lts">' + new Date(ts).toLocaleTimeString('vi-VN') + '</span>' + esc(message);
  logBox.appendChild(d);
  while (logBox.children.length > 400) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}
const es = new EventSource('/api/logs');
es.onmessage = e => addLog(JSON.parse(e.data));

// Stats
async function loadStats() {
  const r = await fetch('/api/stats').then(r=>r.json()).catch(()=>({}));
  const d = r.data || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
  set('s_tracked', d.tracked);
  set('s_pre', d.pre_shipment);
  set('s_transit', d.in_transit);
  set('s_delivered', d.delivered);
  set('s_pending', d.pending);
  const bs = document.getElementById('byStatus');
  bs.innerHTML = '';
  for (const [st, cnt] of Object.entries(d.by_status || {})) {
    const c = document.createElement('span');
    c.className = 'chip ' + st.replace(/[^a-z_]/g,'');
    c.textContent = st + ': ' + cnt;
    bs.appendChild(c);
  }
}
loadStats();
setInterval(loadStats, 60000);

// Run
const runBtns = document.querySelectorAll('.actions .btn');
async function runKind(kind) {
  runBtns.forEach(b => b.disabled = true);
  document.getElementById('badge').textContent = 'Running…';
  document.getElementById('badge').className = 'badge running';
  await fetch('/api/run/' + kind, {method:'POST'}).catch(()=>{});
  // poll đơn giản 1s rồi reset badge (server tự log khi xong)
  setTimeout(() => {
    runBtns.forEach(b => b.disabled = false);
    document.getElementById('badge').textContent = 'Idle';
    document.getElementById('badge').className = 'badge idle';
    loadStats();
  }, 2000);
}

// Settings
async function loadSettingsForm() {
  const r = await fetch('/api/settings').then(r=>r.json()).catch(()=>({}));
  const s = r.data || {};
  const f = document.getElementById('sf');
  const hoursStr = arr => (arr||[]).join(',');
  f.apiBase.value = s.apiBase || 'https://api-tool.primehorizon.studio';
  f.shipengineKey.value = '';
  const seStatus = document.getElementById('seKeyStatus');
  if (seStatus) seStatus.textContent = s.shipengineKey ? '✓ đã lưu' : '';
  f.carrierCode.value = s.carrierCode || 'usps';
  f.enabled.checked = !!s.enabled;
  f.runHours.value = hoursStr(s.runHours);
  f.batchLimit.value = s.batchLimit ?? 80;
  f.preEnabled.checked = !!s.preEnabled;
  f.preRunHours.value = hoursStr(s.preRunHours);
  f.preBatchLimit.value = s.preBatchLimit ?? 40;
  f.alertEnabled.checked = !!s.alertEnabled;
  f.alertRunHours.value = hoursStr(s.alertRunHours);
  f.lateIntransitHours.value = s.lateIntransitHours ?? 48;
  f.lateDeliveredHours.value = s.lateDeliveredHours ?? 96;
  f.repeatHours.value = s.repeatHours ?? 12;
  f.windowDays.value = s.windowDays ?? 14;
  f.timezone.value = s.timezone || 'Asia/Ho_Chi_Minh';
}
loadSettingsForm();

async function saveSettings(e) {
  e.preventDefault();
  const f = document.getElementById('sf');
  const strToHours = s => (s||'').split(',').map(v=>parseInt(v.trim(),10)).filter(n=>!isNaN(n)&&n>=0&&n<=23);
  const patch = {
    apiBase: f.apiBase.value.trim(),
    carrierCode: f.carrierCode.value.trim() || 'usps',
    enabled: f.enabled.checked,
    runHours: strToHours(f.runHours.value),
    batchLimit: Number(f.batchLimit.value)||80,
    preEnabled: f.preEnabled.checked,
    preRunHours: strToHours(f.preRunHours.value),
    preBatchLimit: Number(f.preBatchLimit.value)||40,
    alertEnabled: f.alertEnabled.checked,
    alertRunHours: strToHours(f.alertRunHours.value),
    lateIntransitHours: Number(f.lateIntransitHours.value)||48,
    lateDeliveredHours: Number(f.lateDeliveredHours.value)||96,
    repeatHours: Number(f.repeatHours.value)||12,
    windowDays: Number(f.windowDays.value)||14,
    timezone: f.timezone.value.trim()||'Asia/Ho_Chi_Minh',
  };
  if (f.shipengineKey.value.trim()) patch.shipengineKey = f.shipengineKey.value.trim();
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
  addLog({ts:new Date().toISOString(),level:'ok',message:'Settings đã lưu & cron đã reschedule.'});
  loadSettingsForm();
}
</script>
</body>
</html>`;

// ── Orders HTML ───────────────────────────────────────────────────────────────
const ORDERS_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Orders — Cron Tracking PrimeHorizon</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#0f111a;color:#c8cdd9;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:100vh}
h1{font-size:17px;color:#e6eaf2}
a.back{font-size:12px;color:#4dabf7;text-decoration:none;padding:4px 10px;border:1px solid #2a2d3a;border-radius:5px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input[type=number]{background:#1a1d2e;border:1px solid #2a2d3a;border-radius:5px;padding:5px 10px;color:#e6eaf2;font-size:12px}
.btn{padding:6px 14px;border:1px solid #2a2d3a;border-radius:6px;background:#1a1d2e;color:#c8cdd9;cursor:pointer;font-size:12px}
.btn:hover{background:#252840}
.btn.primary{background:#1a3a5c;border-color:#1e4d7b;color:#4dabf7}
.total{color:#666;font-size:12px;margin-left:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 10px;color:#666;border-bottom:1px solid #1a1d2e;white-space:nowrap;font-weight:500}
td{padding:7px 10px;border-bottom:1px solid #141620;vertical-align:top}
tr:hover td{background:#141620}
.chip{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.chip.delivered{background:#1a3a2e;color:#74c69d}
.chip.in_transit{background:#1a2f4d;color:#4dabf7}
.chip.out_for_delivery{background:#3a3000;color:#ffd43b}
.chip.pre_shipment,.chip.unknown{background:#2a2d3a;color:#888}
.chip.alert,.chip.return_to_sender{background:#3a1a1a;color:#f77}
.chip.available_for_pickup{background:#2a3a1a;color:#95d47a}
.tracking{font-family:Menlo,monospace;font-size:11px;color:#aab}
.desc{color:#888;font-size:11px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pager{display:flex;gap:6px;align-items:center;justify-content:center;padding-top:4px}
.pager span{font-size:12px;color:#666}
#loading{color:#666;padding:20px;text-align:center}
</style>
</head>
<body>
<div style="display:flex;align-items:center;gap:12px">
  <h1>Orders — Tracking</h1>
  <a class="back" href="/">← Dashboard</a>
</div>
<div class="toolbar">
  <select id="statusFilter" onchange="load(1)">
    <option value="">Tất cả (đã check)</option>
    <option value="pre_shipment">Pre-Shipment</option>
    <option value="in_transit">In Transit</option>
    <option value="out_for_delivery">Out for Delivery</option>
    <option value="available_for_pickup">Available for Pickup</option>
    <option value="delivered">Delivered</option>
    <option value="alert">Alert</option>
    <option value="return_to_sender">Return to Sender</option>
  </select>
  <button class="btn primary" onclick="load(currentPage)">⟳ Refresh</button>
  <span class="total" id="totalLabel"></span>
</div>
<div id="loading">Đang tải…</div>
<table id="tbl" style="display:none">
  <thead>
    <tr>
      <th>#</th>
      <th>Etsy Order ID</th>
      <th>Buyer</th>
      <th>Store</th>
      <th>Tracking</th>
      <th>Status</th>
      <th>Mô tả</th>
      <th>Fulfilled</th>
      <th>Last Event</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
<div class="pager" id="pager" style="display:none">
  <button class="btn" id="btnPrev" onclick="load(currentPage-1)">‹ Trước</button>
  <span id="pageLabel"></span>
  <button class="btn" id="btnNext" onclick="load(currentPage+1)">Tiếp ›</button>
</div>
<script>
let currentPage = 1;
let totalPages = 1;
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt = iso => iso ? new Date(iso).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour12:false}) : '—';
const STATUS_LABELS = {
  pre_shipment:'Pre-Shipment', in_transit:'In Transit', out_for_delivery:'Out for Delivery',
  available_for_pickup:'For Pickup', delivered:'Delivered', alert:'Alert',
  return_to_sender:'Return', unknown:'Unknown'
};

async function load(page) {
  currentPage = Math.max(1, page || 1);
  const status = document.getElementById('statusFilter').value;
  document.getElementById('loading').style.display = 'block';
  document.getElementById('tbl').style.display = 'none';
  document.getElementById('pager').style.display = 'none';

  const params = new URLSearchParams({ page: currentPage, per_page: 50 });
  if (status) params.set('status', status);
  const r = await fetch('/api/orders?' + params).then(r=>r.json()).catch(()=>({ok:false}));

  document.getElementById('loading').style.display = 'none';
  if (!r.ok && r.success === false) {
    document.getElementById('loading').textContent = 'Lỗi: ' + (r.error || r.message || 'unknown');
    document.getElementById('loading').style.display = 'block';
    return;
  }

  const items = r.data?.items || [];
  const pagination = r.data?.pagination || {};
  totalPages = pagination.total_pages || 1;
  document.getElementById('totalLabel').textContent = 'Tổng: ' + (pagination.total || 0) + ' đơn';

  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#666;padding:20px">Không có đơn nào</td></tr>';
  } else {
    items.forEach((item, i) => {
      const st = item.status || 'unknown';
      const label = STATUS_LABELS[st] || st;
      tbody.innerHTML += '<tr>' +
        '<td style="color:#666">' + ((currentPage-1)*50 + i + 1) + '</td>' +
        '<td>' + esc(item.etsy_order_id || item.order_id) + '</td>' +
        '<td>' + esc(item.buyer_name || '—') + '</td>' +
        '<td>' + esc(item.store_name || '—') + '</td>' +
        '<td class="tracking">' + esc(item.tracking_number || '—') + (item.tracking_carrier ? '<br><span style="color:#555">'+esc(item.tracking_carrier)+'</span>' : '') + '</td>' +
        '<td><span class="chip ' + st + '">' + esc(label) + '</span></td>' +
        '<td class="desc" title="' + esc(item.status_description||'') + '">' + esc(item.status_description || '—') + '</td>' +
        '<td style="white-space:nowrap">' + fmt(item.fulfilled_at) + '</td>' +
        '<td style="white-space:nowrap">' + fmt(item.last_event_at) + '</td>' +
        '</tr>';
    });
  }

  document.getElementById('tbl').style.display = 'table';
  document.getElementById('pager').style.display = 'flex';
  document.getElementById('pageLabel').textContent = 'Trang ' + currentPage + ' / ' + totalPages;
  document.getElementById('btnPrev').disabled = currentPage <= 1;
  document.getElementById('btnNext').disabled = currentPage >= totalPages;
}

load(1);
</script>
</body>
</html>`;

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3500;

function startWebServer(sharedEmit) {
  // Nếu được gọi từ server.js, dùng emit dùng chung
  if (sharedEmit) {
    // Override pushLog để dùng emit từ ngoài
    Object.assign(module.exports, { pushLog: sharedEmit });
  }
  const server = http.createServer(router);
  server.listen(PORT, () => {
    pushLog('ok', `Web dashboard chạy tại http://0.0.0.0:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  startWebServer();
}

module.exports = { startWebServer, pushLog };
