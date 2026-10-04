/* global self */
// Shows the dashboard's alert notifications. Chrome on Android (and some other browsers) refuse
// `new Notification()` from a page and only allow registration.showNotification(); desktop
// browsers show them the same way. No fetch handler: nothing is cached or intercepted.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});
