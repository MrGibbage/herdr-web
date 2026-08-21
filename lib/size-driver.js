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
  //
  // Always kills and freshly respawns the hidden client rather than
  // resizing an existing one — tried resize() first (including a same-
  // size-nudge to force a real SIGWINCH), but a live test proved it
  // unreliable: after a competing client (a real herdr TUI on the
  // desktop) reclaims the runtime's shared foreground size, resizing our
  // existing process produced a garbage result (226x66 -- neither the
  // requested size nor anything else asked for), evidently racing with
  // herdr's own foreground arbitration. A fresh attach is unambiguous: a
  // brand new client connection reliably reclaims foreground, since
  // that's the normal case herdr is built around (a new terminal
  // attaching). Cheap enough to do on every call — this is a small Rust
  // binary and the caller already debounces requests client-side.
  setPaneSize(paneCols, paneRows) {
    if (!pty) return;
    const cols = Math.max(40, Math.min(140, paneCols + CHROME_COLS));
    const rows = Math.max(15, Math.min(70, paneRows + CHROME_ROWS));
    this.cols = cols;
    this.rows = rows;
    if (this.proc) this.proc.kill(); // its onExit is a closure over its own `proc` var — see below
    this._spawn();
  }

  _spawn() {
    if (this.stopped || !this.cols) return;
    let proc;
    try {
      proc = pty.spawn(HERDR_BIN, [], {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      jlog('error', 'spawn-failed', { error: e.message });
      this.proc = null;
      return;
    }
    this.proc = proc;
    jlog('info', 'spawned', { cols: this.cols, rows: this.rows, pid: proc.pid });
    proc.onData(() => {}); // discard rendered frames
    proc.onExit(({ exitCode }) => {
      // Compare against the closure's own `proc`, not `this.proc`: if
      // setPaneSize() already deliberately killed this one and spawned a
      // newer replacement in its place, this stale callback must not
      // clobber that newer process's reference or trigger a needless
      // second respawn.
      if (this.proc !== proc) return;
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
