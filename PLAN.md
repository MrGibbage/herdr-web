# Plan: forking herdr-web for real push notifications

## Font-size / horizontal-scroll bug — fixed (2026-08-21)

Skip's actual complaint: even at the smallest font size (A− control),
panes still needed horizontal scrolling on the phone. Root cause was
**not** what it first looked like:

- First hypothesis (wrong-ish): `size-driver.js`'s hidden resize-driving
  `herdr` client kept crashing (`client-exited exitCode 1` every ~2s,
  forever) because this session itself runs inside a herdr pane, and
  herdr refuses to launch nested by default
  (`experimental.allow_nested`, default `false` — see
  https://herdr.dev/docs/config-reference/). Enabled it in
  `~/.config/herdr/config.toml` (that file is **not** part of this repo —
  noted here since there's nowhere else it'd be remembered). This was a
  real, legitimate fix, but turned out to be secondary.
- **Actual blocker**: after enabling `allow_nested`, the crash loop
  continued identically. Reproducing `size-driver.js`'s exact
  `pty.spawn()` call standalone (capturing output it normally discards)
  showed the real error: `execvp(3) failed.: No such file or directory`.
  `herdr` is installed at `~/.local/bin/herdr`, which is on an
  interactive shell's PATH but **not** on the minimal PATH a process
  started via the plugin startup hook inherits (confirmed via
  `/proc/<pid>/environ`: no `~/.local/bin` in `PATH`). `size-driver.js`
  spawned the bare command name, so every attempt failed instantly with
  the exact same exit code (1) as the nested-herdr rejection would have
  — the two failure modes were indistinguishable from the logs alone,
  which is why the first hypothesis looked plausible and had to be ruled
  out by actually reproducing the spawn rather than trusting the log
  pattern.
- Fixed in `lib/size-driver.js`: resolve `herdr`'s real path
  (`~/.local/bin/herdr`, falling back to PATH lookup) once at load time
  instead of trusting `PATH`. Verified: the hidden client now stays alive
  under a real resize instead of exiting within the same millisecond it
  spawned.

Both fixes were necessary — `allow_nested` alone wasn't sufficient (the
PATH bug would have kept killing it regardless), and the PATH fix alone
wouldn't have helped either (nested rejection would have kicked in next).
`shrinkToFit()`'s guard (`if (fontSize) return`, which fully disables the
font-safety-net once a size is manually chosen) is still a latent
secondary issue noted from the original diagnosis, deliberately left
alone since the primary fix may make it moot — revisit only if scrolling
persists.

## Round 2: foreground contention (2026-08-21, same day)

First phone retest partially worked and surfaced a real second bug.
Skip's report: touched the phone, wrapped perfectly, no horizontal
scroll (correct). Vertical scroll also didn't move (separately concerning
— see below, not yet root-caused). Then he moved his desktop mouse, and
the phone view un-wrapped — his real desktop herdr TUI reclaiming the
runtime's shared frame size, which is an architecture reality (herdr has
exactly one shared runtime size, following whichever attached client is
"foreground" — the docs already flag this: "if someone attaches a real
herdr TUI at a bigger terminal, panes grow"). Going back to the phone,
and even refreshing, never re-wrapped.

Reproduced the *exact* sequence synthetically (spawn a real narrow hidden
client, spawn a competing wide `herdr` client via node-pty to simulate
the desktop reclaiming foreground, kill the competitor, then re-request
the original narrow size the way a reconnecting phone would) and found
two independent stale caches, both treating "the size we last asked for"
as ground truth with no way to notice a third party changed it:

- **Client** (`index.html`): `fitCols` never got compared against the
  *actual* rendered width, only against what it remembered asking for —
  fixed by comparing `screenW(rows)` (already used elsewhere in this file
  for a similar purpose) against `fitCols` on every incoming screen and
  dropping the cache on drift.
