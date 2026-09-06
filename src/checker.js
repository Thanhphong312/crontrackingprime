/**
 * Checker — poll ShipEngine rồi POST kết quả về PrimeHorizon API.
 *
 * Hai kind độc lập (điều kiện disjoint, không double-process):
 *   pre   — đơn fulfilled + có tracking, chưa vào transit
 *   main  — đơn đã in_transit, chưa delivered
 */
const { getPending, postUpdate, getStats } = require('./api');
const { trackOne } = require('./shipengine');

const CHUNK = 8;
const CHUNK_DELAY_MS = 1200;

async function runCheck(settings, emit, reason = 'cron', kind = 'main') {
  if (!settings.shipengineKey) { emit('error', 'Chưa nhập ShipEngine API key'); return null; }
  if (!settings.apiBase) { emit('error', 'Chưa cấu hình API Base'); return null; }

  const isPre = kind === 'pre';
  const tag = `${kind}·${reason}`;
  const limit = Number(isPre ? settings.preBatchLimit : settings.batchLimit) || 100;

  emit('info', `[${tag}] lấy đơn cần check từ PrimeHorizon…`);

  let orders;
  try {
    orders = await getPending(settings, kind, limit);
  } catch (err) {
    emit('error', `[${tag}] Lỗi lấy đơn: ${err.response?.data?.message || err.message}`);
    return null;
  }

  if (!orders.length) { emit('ok', `[${tag}] không có đơn cần check.`); return { checked: 0, changed: 0, delivered: 0, errors: 0 }; }
  emit('info', `[${tag}] ${orders.length} đơn…`);

  const totals = { checked: 0, changed: 0, delivered: 0, errors: 0 };

  for (let i = 0; i < orders.length; i += CHUNK) {
    const chunk = orders.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map((o) => trackOne(o.tracking_number, settings.carrierCode || 'usps', settings.shipengineKey)),
    );

    // Attach order_id vào mỗi kết quả
    const payload = [];
    for (let j = 0; j < chunk.length; j++) {
      const order = chunk[j];
      const res = results[j];
      if (!res || !res.success) {
        totals.errors++;
        emit('error', `  ${order.etsy_order_id || order.id}: ${res?.error || 'no result'}`);
        continue;
      }
      payload.push({ order_id: order.id, ...res });
      totals.checked++;
      if (res.status === 'delivered') totals.delivered++;
    }

    if (payload.length) {
      try {
        const r = await postUpdate(settings, payload);
        totals.changed += r.updated || 0;
      } catch (err) {
        emit('error', `  POST update lỗi: ${err.response?.data?.message || err.message}`);
      }
    }

    emit('info', `  …${Math.min(i + CHUNK, orders.length)}/${orders.length}`);
    if (i + CHUNK < orders.length) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  emit('ok', `[${tag}] xong: checked ${totals.checked}, delivered ${totals.delivered}, errors ${totals.errors}`);
  return totals;
}

async function runAlert(settings, emit, reason = 'cron') {
  if (!settings.apiBase) { emit('error', 'Chưa cấu hình API Base'); return null; }
  const { postAlert } = require('./api');
  emit('info', `[alert·${reason}] kiểm đơn tracking bị kẹt…`);
  try {
    const r = await postAlert(settings, {
      late_intransit_hours: settings.lateIntransitHours,
      late_delivered_hours: settings.lateDeliveredHours,
      repeat_hours: settings.repeatHours,
      window_days: settings.windowDays,
    });
    emit('ok', `[alert] late_intransit=${r.late_intransit || 0} late_delivered=${r.late_delivered || 0} skipped=${r.skipped || 0}`);
    return r;
  } catch (err) {
    emit('error', `[alert] lỗi: ${err.response?.data?.message || err.message}`);
    return null;
  }
}

async function fetchStats(settings) {
  return getStats(settings);
}

module.exports = { runCheck, runAlert, fetchStats };
