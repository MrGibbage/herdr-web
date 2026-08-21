// Deliberately cache-nothing service worker (tmux-web no-store stance):
// exists only to satisfy PWA installability. Every fetch goes to network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough — no respondWith */ });

// Real push (app closed, not just backgrounded) — server sends this only
// for a blocked pane nobody's live-watching. Payload: {title, body, pane}.
self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch { /* ignore malformed payload */ }
  const { title = 'herdr', body = '', pane = null } = payload;
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: 'icon-192.png', badge: 'icon-192.png',
    tag: pane ? `herdr-${pane}` : undefined, data: { pane },
  }));
});

// Notification tap: focus (or open) the app and tell it which pane to show.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const pane = e.notification.data?.pane;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      await wins[0].focus();
      if (pane) wins[0].postMessage({ pane });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});
