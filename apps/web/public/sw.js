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

// A Solana mint, as the page's ?token= link reads it (tradeLink.ts).
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Where a click on this notification should land: the alert's coin (`?token=<mint>`, which the page
 * opens in its token view) or the dashboard. A push names its coin in its tag (`ts-alert-<mint>`,
 * dispatch.ts pushPayloads); the page's own notifications carry the link in `data.url`. Only ever
 * this site: a url is ours, but never trusted to leave the origin.
 */
function clickTarget(notification) {
  let url;
  try {
    url = new URL((notification.data && notification.data.url) || "/", self.location.origin);
  } catch {
    url = new URL("/", self.location.origin);
  }
  if (url.origin !== self.location.origin) url = new URL("/", self.location.origin);
  const tagged = /^ts-alert-(.+)$/.exec(notification.tag || "");
  if (!url.searchParams.has("token") && tagged && MINT_RE.test(tagged[1]))
    url.searchParams.set("token", tagged[1]);
  const mint = url.searchParams.get("token");
  return { href: url.href, mint: mint && MINT_RE.test(mint) ? mint : null };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = clickTarget(event.notification);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // An open tab keeps its state: it opens the coin itself (App.tsx listens), no reload.
        if (target.mint) open.postMessage({ type: "ts-open-token", mint: target.mint });
        await open.focus();
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
