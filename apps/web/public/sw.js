/* global self */
// Shows the dashboard's alert notifications. Chrome on Android (and some other browsers) refuse
// `new Notification()` from a page and only allow registration.showNotification(); desktop
// browsers show them the same way. No fetch handler: nothing is cached or intercepted.
//
// Also receives Web Push (the worker's web-push-dispatch, packages/core/src/webPush/dispatch.ts),
// so alerts reach a phone's Home Screen app or a closed browser. Every push shows a notification:
// iOS and Chrome withdraw push from a site whose pushes show nothing.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data;
  try {
    data = (event.data ? event.data.json() : null) || {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "New TrenchScanner alert";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: typeof data.icon === "string" ? data.icon : "/icon-192.png",
      badge: "/icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: typeof data.tag === "string",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const wanted = event.notification.data && event.notification.data.url;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return;
      }
      // Only ever this site: a push's url is ours, but never trust it to leave the origin.
      let target = "/";
      try {
        const url = new URL(wanted || "/", self.location.origin);
        if (url.origin === self.location.origin) target = url.href;
      } catch {
        // Keep "/".
      }
      await self.clients.openWindow(target);
    })(),
  );
});
