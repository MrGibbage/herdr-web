// Server-synced settings: one JSON file in the config dir, readable and
// writable over HTTP. Single user, so phone and desktop deliberately share the
// same values (per-device preferences belong in the browser's localStorage).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.HERDR_WEB_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr-web');
const FILE = path.join(DIR, 'settings.json');

const DEFAULTS = {
  // What to run when a session is created with "start an agent" — typed into
  // the pane's interactive shell, so your own aliases/wrappers work (e.g.
  // `ccpc`, which pins a model), not just binaries on PATH.
  agentCommand: 'claude',
  // Offered as one-tap chips in Settings; edit freely.
  agentCommandPresets: ['claude', 'ccpc', 'claude --continue', 'codex'],
  // Prefill for the new-session directory field.
  defaultCwd: '',
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  // Keep the file to known keys so a stray client cannot grow it unbounded.
  const clean = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, next[k]]));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { load, save, DEFAULTS, FILE, DIR };
