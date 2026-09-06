/**
 * Headless server mode — chạy trên Linux server không có display.
 * Đọc settings từ /app/settings.json hoặc ./settings.json.
 * Không cần Electron.
 *
 * Usage:
 *   node src/server.js
 *   hoặc via Docker: docker compose up
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { runCheck, runAlert, fetchStats } = require('./checker');

// ── Load settings ─────────────────────────────────────────────────────────────
const SETTINGS_PATHS = [
  '/app/settings.json',
  path.join(__dirname, '..', 'settings.json'),
];

function loadSettings() {
  for (const p of SETTINGS_PATHS) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

const settings = loadSettings();
if (!settings) {
  console.error('[server] Không tìm thấy settings.json. Tạo file settings.json trước khi chạy.');
  console.error('  Xem settings.example.json để biết format.');
  process.exit(1);
}

if (!settings.apiBase || !settings.apiKey) {
  console.error('[server] settings.json thiếu apiBase hoặc apiKey.');
  process.exit(1);
}
if (!settings.shipengineKey) {
  console.error('[server] settings.json thiếu shipengineKey.');
  process.exit(1);
}

// ── Logger ────────────────────────────────────────────────────────────────────
function emit(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
}

// ── Guards chống overlap ───────────────────────────────────────────────────────
const running = { main: false, pre: false, alert: false };

async function doRun(kind) {
  if (running[kind]) { emit('info', `[${kind}] đang chạy — bỏ qua lần này.`); return; }
  running[kind] = true;
  try {
    const s = loadSettings() || settings;
    if (kind === 'alert') {
      await runAlert(s, emit, 'cron');
    } else {
      await runCheck(s, emit, 'cron', kind);
    }
  } catch (err) {
    emit('error', `[${kind}] unhandled: ${err.message}`);
  } finally {
    running[kind] = false;
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────
const tz = settings.timezone || 'Asia/Ho_Chi_Minh';
const tasks = [];

function scheduleKind(kind, hours, enabled) {
  if (!enabled) { emit('info', `[${kind}] cron TẮT.`); return; }
  if (!hours || !hours.length) { emit('info', `[${kind}] chưa có giờ chạy.`); return; }
  const expr = `0 ${hours.join(',')} * * *`;
  if (!cron.validate(expr)) { emit('error', `[${kind}] cron expr lỗi: ${expr}`); return; }
  tasks.push(cron.schedule(expr, () => doRun(kind), { timezone: tz }));
  emit('info', `[${kind}] lên lịch: ${hours.map((h) => `${h}h`).join(', ')} (${tz})`);
}

scheduleKind('main', settings.runHours, settings.enabled !== false);
scheduleKind('pre', settings.preRunHours, settings.preEnabled !== false);
scheduleKind('alert', settings.alertRunHours, settings.alertEnabled !== false);

// ── Web dashboard ─────────────────────────────────────────────────────────────
const { startWebServer, pushLog } = require('./web');
startWebServer(emit);

// Stats on start
fetchStats(settings).then((s) => {
  emit('info', `Stats: tracked=${s.tracked} in_transit=${s.in_transit} delivered=${s.delivered} pending=${s.pending}`);
}).catch(() => { emit('warn', 'Không lấy được stats từ API'); });

emit('info', '=== crontrackingprime server started ===');

// Graceful shutdown
process.on('SIGTERM', () => { tasks.forEach((t) => t.stop()); process.exit(0); });
process.on('SIGINT', () => { tasks.forEach((t) => t.stop()); process.exit(0); });
