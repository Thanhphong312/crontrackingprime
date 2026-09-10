/**
 * ShipEngine tracking — linh hoạt theo USPS statuses.
 *
 * STATUS_MAP: ShipEngine status_code → tên USPS chuẩn.
 * Mã KHÔNG có trong map được giữ nguyên (lowercase) thay vì ép về cứng.
 * Đây là điểm khác biệt với BullStart: không có "default = pre_shipment".
 */
const axios = require('axios');

const STATUS_MAP = {
  DE: 'delivered',
  SP: 'delivered',           // delivered to parcel locker
  IT: 'in_transit',
  AC: 'pre_shipment',       // accepted by carrier
  AT: 'in_transit',          // delivery attempted
  EX: 'alert',               // exception
  NY: 'pre_shipment',        // not yet in system
  DY: 'out_for_delivery',
  UN: 'pre_shipment',        // unknown
  RS: 'return_to_sender',
  AP: 'available_for_pickup',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trackOne(trackingNumber, carrier, apiKey, attempt = 0) {
  try {
    const params = { tracking_number: trackingNumber };
    if (carrier) params.carrier_code = carrier;
    const res = await axios.get('https://api.shipengine.com/v1/tracking', {
      params,
      headers: { 'API-Key': apiKey },
      timeout: 20000,
    });
    const d = res.data || {};
    const rawCode = (d.status_code || '').toUpperCase();

    // Events: oldest-first để events[2] là scan thứ 3 đáng tin cậy
    const events = (d.events || [])
      .map((e) => ({
        occurred_at: e.occurred_at || null,
        description: e.description || '',
        city_locality: e.city_locality || null,
        state_province: e.state_province || null,
        country_code: e.country_code || null,
        status_code: e.status_code || null,
      }))
      .sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')));

    // Ánh xạ: mã đã biết → chuẩn; mã lạ → lowercase của mã gốc (không mất thông tin)
    let status = STATUS_MAP[rawCode] || (rawCode ? rawCode.toLowerCase() : 'unknown');

    // Override: actual_delivery_date → delivered chắc chắn
    if (d.actual_delivery_date) status = 'delivered';
    // >= 3 events + vẫn là pre_shipment → thực tế đang di chuyển
    if (events.length >= 3 && ['pre_shipment', 'unknown'].includes(status)) {
      status = 'in_transit';
    }

    return {
      success: true,
      tracking_number: trackingNumber,
      carrier,
      raw_status_code: rawCode,
      status,
      status_description: d.status_description || '',
      carrier_status_description: d.carrier_status_description || null,
      estimated_delivery_date: d.estimated_delivery_date || null,
      actual_delivery_date: d.actual_delivery_date || null,
      events_count: events.length,
      events,
      last_event_at: events.length ? events[events.length - 1].occurred_at : null,
      third_event_at: events.length >= 3 ? events[2].occurred_at : null,
    };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && attempt < 5) {
      const retryAfter = Number(err.response?.headers?.['retry-after']);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 500 * 2 ** attempt);
      await sleep(waitMs);
      return trackOne(trackingNumber, carrier, apiKey, attempt + 1);
    }
    const errMsg = err.response?.data?.errors?.[0]?.message || err.message || '';
    // carrier_code không hợp lệ → retry không có carrier_code (ShipEngine tự detect)
    if (carrier && errMsg.toLowerCase().includes('carrier_code') && attempt === 0) {
      return trackOne(trackingNumber, null, apiKey, 1);
    }
    return {
      success: false,
      tracking_number: trackingNumber,
      error: errMsg,
    };
  }
}

module.exports = { trackOne };
