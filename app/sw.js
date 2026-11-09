/* Service worker
 * - หน้าแอป (HTML/JS/CSS): ดึงจากเน็ตก่อนเสมอ (ตรวจกับเซิร์ฟเวอร์ด้วย ETag) แล้วเก็บสำเนาไว้ ถ้าออฟไลน์ใช้สำเนาในเครื่อง
 *   → อัปเดตแอปได้ทันทีที่เปิดใหม่ ไม่ค้างเวอร์ชันเก่าจากแคชของ GitHub Pages
 * - ข้อมูลการนับอยู่ใน IndexedDB ไม่ใช่ที่นี่ ล้าง cache นี้ได้โดยข้อมูลไม่หาย
 */
var CACHE = 'stockcount-2.2.4';
var NET_TIMEOUT = 3000;      // หน้าแอป
var NET_TIMEOUT_SUB = 1500;  // ไฟล์ประกอบ (JS/CSS/รูป)
var FILES = ['./', 'index.html', 'app.js', 'db.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // cache: 'reload' = ไม่เอาไฟล์จากแคช HTTP ของเบราว์เซอร์ ได้ไฟล์ล่าสุดจากเซิร์ฟเวอร์จริง
    return Promise.all(FILES.map(function (f) { return fetch(new Request(f, { cache: 'reload' })).then(function (r) { if (r.ok) return c.put(f, r); }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // API ไป Google ตรง
  var isConfig = url.pathname.endsWith('config.json');
  e.respondWith(new Promise(function (resolve) {
    var done = false;
    function finish(res) { if (!done && res) { done = true; resolve(res); } }
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : null);
      });
    }
    // เน็ตช้า/เพิ่งต่อ Wi-Fi: รอไม่เกิน 3 วินาที แล้วใช้สำเนาในเครื่อง (กันจอขาวค้าง)
    var timer = setTimeout(function () { fromCache().then(finish); }, req.mode === 'navigate' ? NET_TIMEOUT : NET_TIMEOUT_SUB);
    // no-store: ไม่ผ่านแคช HTTP ของเบราว์เซอร์ จึงไม่ต้องรอคำขอเก่าที่ค้างอยู่ (ไฟล์แอปรวมแค่ ~60 KB)
    fetch(req, { cache: 'no-store' }).then(function (res) {
      clearTimeout(timer);
      if (res.ok && !isConfig) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      finish(res);
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (hit) { finish(hit || Response.error()); });
    });
  }));
});
