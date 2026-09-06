/**
 * Settings — lưu vào electron userData (persistent across restarts).
 * Không dùng .env để người dùng cấu hình qua UI.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  // PrimeHorizon API
  apiBase: 'http://localhost:5102',  // be-tool URL
  apiKey: '',                         // X-API-Key (etsy_...)

  // ShipEngine
  shipengineKey: '',
  carrierCode: 'usps',

  // Cron schedules — giờ chạy trong ngày (0-23)
  // main: đơn đã in_transit
  enabled: true,
  runHours: [0, 6, 12, 18],
  batchLimit: 80,

  // pre: đơn chưa in_transit (dày hơn)
  preEnabled: true,
  preRunHours: [0, 3, 6, 9, 12, 15, 18, 21],
  preBatchLimit: 40,

  // Alert cron
  alertEnabled: true,
  alertRunHours: [7, 13, 19],
  lateIntransitHours: 48,
  lateDeliveredHours: 96,
  repeatHours: 12,
  windowDays: 14,

  timezone: 'Asia/Ho_Chi_Minh',
};

function getSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { getSettings, saveSettings };
