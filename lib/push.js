// Web Push: VAPID keys (from /etc/homelab/herdr-web.env, same pattern as
// every other homelab service secret — see scripts/plugin-start.sh, which
// sources that file before node starts) + a local subscription store (not
// a secret — just browser-issued endpoint/key tuples, kept separate from
// lib/settings.js because /api/settings echoes its whole file back to any
// client).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { DIR } = require('./settings');

const FILE = path.join(DIR, 'push-subscriptions.json');

function loadSubscriptions() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).subscriptions || [];
  } catch {
    return [];
  }
}

let subscriptions = loadSubscriptions();

function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ subscriptions }, null, 2));
}

// Never generates or persists key material itself — if
// /etc/homelab/herdr-web.env hasn't been provisioned yet, push is simply
// disabled (getPublicKey() returns null, notifyAll() no-ops) rather than
// silently minting new keys nobody's aware of.
function ensureVapid(subject) {
  const publicKey = process.env.HERDR_WEB_VAPID_PUBLIC_KEY;
  const privateKey = process.env.HERDR_WEB_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return publicKey;
}

function getPublicKey() {
  return process.env.HERDR_WEB_VAPID_PUBLIC_KEY || null;
}

function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    persist();
  }
  return true;
}

function removeSubscription(endpoint) {
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) persist();
}

// Best-effort fan-out. Dead subscriptions (404/410 — uninstalled, site data
// cleared, browser reinstalled) are dropped; any other failure is recorded
// per-subscription rather than thrown, so one bad subscription can't block
// the rest, and the caller gets a real answer instead of just "no error
// means it worked" (there was no success-path logging before this).
async function notifyAll(payload, { ttlSeconds = 6 * 3600, urgency = 'high' } = {}) {
  if (!subscriptions.length) return { attempted: 0, sent: 0, disabled: !process.env.HERDR_WEB_VAPID_PRIVATE_KEY };
  const data = JSON.stringify(payload);
  const results = await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, data, { TTL: ttlSeconds, urgency });
      return { ok: true };
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) removeSubscription(sub.endpoint);
      return { ok: false, error: e.message };
    }
  }));
  return {
    attempted: results.length,
    sent: results.filter((r) => r.ok).length,
    errors: results.filter((r) => !r.ok).map((r) => r.error),
  };
}

module.exports = { ensureVapid, getPublicKey, addSubscription, removeSubscription, notifyAll, FILE };
