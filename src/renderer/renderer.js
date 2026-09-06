// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`).classList.add('active');
  });
});

// ── Log ───────────────────────────────────────────────────────────────────────
const logBox = document.getElementById('logBox');
const MAX_LINES = 500;

function addLog({ ts, level, message }) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const time = new Date(ts).toLocaleTimeString('vi-VN');
  line.innerHTML = `<span class="log-ts">${time}</span>${escHtml(message)}`;
  logBox.appendChild(line);
  // Giữ tối đa MAX_LINES dòng
  while (logBox.children.length > MAX_LINES) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

document.getElementById('btnClearLog').addEventListener('click', () => { logBox.innerHTML = ''; });
window.api.onLog(addLog);

// ── Status badge ──────────────────────────────────────────────────────────────
const badge = document.getElementById('statusBadge');
const runBtns = ['btnRunMain','btnRunPre','btnRunAlert','btnRunAll'].map((id) => document.getElementById(id));

window.api.onStatus(({ running }) => {
  badge.textContent = running ? 'Running…' : 'Idle';
  badge.className = `badge ${running ? 'running' : 'idle'}`;
  runBtns.forEach((b) => { b.disabled = running; });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(data) {
  if (!data || data.error) return;
  document.getElementById('s_tracked').textContent = data.tracked ?? '—';
  document.getElementById('s_pre').textContent = data.pre_shipment ?? '—';
  document.getElementById('s_transit').textContent = data.in_transit ?? '—';
  document.getElementById('s_delivered').textContent = data.delivered ?? '—';
  document.getElementById('s_pending').textContent = data.pending ?? '—';

  const byStatus = document.getElementById('byStatus');
  byStatus.innerHTML = '';
  for (const [st, cnt] of Object.entries(data.by_status || {})) {
    const chip = document.createElement('span');
    chip.className = `status-chip ${st.replace(/[^a-z_]/g, '')}`;
    chip.textContent = `${st}: ${cnt}`;
    byStatus.appendChild(chip);
  }
}

window.api.onStats(renderStats);

async function refreshStats() {
  const data = await window.api.getStats();
  renderStats(data);
}
document.getElementById('btnRefresh').addEventListener('click', refreshStats);

// ── Run buttons ───────────────────────────────────────────────────────────────
document.getElementById('btnRunMain').addEventListener('click', () => window.api.runTracking('main'));
document.getElementById('btnRunPre').addEventListener('click', () => window.api.runTracking('pre'));
document.getElementById('btnRunAlert').addEventListener('click', () => window.api.runTracking('alert'));
document.getElementById('btnRunAll').addEventListener('click', () => {
  window.api.runTracking('main');
  window.api.runTracking('pre');
});

// ── Settings ──────────────────────────────────────────────────────────────────
const form = document.getElementById('settingsForm');

function hoursToStr(arr) { return (arr || []).join(','); }
function strToHours(s) {
  return (s || '').split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 23);
}

async function loadSettings() {
  const s = await window.api.getSettings();
  form.apiBase.value = s.apiBase || '';
  form.apiKey.value = s.apiKey || '';
  form.shipengineKey.value = s.shipengineKey || '';
  form.carrierCode.value = s.carrierCode || 'usps';
  form.enabled.checked = !!s.enabled;
  form.runHours.value = hoursToStr(s.runHours);
  form.batchLimit.value = s.batchLimit ?? 80;
  form.preEnabled.checked = !!s.preEnabled;
  form.preRunHours.value = hoursToStr(s.preRunHours);
  form.preBatchLimit.value = s.preBatchLimit ?? 40;
  form.alertEnabled.checked = !!s.alertEnabled;
  form.alertRunHours.value = hoursToStr(s.alertRunHours);
  form.lateIntransitHours.value = s.lateIntransitHours ?? 48;
  form.lateDeliveredHours.value = s.lateDeliveredHours ?? 96;
  form.repeatHours.value = s.repeatHours ?? 12;
  form.windowDays.value = s.windowDays ?? 14;
  form.timezone.value = s.timezone || 'Asia/Ho_Chi_Minh';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {
    apiBase: form.apiBase.value.trim(),
    apiKey: form.apiKey.value.trim(),
    shipengineKey: form.shipengineKey.value.trim(),
    carrierCode: form.carrierCode.value.trim() || 'usps',
    enabled: form.enabled.checked,
    runHours: strToHours(form.runHours.value),
    batchLimit: Number(form.batchLimit.value) || 80,
    preEnabled: form.preEnabled.checked,
    preRunHours: strToHours(form.preRunHours.value),
    preBatchLimit: Number(form.preBatchLimit.value) || 40,
    alertEnabled: form.alertEnabled.checked,
    alertRunHours: strToHours(form.alertRunHours.value),
    lateIntransitHours: Number(form.lateIntransitHours.value) || 48,
    lateDeliveredHours: Number(form.lateDeliveredHours.value) || 96,
    repeatHours: Number(form.repeatHours.value) || 12,
    windowDays: Number(form.windowDays.value) || 14,
    timezone: form.timezone.value.trim() || 'Asia/Ho_Chi_Minh',
  };
  await window.api.saveSettings(patch);
  addLog({ ts: Date.now(), level: 'ok', message: 'Settings đã lưu & cron đã reschedule.' });
});

// Init
loadSettings();
refreshStats();
