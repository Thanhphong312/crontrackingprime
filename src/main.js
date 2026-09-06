const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const cron = require('node-cron');
const { getSettings, saveSettings } = require('./settings');
const { runCheck, runAlert, fetchStats } = require('./checker');

let win = null;
const tasks = { main: null, pre: null, alert: null };
const running = { main: false, pre: false, alert: false };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function emit(level, message) {
  send('log', { ts: Date.now(), level, message });
}
function anyRunning() {
  return running.main || running.pre || running.alert;
}

async function pushStats() {
  try {
    const s = getSettings();
    if (!s.apiBase || !s.apiKey) return;
    send('stats', await fetchStats(s));
  } catch { /* best-effort */ }
}

async function doRun(reason, kind) {
  if (kind === 'alert') {
    if (running.alert) { emit('info', '[alert] đang chạy — bỏ qua.'); return; }
    running.alert = true;
    send('status', { running: true });
    try { await runAlert(getSettings(), emit, reason); await pushStats(); }
    catch (err) { emit('error', `[alert] ${err.message}`); }
    finally { running.alert = false; send('status', { running: anyRunning() }); }
    return;
  }
  if (running[kind]) { emit('info', `[${kind}] đang chạy — bỏ qua.`); return; }
  running[kind] = true;
  send('status', { running: true });
  try { await runCheck(getSettings(), emit, reason, kind); await pushStats(); }
  catch (err) { emit('error', `[${kind}] ${err.message}`); }
  finally { running[kind] = false; send('status', { running: anyRunning() }); }
}

function scheduleOne(kind, hours, enabled, timezone) {
  if (tasks[kind]) { tasks[kind].stop(); tasks[kind] = null; }
  if (!enabled) { emit('info', `[${kind}] cron đang TẮT.`); return; }
  if (!hours || !hours.length) { emit('info', `[${kind}] chưa chọn giờ chạy.`); return; }
  const expr = `0 ${hours.join(',')} * * *`;
  if (!cron.validate(expr)) { emit('error', `[${kind}] cron expr lỗi: ${expr}`); return; }
  tasks[kind] = cron.schedule(expr, () => doRun('cron', kind), { timezone });
  emit('info', `[${kind}] đã lên lịch: ${hours.map((h) => `${h}h`).join(', ')} (${timezone})`);
}

function reschedule() {
  const s = getSettings();
  scheduleOne('main', s.runHours, s.enabled, s.timezone);
  scheduleOne('pre', s.preRunHours, s.preEnabled, s.timezone);
  scheduleOne('alert', s.alertRunHours, s.alertEnabled, s.timezone);
}

function createWindow() {
  win = new BrowserWindow({
    width: 820, height: 820,
    title: 'Cron Tracking PrimeHorizon',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => { reschedule(); pushStats(); });
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:save', (_e, patch) => {
  const s = saveSettings(patch);
  reschedule();
  return s;
});
ipcMain.handle('tracking:run', (_e, kind) => {
  if (kind === 'main' || kind === 'pre' || kind === 'alert') doRun('manual', kind);
  else { doRun('manual', 'main'); doRun('manual', 'pre'); }
  return true;
});
ipcMain.handle('tracking:stats', async () => {
  try { return await fetchStats(getSettings()); } catch (e) { return { error: e.message }; }
});
