const CACHE_NAME = "book-inventory-cache-v30";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=20260520g",
  "./supabase-config.js?v=20260519a",
  "./app-20260520g.js",
  "./manifest.json?v=20260518",
  "./vendor/zxing-browser.min.js?v=20260518",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => cached || caches.match("./index.html"));
      }),
  );
});
