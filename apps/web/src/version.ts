/**
 * Keeps open tabs on the latest deployed dashboard.
 *
 * The build stamps its version into the bundle (__APP_VERSION__) and writes the same value to
 * /version.json (vite.config.ts). index.html is revalidated on every load and the hashed assets are
 * immutable, so a fresh load always runs the latest build; what goes stale is a tab left open
 * across a deploy, which this dashboard invites. Such a tab re-reads /version.json every few
 * minutes while visible, and again when it comes back into view, and offers a reload once the
 * deployed version differs from its own (components/UpdateBanner.tsx).
 *
 * A stale tab can also fail outright: each deploy replaces the hashed chunks, so the first lazy
 * chunk it asks for afterwards (a tab, the token modal) is gone. Vite reports that as
 * `vite:preloadError`; when /version.json confirms a newer deploy, the tab reloads once onto it
 * rather than showing a broken screen.
 */

declare const __APP_VERSION__: string;

/** This bundle's version; empty in dev and tests, where the checks are off. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

/** How often a visible tab asks. */
export const CHECK_INTERVAL_MS = 5 * 60_000;
/** The least time between two checks, so focus and visibility flapping don't hammer the host. */
export const MIN_CHECK_GAP_MS = 60_000;
/** After reloading for a version, how long to stay quiet if the host still served the old page. */
export const RELOAD_GRACE_MS = 2 * 60_000;

const RELOAD_KEY = "ts.versionReload";
const UPDATE_EVENT = "ts:update-available";

/** Reads the deployed version; null when it can't be read (offline, host error, bad JSON). */
export async function fetchDeployedVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    // The query string keys past any cache that ignores no-store (a CDN, an old service worker).
    const res = await fetchImpl(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version !== "" ? body.version : null;
  } catch {
    return null;
  }
}

interface ReloadMark {
  version: string;
  at: number;
}

function readMark(): ReloadMark | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const mark = JSON.parse(raw) as Partial<ReloadMark>;
    return typeof mark.version === "string" && typeof mark.at === "number"
      ? { version: mark.version, at: mark.at }
      : null;
  } catch {
    return null;
  }
}

function writeMark(version: string): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ version, at: Date.now() }));
  } catch {
    // Blocked storage: the grace and loop guards are off, nothing else changes.
  }
}

/**
 * Whether to offer `deployed` to a tab running `current`. Not when they match, and not right after
 * this tab reloaded for that same version yet still came back on the old one: the host can serve
 * the previous index.html for a moment after a deploy, and asking again at once would loop.
 */
export function shouldOffer(
  current: string,
  deployed: string | null,
  mark: ReloadMark | null,
  now: number,
): boolean {
  if (!current || !deployed || deployed === current) return false;
  return !(mark && mark.version === deployed && now - mark.at < RELOAD_GRACE_MS);
}

/**
 * Whether a failed chunk load should reload the page. Once per RELOAD_GRACE_MS: if the reload
 * didn't help (the host or network is the problem, not a deploy), the app's own error handling
 * takes over instead of the page reloading in a loop.
 */
export function shouldReloadForChunk(mark: ReloadMark | null, now: number): boolean {
  return !(mark && now - mark.at < RELOAD_GRACE_MS);
}

/** The /assets/ file named in a failed chunk load's error ("Failed to fetch dynamically imported module: …"). */
export function failedAssetUrl(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const m = /(?:https?:\/\/[^\s/'"]+)?\/assets\/[^\s'"]+/.exec(message);
  return m ? m[0] : null;
}

/** Fetches `url` past the browser cache (replacing a cached 404); true when the host serves it. */
export async function refetchAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetchImpl(url, { cache: "reload" })).ok;
  } catch {
    return false;
  }
}

let offered: string | null = null;
let lastCheck = 0;

/** The version a reload would bring, once one is known (UpdateBanner subscribes). */
export function availableUpdate(): string | null {
  return offered;
}

export function onUpdateAvailable(listener: () => void): () => void {
  window.addEventListener(UPDATE_EVENT, listener);
  return () => window.removeEventListener(UPDATE_EVENT, listener);
}

/** Checks now, unless a check ran within MIN_CHECK_GAP_MS (`force` skips that). */
export async function checkForUpdate(force = false): Promise<void> {
  if (!APP_VERSION) return;
  const now = Date.now();
  if (!force && now - lastCheck < MIN_CHECK_GAP_MS) return;
  lastCheck = now;
  const deployed = await fetchDeployedVersion();
  if (deployed && deployed !== offered && shouldOffer(APP_VERSION, deployed, readMark(), Date.now())) {
    offered = deployed;
    window.dispatchEvent(new Event(UPDATE_EVENT));
  }
}

/** Reloads onto the deployed version. */
export function applyUpdate(): void {
  writeMark(offered ?? "");
  window.location.reload();
}

let started = false;

/** Starts the checks and the stale-chunk recovery. Called once, from each page's entry; off in dev. */
export function startVersionWatch(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  if (!APP_VERSION) return;

  // A chunk failed to load. If a deploy has replaced this build, that is why: reload onto the new
  // one, once. If the same build is still live it was the network, and a reload wouldn't help.
  // The same build is live but its chunk 404'd anyway: a request that landed mid-deploy, whose 404
  // the browser keeps caching (index.html's boot script handles the same case for the first
  // screen). Re-fetch the chunk past the cache; if it is there now, reload once.
  window.addEventListener("vite:preloadError", (event) => {
    const failed = failedAssetUrl((event as Event & { payload?: unknown }).payload);
    void (async () => {
      const deployed = await fetchDeployedVersion();
      if (!deployed) return;
      if (!shouldReloadForChunk(readMark(), Date.now())) return;
      if (deployed === APP_VERSION && !(failed && (await refetchAsset(failed)))) return;
      writeMark(deployed);
      window.location.reload();
    })();
  });
  document.documentElement.dataset.appVersion = APP_VERSION;

  const visible = () => document.visibilityState === "visible";
  // Not at load: the page was just fetched, so it is the deployed version (or the grace applies).
  setInterval(() => {
    if (visible()) void checkForUpdate();
  }, CHECK_INTERVAL_MS);
  // A tab hidden overnight checks the moment it is looked at, not up to five minutes later.
  document.addEventListener("visibilitychange", () => {
    if (visible()) void checkForUpdate();
  });
  window.addEventListener("focus", () => void checkForUpdate());
  window.addEventListener("online", () => void checkForUpdate(true));
}
