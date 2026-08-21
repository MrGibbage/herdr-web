// Web Push: VAPID keys + subscription store, kept out of lib/settings.js on
// purpose — /api/settings echoes its whole file back to any client, and the
// VAPID private key must never reach a browser. Stored in its own file
// (push.json, mode 0600) in the same config dir.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { DIR } = require('./settings');

const FILE = path.join(DIR, 'push.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { vapid: raw.vapid || null, subject: raw.subject || null, subscriptions: raw.subscriptions || [] };
  } catch {
    return { vapid: null, subject: null, subscriptions: [] };
  }
}

let state = load();

function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// Generates the keypair on first run and persists it — the private key is
// never logged or returned from any HTTP endpoint. Idempotent: subsequent
// calls just re-apply the existing keys to the webpush module (needed once
// per process).
function ensureVapid(subject) {
  if (!state.vapid) {
    state.vapid = webpush.generateVAPIDKeys();
    state.subject = subject;
    persist();
  }
  webpush.setVapidDetails(state.subject || subject, state.vapid.publicKey, state.vapid.privateKey);
  return state.vapid.publicKey;
}

function getPublicKey() {
  return state.vapid?.publicKey || null;
}

function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  if (!state.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    state.subscriptions.push(sub);
    persist();
  }
  return true;
}

function removeSubscription(endpoint) {
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (state.subscriptions.length !== before) persist();
}

// Best-effort fan-out. Dead subscriptions (404/410 — uninstalled, site data
// cleared, browser reinstalled) are dropped; any other failure is swallowed
// so one bad subscription can't block the rest.
async function notifyAll(payload, { ttlSeconds = 6 * 3600, urgency = 'high' } = {}) {
  if (!state.subscriptions.length) return;
  const data = JSON.stringify(payload);
  await Promise.all(state.subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, data, { TTL: ttlSeconds, urgency });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) removeSubscription(sub.endpoint);
      else throw e;
    }
  }));
}

module.exports = { ensureVapid, getPublicKey, addSubscription, removeSubscription, notifyAll, FILE };
