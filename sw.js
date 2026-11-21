// サービスワーカー：アプリ本体（HTML/CSS/JS・アイコン・デモデータ）だけを同じ版のキャッシュから返す。
// 取り込んだ予想はキャッシュしない（端末の保存領域だけに置く）。VERSION は tools/update_sw_version.py で更新する。
const VERSION = 'kyp-d7c2d05590ac';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/app.js',
  './js/validate.js',
  './js/store.js',
  './js/bets.js',
  './js/record.js',
  './data/demo.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kyp-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);           // キャッシュに無いもの（tests.html など）はそのまま取りに行く。保存はしない
    } catch (err) {
      if (req.mode === 'navigate') {     // 通信なしで、キャッシュに無いページを開いたときだけ本体を返す
        const idx = await c.match('./index.html');
        if (idx) return idx;
      }
      throw err;
    }
  }));
});
