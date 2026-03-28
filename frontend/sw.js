// Service Worker — IPO Manager (GAS backend edition)
const CACHE = 'ipo-manager-gas-v1';
const STATIC = ['./', './index.html', './app.js', './style.css', './manifest.json'];

// インストール時：静的ファイルをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

// アクティベート時：古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ戦略
// - GAS API (script.google.com) → Network のみ（キャッシュしない）
// - 同一オリジンの静的ファイル → Cache First（オフライン対応）
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // GAS への API リクエストはキャッシュせず素通し
  if (url.includes('script.google.com')) return;

  // 同一オリジンの静的ファイル: キャッシュ優先 → なければネットワーク
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
  }
});
