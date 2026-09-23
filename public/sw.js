// オフライン起動用 Service Worker
// - 画面遷移: ネット優先、つながらなければキャッシュした index.html
// - /assets/*（ファイル名にハッシュ付き）: キャッシュ優先
// - /api/*: キャッシュしない（同期はアプリ側のキューで管理）
const CACHE = 'goods-selling-v2'

async function precache() {
  const cache = await caches.open(CACHE)
  const res = await fetch('/', { cache: 'no-store' })
  await cache.put('/', res.clone())
  const html = await res.text()
  const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1])
  await Promise.all(urls.map((u) => cache.add(u).catch(() => {})))
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('/', copy))
            // 新しい index.html が参照するアセットも裏で取得しておく
            res.clone().text().then((html) => {
              const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1])
              caches.open(CACHE).then((c) => urls.forEach((u) => c.match(u, { ignoreVary: true }).then((hit) => hit || c.add(u).catch(() => {}))))
            })
          }
          return res
        })
        .catch(() => caches.match('/', { ignoreVary: true }).then((r) => r || Response.error())),
    )
    return
  }

  e.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest'))) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
