// Drives the herdr runtime size. The JSON socket API cannot resize the
// headless runtime (fixed 80x24) — but the runtime follows the foreground
// attached client's terminal size. So we keep a real `herdr` TUI client
// alive inside a node-pty and resize that pty to what the web UI wants.
// Calibration (herdr 0.7.5, sidebar hidden): pane = (cols-1) x (rows-2).
'use strict';

// node-pty is optional (native build): without it the herdr runtime stays at
// its 80x24 headless default instead of following the phone's viewport.
let pty = null;
try { pty = require('node-pty'); } catch (e) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', module: 'size-driver', event: 'node-pty-unavailable', detail: 'runtime size fixed at 80x24', error: e.message }));
}

// `herdr` is typically installed to ~/.local/bin, which is on an
// interactive shell's PATH but NOT on the minimal PATH a process started
// via the plugin startup hook (or systemd) inherits — bare pty.spawn('herdr')
// then fails instantly with execvp ENOENT, indistinguishable in the logs
// from a real herdr-side rejection (that's what this repo's own PLAN.md
// initially misdiagnosed as the nested-herdr guard). Resolve a real path
// once at load time instead of trusting PATH.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function resolveHerdrBin() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'herdr'), '/usr/local/bin/herdr'];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
  }
  return 'herdr'; // fall back to PATH lookup for other install layouts
}
const HERDR_BIN = resolveHerdrBin();

const CHROME_COLS = 1;
const CHROME_ROWS = 2;

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'size-driver', event, ...extra }));
}

class SizeDriver {
  constructor() {
    this.proc = null;
    this.cols = 0;
    this.rows = 0;
    this.stopped = false;
  }

  // Desired PANE size; chrome offsets are added here.
  setPaneSize(paneCols, paneRows) {
    if (!pty) return;
    const cols = Math.max(40, Math.min(140, paneCols + CHROME_COLS));
    const rows = Math.max(15, Math.min(70, paneRows + CHROME_ROWS));
    if (cols === this.cols && rows === this.rows && this.proc) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.proc) this._spawn();
    else {
      try { this.proc.resize(cols, rows); jlog('info', 'resized', { cols, rows }); }
      catch (e) { jlog('error', 'resize-failed', { error: e.message }); this._respawn(); }
    }
  }

  _spawn() {
    if (this.stopped || !this.cols) return;
    try {
      this.proc = pty.spawn(HERDR_BIN, [], {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      jlog('error', 'spawn-failed', { error: e.message });
      this.proc = null;
      return;
    }
    jlog('info', 'spawned', { cols: this.cols, rows: this.rows, pid: this.proc.pid });
    this.proc.onData(() => {}); // discard rendered frames
    this.proc.onExit(({ exitCode }) => {
      jlog('warn', 'client-exited', { exitCode });
      this.proc = null;
      this._respawn();
    });
  }

  _respawn() {
    if (this.stopped || this._respawnTimer) return;
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (!this.proc) this._spawn();
    }, 2000);
  }

  stop() {
    this.stopped = true;
    if (this._respawnTimer) clearTimeout(this._respawnTimer);
    this.proc?.kill();
    this.proc = null;
  }
}

module.exports = { SizeDriver };
