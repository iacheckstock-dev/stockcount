/* Service worker: เก็บหน้าแอปไว้ในเครื่อง เปิดได้แม้ไม่มีเน็ต (ข้อมูลการนับอยู่ใน IndexedDB ไม่ใช่ที่นี่) */
var CACHE = 'stockcount-2.0.0';
var FILES = ['./', 'index.html', 'app.js', 'db.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;     // API ไป Google ตรง ไม่ผ่าน cache
  if (url.pathname.endsWith('config.json')) {                                          // config: เอาจากเน็ตก่อน
    e.respondWith(fetch(e.request).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) { return hit || fetch(e.request); }));
});
