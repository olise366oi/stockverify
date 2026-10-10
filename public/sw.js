/**
 * Service Worker - PWA 离线支持核心
 * 缓存应用外壳，确保离线时页面仍可打开
 * 数据同步由 IndexedDB + SyncManager 处理
 */

const CACHE_NAME = 'stockverify-v52';
const APP_SHELL = [
  '/',
  '/index.html',
  '/admin.html',
  '/register.html',
  '/offline.html',
  '/manifest.json',
  '/css/style.css',
  '/img/stockverify-logo.png',
  '/js/i18n.js',
  '/js/app.js',
  '/js/admin.js',
  '/js/db.js',
  '/js/finance.js',
  '/js/scanner.js',
  '/js/sync.js',
  '/js/export.js',
  '/js/vendor/html5-qrcode.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// 安装：缓存应用外壳
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('部分资源缓存失败:', err);
      });
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// 拦截请求
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return;

  // API：网络优先，离线返回 503，前端走 IndexedDB
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: '离线模式，API不可用' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // 导航请求：缓存优先 → 网络 → offline.html 回退
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          fetch(request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, clone));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(request)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, clone));
            }
            return res;
          })
          .catch(() => caches.match('/offline.html'));
      })
    );
    return;
  }

  // 其他静态资源：缓存优先 + 后台更新（stale-while-revalidate）
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// 后台同步（浏览器支持时）
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-records') {
    event.waitUntil(syncPendingRecords());
  }
});

async function syncPendingRecords() {
  // 实际同步逻辑在前端 SyncManager 中处理
  // 这里发送消息给所有客户端触发同步
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'trigger-sync' });
  });
}

// 推送通知（预留）
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || '库存管理系统', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png'
    })
  );
});
