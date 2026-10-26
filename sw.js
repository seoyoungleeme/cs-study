/* 오프라인용 서비스워커.
   셸과 질문 목록은 설치 시 미리 받고, 답변 파일은 읽을 때 캐시에 쌓는다. */
const VERSION = 'csq-v1';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'data/questions.json', 'data/categories.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // LLM API 호출은 건드리지 않는다

  // 네트워크를 먼저 보되 실패하면 캐시로 떨어진다. 새 배포가 바로 반영되게.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
});
