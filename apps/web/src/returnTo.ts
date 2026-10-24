import { SAME_SITE_APIS } from "./api";

/**
 * Sending a visitor back where they came from after signing in (user ask 2026-10-24: Asyl, on
 * asyl.trenchscanner.app, signs in on the dashboard's own sign-in page). A page that needs a session
 * opens the dashboard with ?return=<its address>; the dashboard keeps that address for the tab (the
 * sign-in may leave the page for Google or X and come back), and goes there once the session checks
 * out. Only addresses on the dashboard's own sites are followed, so the link can't be used to send
 * a freshly signed-in visitor anywhere else.
 */

const RETURN_KEY = "ts:return-to";

/** `raw` as an address to go back to, or null when it isn't one of ours. */
export function safeReturnUrl(raw: string | null | undefined, here = location.origin): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const ours = Object.keys(SAME_SITE_APIS).some(
    (site) => url.protocol === "https:" && (host === site || host.endsWith(`.${site}`)),
  );
  // This page's own origin too: under `vite` the dashboard and Asyl share localhost.
  if (!ours && url.origin !== here) return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** Keeps a ?return= address for this tab and takes it off the address bar. */
export function captureReturnTo(): void {
  const params = new URLSearchParams(location.search);
  const raw = params.get("return");
  if (raw === null) return;
  const url = safeReturnUrl(raw);
  try {
    if (url) sessionStorage.setItem(RETURN_KEY, url);
  } catch {
    // Storage blocked: the visitor signs in and stays on the dashboard.
  }
  params.delete("return");
  const search = params.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
  );
}

/** The kept address, once: reading it forgets it. */
export function takeReturnTo(): string | null {
  try {
    const url = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return safeReturnUrl(url);
  } catch {
    return null;
  }
}

/** Whether a return is waiting, without taking it. */
export function hasReturnTo(): boolean {
  try {
    return sessionStorage.getItem(RETURN_KEY) !== null;
  } catch {
    return false;
  }
}

/** The dashboard's home on this page's site (the page's own origin under `vite`). */
export function dashboardUrl(host = location.hostname, origin = location.origin): string {
  const h = host.toLowerCase();
  const site = Object.keys(SAME_SITE_APIS).find((s) => h === s || h.endsWith(`.${s}`));
  return site ? `https://${site}/` : `${origin}/`;
}

/** The dashboard's sign-in page, set to come back to `back`. */
export function signInUrl(back: string, host = location.hostname, origin = location.origin): string {
  return `${dashboardUrl(host, origin)}?return=${encodeURIComponent(back)}`;
}
