/**
 * Wrapper gọi PrimeHorizon API (be-tool).
 */
const axios = require('axios');

function client(settings) {
  return axios.create({
    baseURL: settings.apiBase,
    timeout: 30000,
  });
}

async function getPending(settings, kind, limit) {
  const res = await client(settings).get('/api/tracking-poll/pending', {
    params: { kind, limit },
  });
  return res.data?.data?.items || [];
}

async function postUpdate(settings, results) {
  const res = await client(settings).post('/api/tracking-poll/update', { results });
  return res.data?.data || {};
}

async function getStats(settings) {
  const res = await client(settings).get('/api/tracking-poll/stats');
  return res.data?.data || {};
}

async function postAlert(settings, thresholds) {
  const res = await client(settings).post('/api/tracking-poll/alert', thresholds);
  return res.data?.data || {};
}

module.exports = { getPending, postUpdate, getStats, postAlert };
