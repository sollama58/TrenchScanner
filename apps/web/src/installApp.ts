import { useEffect, useState } from "react";

/**
 * Installing the site as a home-screen app on a phone or tablet (user ask 2026-10-18): the button
 * on the signed-out page, in Settings and in the wallet pill's menu. There is no store build; the
 * app is this site with its manifest (public/manifest.webmanifest), opened without browser chrome.
 *
 * Chrome, Edge and Samsung Internet on Android fire `beforeinstallprompt`, which is held here and
 * replayed from the button. It fires once, early, often before the lazy sign-in or Settings code
 * has loaded, so captureInstallPrompt() runs from main.tsx. Safari on iPhone and iPad has no
 * prompt at all: the button shows the Share > Add to Home Screen steps instead, as it does on any
 * browser that hasn't offered one.
 */

export type InstallPlatform = "ios" | "android" | "other";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Which phone or tablet this is, from its user agent; null on a desktop. */
export function mobilePlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS Safari reports a Mac; a Mac has no touch screen.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mobi|Tablet|Silk|KFAPWI/i.test(userAgent)) return "other";
  return null;
}

/** Opened from the home screen already: nothing to offer. */
export function runningInstalled(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    win.matchMedia?.("(display-mode: fullscreen)").matches === true
  );
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Called once from main.tsx, before anything lazy loads. */
export function captureInstallPrompt(win: Window = window): void {
  win.addEventListener("beforeinstallprompt", (e) => {
    // Held for the button rather than shown as Chrome's own banner.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  win.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    changed();
  });
  // Chrome only offers to install a site with a service worker; public/sw.js handles alert
  // notifications and intercepts nothing, so registering it early on a phone is harmless.
  if (
    mobilePlatform(win.navigator.userAgent, win.navigator.maxTouchPoints) === "android" &&
    !runningInstalled(win) &&
    "serviceWorker" in win.navigator &&
    win.isSecureContext
  ) {
    win.navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

export interface InstallApp {
  /** A phone or tablet with the site not yet installed: show the button. */
  show: boolean;
  platform: InstallPlatform;
  /** The browser's own install dialog is ready; otherwise the button shows steps. */
  canPrompt: boolean;
  /** Opens the browser's install dialog; false when there is none, so show the steps. */
  install: () => Promise<boolean>;
}

export function useInstallApp(): InstallApp {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  const platform =
    typeof navigator === "undefined" ? null : mobilePlatform(navigator.userAgent, navigator.maxTouchPoints);
  const show = platform !== null && !installed && !runningInstalled();
  return {
    show,
    platform: platform ?? "other",
    canPrompt: deferred !== null,
    install: async () => {
      const event = deferred;
      if (!event) return false;
      // A held prompt can be used once.
      deferred = null;
      changed();
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        if (outcome === "accepted") {
          installed = true;
          changed();
        }
      } catch {
        return false;
      }
      return true;
    },
  };
}
