"use strict";

// Service Worker: 気分のリマインダー（Web Push）を受け取って通知を出す。
// キャッシュはしない（データは常にサーバーから読む）

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* ignore */ }
  event.waitUntil(self.registration.showNotification(data.title || "いまの気分は？", {
    body: data.body || "タップして記録しましょう",
    icon: "icons/icon-192.png",
    // 同じ tag の通知は置き換わるので、見逃したリマインドが積み重ならない
    tag: "mood-reminder",
    renotify: true,
    data: { url: data.url || "/#mood" },
  }));
});

// 通知をタップしたら、開いている画面があればそこで、なければ新しく気分の入力を開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/#mood", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: "open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
