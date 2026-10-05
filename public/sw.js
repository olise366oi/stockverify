/**
 * Service Worker - PWA 离线支持核心
 * 缓存应用外壳，确保离线时页面仍可打开
 * 数据同步由 IndexedDB + SyncManager 处理
 */

const CACHE_NAME = 'stockverify-v51';
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

// 拦截请求：缓存优先策略（静态资源），网络优先（API请求）
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // API 请求：网络优先，失败时不缓存（数据必须实时）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        // 离线时 API 请求返回 503，前端会走 IndexedDB 逻辑
        return new Response(JSON.stringify({ error: '离线模式，API不可用' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 静态资源：网络优先（保证最新版本），离线时回退缓存
  event.respondWith(
    fetch(request).then((response) => {
      // 缓存新的静态资源
      if (response.ok && (request.method === 'GET')) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
      }
      return response;
    }).catch(() => {
      return caches.match(request).then((cached) => {
        if (cached) return cached;
        // 离线且无缓存时，仅对根路径回退 index.html；具体页面不回退避免混淆
        if (request.mode === 'navigate') {
          const path = new URL(request.url).pathname;
          if (path === '/' || path === '/index.html') {
            return caches.match('/index.html');
          }
          // admin.html / register.html 等返回缓存；无缓存时回退离线提示页 offline.html
          const cachedPage = caches.match(path);
          if (cachedPage) return cachedPage;
          return caches.match('/offline.html');
        }
        return new Response('离线模式', { status: 503 });
      });
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