- **Server** (`size-driver.js`): `setPaneSize()` skipped acting whenever
  the requested size matched its own cache. First attempt: keep resizing
  the *existing* process, adding a same-size "nudge" (resize to cols+1
  then back) to force a real SIGWINCH — tested live, and it produced a
  garbage result (226×66, matching neither the requested size nor
  anything else asked for), clearly racing with herdr's own foreground
  arbitration in a way not worth reverse-engineering further. Replaced
  with kill+respawn: always kill the existing hidden client and attach a
  completely fresh one. A new attachment reliably reclaims foreground
  (it's the case herdr is built around), and respawning a small Rust
  binary on a debounced, human-triggered event is cheap. Fixed a real
  race this introduced along the way — the old process's `onExit`
  closure captured `this.proc` instead of its own `proc` variable, so an
  async exit event landing after a newer process was already spawned
  would wrongly null out the *new* process's reference.

Verified via the full synthetic repro: narrow (42 wide) → wide competitor
takes over and **stays stuck wide** even after the competitor dies
(matching Skip's report exactly, unlike an earlier test run where it
auto-reverted) → re-request narrow → back to 42, confirmed via `herdr
pane layout`, no leaked processes.

**Retested on the real phone — still broken.** The synthetic repro above
only exercised the server-side fix (a raw script sending WS messages
directly bypasses all of index.html's client-side state entirely). The
real gap: `sendFit()` — the same always-resize-no-questions-asked
function that runs on WS reconnect (`ws.onopen`) — never got called on
the actual "coming back to the phone" moment, because the WS connection
typically stays alive across a brief backgrounding (no reconnect, so
`ws.onopen` never re-fires). There was already a `visibilitychange`
listener for exactly that moment, but it only did `markSeen()`/
`pinBottom()`. Added a `sendFit()` call there directly — deterministic,
not a heuristic, unlike the `onScreen()` drift-detection fix above (which
depends on the currently visible content happening to contain a
full-width row to notice anything changed — real but insufficient alone).
Not yet re-verified on the phone (requires a page reload to pick up the
new JS, then testing "switch to desktop, back to phone" without
reloading in between, to exercise this exact path).

Still open: the vertical-scroll-didn't-move report from the same test
session — not yet root-caused at all.

## Round 3: the drift-detection fix was itself the bug (2026-08-21, same day)

Skip retested: refresh now mostly fixes left-right wrapping (progress),
but vertical scroll got *worse* — "can scroll up a bit, see a couple of
messages, then it usually gets stuck" at the bottom. He sent two phone
screenshots (desktop-focused vs. phone-focused) with the temporary debug
overlay visible:

- Both showed `fitCols=0` — 16 seconds apart.
- Both showed real overflow (`sH` well above `cH` in both), ruling out
  "nothing to scroll into" as the explanation.
- Server logs showed the exact same size (53×37) being respawned several
  times within under a second, repeatedly, over minutes.

Root cause: **the "Round 2" client-side drift-detection heuristic from
directly above was itself broken and actively harmful.** It compared
`screenW(rows)` (the widest *currently visible* line) against `fitCols`
and reset the cache on any mismatch — but ordinary short lines routinely
measure narrower than the real column count, so it was constantly
"detecting drift" that wasn't real. That defeated `negotiateCols()`'s own
throttle and triggered a fresh kill+respawn of the hidden client on
nearly every screen update (every ~300ms poll). A respawn storm several
times a second means the runtime never settles, each one sets
`awaitingRewrap` and refetches scrollback, and scroll-position math
running that often has plenty of chances to fight a mid-gesture scroll —
very likely explaining the "scrolls a bit then snaps back" symptom
directly, not a separate bug.

**Removed the heuristic entirely.** `visibilitychange` → `sendFit()`
(with its 600ms retry) is the correct fix for the actual scenario it was
trying to solve, and fires once on a real event rather than continuously
on every poll — it doesn't share this failure mode. Temporary debug
overlay (`sH`/`cH`/`scrollTop`/`hist`/`live`/`fitCols`, top-left corner)
left in place for one more round of verification.

Not yet re-verified: whether removing the storm fixes vertical scroll,
and whether `visibilitychange` alone (without the removed heuristic) is
sufficient for the desktop→phone re-wrap case.

Source: https://github.com/eyalev/herdr-web, cloned into this dir 2026-08-20.
Upstream is MIT, single dev, small (~3,050 lines total: `server.js` (409) +
`lib/*.js` (~950) + `public/index.html` (1,695, single file, no build step,
no framework — vanilla JS in one `<script>` tag)). No `node_modules`, no
bundler, no CI. This is far more mature than the marketplace listing (2
stars) suggested — read the README before assuming it's a toy.

**Deployment target (confirmed): docker-server, permanently.** herdr-web
must run on the same machine as the herdr daemon (`~/.config/herdr/herdr.sock`
is a local Unix socket, not reachable remotely), and herdr itself is
limited to docker-server for this project — so this checkout stays here,
no relocation step needed.

## What's already solid — don't touch

- Live terminal view via `pane.read visible/ansi` polling + `scroll_changed`
  push, rendered as native DOM rows (no xterm). Agent-status tabs, quick
  keys, font-size control, directory picker, an integrated browser (iframe
  preview + CDP screencast cast). All of this is well-engineered and
  documented (`docs/socket-api-notes.md` is a genuinely useful empirical
  writeup of herdr's JSON socket API — read it before touching `server.js`).
- **PWA installability is already done**: `public/manifest.webmanifest` +
  `public/sw.js` exist, the service worker is deliberately cache-nothing
  (network-only fetch passthrough — a documented lesson from a sibling
  project, tmux-web), and it has a `notificationclick` handler that focuses
  the app and jumps to the right pane. So the thing I described last time as
  "add a PWA manifest/service worker" is a no-op — it's there.
- Transport model: binds `127.0.0.1` only, no auth, and says so explicitly
  in a comment (`server.js:22-24`) and the README. Recommended exposure is
  `tailscale serve --bg --https=17930 ...`. This matches how we already do
  remote access elsewhere in the homelab — keep it, don't add our own auth
  layer on top for now.

## The actual gap: notifications are foreground-only

`sw.js` has no `push` event handler and there's no VAPID/subscription
plumbing anywhere in `server.js` or `lib/`. The "background system
notification" demo (`docs/demos/background-notification.md`) is the
in-page `Notification` API fired while the PWA process is still alive in
the background (tab/app backgrounded, OS process alive) — not real Web
Push. That means: phone screen off with the browser tab still resident,
you get the ping. Browser/PWA fully swiped away or phone rebooted, you
won't, because nothing is subscribed to push and nothing on the server can
wake a closed client.

This is the one piece that maps to what I liked about `herdr-mobile-relay`
(push that reaches you with the app *closed*), and it's the one piece
worth actually building. It's a well-trodden pattern, not a research
problem — a day of focused work, not "especially hard":

1. Generate a VAPID keypair (`web-push` npm package has a CLI for this),
   store the private key in `~/.config/herdr-web/settings.json` next to the
   existing settings (`lib/settings.js` already has load/save — extend it).
   VAPID also wants a subject (contact info the push service can use) —
   use a URL (e.g. a pelorus.org address), not a personal email; Skip has
   no preference beyond that, so any stable URL we control is fine.
2. `public/sw.js` gains a `push` event handler that shows a notification
   from the payload (pane id + status), reusing the existing
   `notificationclick` handler as-is.
3. Client subscribes via `PushManager.subscribe(...)` with the VAPID public
   key on first load (after notification permission is granted — same
   permission prompt path that already exists), POSTs the subscription to a
   new `/api/push/subscribe` endpoint, stored server-side.
4. Subscriptions go stale (browser reinstall, site data cleared, Chrome
   update) — `web-push`'s `sendNotification` throws with a 404/410 status
   for a dead subscription. Catch that specifically and drop the stored
   subscription server-side rather than erroring on every future block
   event; log/ignore other send failures without crashing the event
   handler (same non-fatal style as the rest of `server.js`).
5. In `server.js`, the existing `pane.agent_status_changed` handler
   (currently just `broadcast(...)`) also calls `web-push`'s `sendNotification`
   — **gated on presence, not just status**:
   - Trigger only on transition *to* `blocked` (an agent stalled on a
     permission prompt, genuinely needs a human). Not `done` — a `done`
     trigger would fire on every finished turn, including plain back-and-forth
     conversation, which is exactly the "dings on everything" outcome we
     don't want. Skip confirmed: no interest in a chatty version of this.
   - Track the **last status we actually pushed for, per pane** (in-memory
     is enough, alongside the existing `state`/`watchers` maps) and only
     push again once that pane has left `blocked` and come back — so a
     still-blocked pane doesn't re-fire on every incidental `pane.updated`
     or other event that shares the debounce window. One push per genuine
     block, not one per event.
   - Even then, only push if **nobody is currently watching that pane**:
     `server.js` already tracks this per-pane (the `watchers` map — clients
     with that pane open) and globally (`state.webClients` — any connection
     at all). If a live client has the pane open, they're already seeing
     the blocked state in-app (existing toast/bell) — a push on top would
     be redundant. Skip the push when `watchers.get(paneId)?.clients.size`
     is truthy; send it when the pane has zero live watchers.
   - This is the "I don't think Skip is watching this, so I better get his
     attention" behavior — and it falls out of state the server already
     maintains, not new tracking.
6. Still gated behind HTTPS (Tailscale), same as today's notification
   permission requirement — no new exposure surface, no third-party relay
   or gateway in the path. This is the meaningful advantage over
   `herdr-mobile-relay`'s default Cloudflare-Tunnel/community-gateway path:
   Web Push's messages ride through the browser vendor's own push service
   (Google's for Chrome/Android, Apple's for Safari/iOS ≥16.4), which we'd
   be trusting either way to *deliver* push on any PWA — but nothing about
   *our* pane content or terminal control passes through a third party we
   chose; it's the same trust boundary as installing Chrome or Safari
   itself.
   - Note the asymmetry: **sending** the push needs no Tailscale at all —
     docker-server calls Google's/Apple's push endpoint directly over the
     open internet (normal outbound HTTPS, already available). Tailscale
     only matters for the *tap-through* — actually loading the pane once
     the phone opens the notification. Confirm docker-server has ordinary
     outbound internet access (should already, but don't assume egress is
     unrestricted without checking).

## Explicitly not doing (for now)

- **Auth beyond Tailscale.** Single user, single tailnet, already the
  access-control boundary for the rest of the homelab. Revisit only if we
  ever want access from outside Tailscale.
- **Multi-computer relay.** `herdr-mobile-relay`'s multi-machine pairing is
  solving a problem we don't have — one docker-server, one herdr instance.
- **Rewriting the frontend.** It's a single well-organized vanilla-JS file;
  no reason to introduce a framework or build step for one new feature.

## Push delivery: it's the standard Web Push API, not a native FCM integration

`PushManager.subscribe()` + VAPID — the same W3C spec Chrome, Firefox, and
Safari (iOS ≥16.4) all implement for any site/PWA. No Firebase project, no
`google-services.json`, no Android-specific code. Skip's Android phone runs
Chrome, and Chrome's implementation of that standard happens to be backed
by Google's FCM infrastructure under the hood — but that's transport
plumbing we never touch or configure; the app-level code is identical
across platforms.

## Decisions

- **Fork and keep it quiet — no upstream PR.** Single-user tool, scope is
  small enough that maintaining our own diff is simpler than coordinating
  with upstream's review process. Settled 2026-08-20.

## Deployment approach: not a Docker container

Reviewed against the homelab's `create-new-docker` skill, which assumes a
containerized service — that model doesn't fit here. herdr-web needs a
Unix socket (`~/.config/herdr/herdr.sock`), the real host filesystem (cwd
validation, the directory picker walking zoxide/git repos), and it proxies
arbitrary localhost dev-server ports plus a Chrome DevTools port for the
cast feature — all host-level integrations. Containerizing would mean
either host networking + broad home-directory bind-mounts (defeating the
isolation the hardening skill exists for) or breaking preview/cast
outright.

Confirmed on docker-server: **herdr itself already runs as a systemd user
service** (`herdr.service`, active). herdr-web is designed to piggyback on
exactly that lifecycle — `herdr-plugin.toml` already has startup/stop
hooks wired to herdr's own plugin system (`herdr plugin install`), so it
starts/stops with herdr, with no new systemd unit or container needed.

## Open considerations (not yet decided — discuss before/at build time)

- ~~**VAPID private key handling.**~~ Resolved twice. First pass:
  `lib/push.js` self-generated the keypair into `~/.config/herdr-web/`
  (0600). While verifying that manually I `cat`'d the file to confirm the
  subscribe/unsubscribe flow, which put the private key straight into this
  session's transcript — a real slip. Rotated immediately (no real
  subscriptions existed yet, so impact was minimal). Skip then asked for
  it to follow the same pattern as every other homelab secret instead, so
  **second pass (2026-08-21, current)**: `lib/push.js` no longer generates
  or persists any key material — it reads
  `HERDR_WEB_VAPID_PUBLIC_KEY`/`HERDR_WEB_VAPID_PRIVATE_KEY` from the
  environment, sourced by `scripts/plugin-start.sh` from
  `/etc/homelab/herdr-web.env` (root:docker, 0640) before `node` starts —
  identical to the `env_file:` pattern the create-new-docker skill uses
  for containerized services, just sourced by a shell script instead of
  Docker. Push is cleanly disabled (503, no-op) until that file exists.
  The old local file was deleted, unread, once the new path was verified
  working.
- **Logging gap.** Loki/Promtail ingestion elsewhere in the homelab is all
  Docker-log-driver based; a bare node process won't show up in Grafana
  like everything else does unless we add it as a manual log-file scrape
  target. herdr's own daemon already just writes to
  `~/.config/herdr/herdr-server.log` without Loki visibility, so there's
  local precedent for "plain log file, no Loki" being acceptable — but
  worth deciding on purpose.
- **Backup gap.** Settings (VAPID keys, push subscriptions, agent command)
  will live under `~/.config/herdr-web/`, not `/srv/`, so the nightly
  compose-sync backup script won't see it — the same class of gap the
  create-new-docker skill's Phase 4.6 flags from a real incident
  (frpc-m3u/promtail living outside `/srv`). Probably low-stakes here
  (re-subscribing from the phone is cheap) but should be a deliberate
  call, not an oversight.
- **Exposure tier / Tailscale ACL check.** Zero in-app auth, full terminal
  control, gated entirely on Tailscale reachability. Worth confirming
  Tailscale ACLs actually scope this to Skip's own devices rather than a
  broader tailnet before it's live.
- **Holocron page.** Should still get one once built, explicitly noting
  it's a deliberate non-Docker service running on docker-server via
  herdr's plugin lifecycle, not the standard `/srv/[service]/compose.yml`
  pattern.

## Status: push notifications built (2026-08-21)

Code complete and smoke-tested against the live herdr daemon on
docker-server (`herdr.service`, protocol 19):

- `lib/push.js` — VAPID keypair (self-generated on first boot, persisted
  to `push.json` 0600, kept out of `settings.js`), subscription store
  (dedupe by endpoint, drop on 404/410), `notifyAll(payload)`.
- `server.js` — `GET /api/push/public-key`, `POST /api/push/subscribe`,
  `POST /api/push/unsubscribe`; `maybeNotify()` wired into the existing
  `pane.agent_status_changed` handler, gated on transition-to-`blocked` +
  `lastPushedBlocked` (per-pane, clears on leaving blocked or pane close)
  + zero live watchers on that pane (existing `watchers` map — no new
  presence tracking needed, confirming the design from the earlier
  discussion).
- `public/sw.js` — `push` event handler, reuses the existing
  `notificationclick` handler and `tag: herdr-${pane}` coalescing
  convention from the in-app notification path.
- `public/index.html` — `ensurePushSubscription()` wired into the existing
  `maybeAskNotifPermission()` grant flow, plus an on-load check if
  permission was already granted from a prior session.

Verified via curl against the running server: VAPID key generates and is
served publicly, `/api/settings` does *not* leak it, subscribe/unsubscribe
round-trip correctly, invalid payloads 400. Not yet verified: an actual
push arriving on Skip's phone, or the fully-closed-app/reboot cases from
earlier in this plan — that's the real remaining test.

Pushed to `git@github.com:MrGibbage/herdr-web.git` (origin); `upstream`
remote kept pointed at `eyalev/herdr-web` for pulling future updates.

## Resolved: Tailscale reinstalled on docker-server (2026-08-21)

Skip chose to reinstall (scoped exception to the 2026-08-12 removal, made
deliberately rather than by default). `apt` still had the Tailscale
archive keyring/repo from before, so it was a clean `apt-get install
tailscale` + `tailscale up` — authenticated via the login link Skip
opened himself. Now on the tailnet as `docker-server` (100.64.16.10).
`tailscale serve --bg --https=17930 http://127.0.0.1:7930` is running;
verified `https://docker-server.tail5687.ts.net:17930/` returns 200. This
is the phone URL — Skip's Pixel 9 Pro XL is already on the same tailnet.

## Blocker found: docker-server has no local Tailscale client (2026-08-21) — superseded above

The whole exposure plan assumed `tailscale serve` on docker-server, per
upstream's README. Checked directly: no `tailscale` binary, no
`tailscaled` service — confirms the earlier memory that docker-server,
smavm, and ganymede all dropped their own Tailscale clients around
2026-08-12 (OPNsense now handles Tailscale as an *exit node* for LAN
egress, which is a different capability from exposing a LAN host *into*
the tailnet). `tailscale serve` cannot run here as-is. Real options, still
undecided:

- Reinstall a Tailscale client on docker-server as a scoped exception —
  gets back to the original plan exactly, but reverses a deliberate
  recent infra decision and needs a real reason to carve out an
  exception.
- Route through the existing Caddy LAN pattern
  (`herdr-web.pelorus.org` → `192.168.0.231:7930`, real HTTPS cert, no
  new exposure) — works immediately with zero new infra, but only
  reachable on the home network, not "from anywhere" the way mobile
  access implies.
- CF Tunnel + CF Access — reachable from anywhere, but reintroduces a
  third party in the path and would need CF Access's SSO/OTP to stand in
  for the auth herdr-web itself doesn't have, which changes the trust
  model from what was decided earlier ("Auth beyond Tailscale... revisit
  only if we want access from outside Tailscale" — that's now the actual
  situation, not a hypothetical).

## Validated end-to-end (2026-08-21)

Real device test, app fully swiped away + phone screen off, using
`herdr pane report-agent` to synthetically flip this session's own pane
(`wB:pB`) to `blocked` (real permission-prompt tests were impossible —
this session runs in bypass-permissions mode, so `rm` never actually
paused for approval; report-agent exercises the identical
`pane.agent_status_changed` → `maybeNotify()` → `push.notifyAll()` path a
real block would, just from a different origin):

- Test 1 (before `push-sent`/`push-failed` logging existed): no visible
  result either way — this is what led to adding that logging, a real gap
  the first test exposed.
- Test 2: notification landed — "Claude needs you", screen off, app
  closed. Chrome's Android client showed it behind a **"possible
  spam?"** wrapper (unsubscribe/show buttons) rather than a normal
  notification — this is a known Chrome heuristic for a push origin with
  no prior reputation, not a bug in this code. Skip tapped Show → Always
  Allow → Report as not spam, which should let future notifications
  render normally.
- Test 3: correctly produced **no** notification — Skip's phone had
  reconnected (a live WebSocket on that pane, visible in `ws-open` with
  no matching `ws-close`), so the presence gate suppressed the push
  exactly as designed. Confirms the "don't push if someone's already
  watching" logic works, not just the "push if nobody's watching" half.

Full pipeline confirmed working: blocked-transition detection, presence
gating, VAPID-signed send via `/etc/homelab/herdr-web.env`, delivery
through Chrome's push service, service worker `push` handler, and
`showNotification()`.

## Remaining open considerations

Logging gap (partially addressed — push send outcomes now logged;
general server logs still aren't in Loki), backup gap, Holocron page.
The Tailscale ACL check now applies for real, since Tailscale ended up
being the actual exposure path.
