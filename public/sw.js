const CACHE_NAME = 'ccadmin-pwa-v2.3.0';
const BASE_PATH = '/chatbotadmin';

const PRECACHE_ASSETS = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/login-bg.jpg`,
  `${BASE_PATH}/manifest.webmanifest`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/favicon.svg`,
  `${BASE_PATH}/icon-192.png`,
  `${BASE_PATH}/icon-512.png`,
  `${BASE_PATH}/icon-maskable-192.png`,
  `${BASE_PATH}/icon-maskable-512.png`,
  `${BASE_PATH}/apple-touch-icon.png`
];

// Install Event - Pre-cache essential app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up previous cache versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Dynamic routing strategy
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests and external resources
  if (req.method !== 'GET') return;

  // Never cache API requests - always network live
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(req).catch(() => {
        return new Response(JSON.stringify({ ok: false, error: 'Offline - server unreachable.' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // HTML navigation requests - Network-first with cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match(`${BASE_PATH}/index.html`) || caches.match(`${BASE_PATH}/`);
      })
    );
    return;
  }

  // Static Assets (Icons, Images, Manifest) - Cache-first with network revalidation
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Revalidate in background
        fetch(req).then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(req, networkRes));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, resClone));
        }
        return networkRes;
      });
    })
  );
});

// Push Notification Handler
self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch { data = { title: 'New Notification', body: event.data.text() }; }
  }

  const title = data.title || 'ccadminchatbot';
  const options = {
    body: data.body || 'You have a new notification.',
    icon: `${BASE_PATH}/icon-192.png`,
    badge: `${BASE_PATH}/icon-maskable-192.png`,
    tag: data.tag || 'ccadmin-push',
    data: { url: data.url || BASE_PATH + '/' },
    requireInteraction: false,
    silent: false
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification Click Handler - opens or focuses the admin panel
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || (BASE_PATH + '/');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(BASE_PATH) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
