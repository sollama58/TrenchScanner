/**
 * Talks to the Trench Overlay extension from Settings, so connecting a browser needs no copy-paste.
 *
 * Chrome gives a page `chrome.runtime.sendMessage(extensionId, …)` only when an installed extension
 * lists the page's origin in its manifest's externally_connectable, as Trench Overlay lists this
 * site. A key goes to one of the known IDs below, or to the ID the extension's own "Connect with
 * TrenchScanner" link carries (?ext=), which covers a build whose ID isn't listed yet (a store item
 * before its ID is added, a copy loaded unpacked from the store zip). Trusting the link's ID means a
 * crafted link could steer a key to another installed extension that also lists this site; the
 * reader still has to press Connect, and the key only reads their alerts and stats. Listing the
 * store ID here makes the link's ID unnecessary for store installs.
 *
 * - The unpacked build (apps/extension, `npm run build`) carries dev-key.pub, so its ID is fixed.
 * - The Chrome Web Store assigns the listed item's ID at its first upload; it goes in
 *   VITE_EXTENSION_IDS (comma-separated) on the web service, or in STORE_IDS once known.
 */
const DEV_ID = "jhdfdijmhnomcdijohdfibelodhfiigl";
const STORE_IDS: string[] = [];
const EXTENSION_ID = /^[a-p]{32}$/;

export const EXTENSION_IDS: readonly string[] = [
  ...new Set(
    [
      ...STORE_IDS,
      ...String((import.meta.env.VITE_EXTENSION_IDS as string | undefined) ?? "").split(","),
      DEV_ID,
    ]
      .map((s) => s.trim())
      .filter((s) => EXTENSION_ID.test(s)),
  ),
];

interface Runtime {
  sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void;
  readonly lastError?: unknown;
}

function runtime(): Runtime | null {
  const chrome = (globalThis as { chrome?: { runtime?: Partial<Runtime> } }).chrome;
  return typeof chrome?.runtime?.sendMessage === "function" ? (chrome.runtime as Runtime) : null;
}

function ask(id: string, message: unknown, timeoutMs: number): Promise<unknown> {
  const rt = runtime();
  if (!rt) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(id, message, (response) => {
        // Reading lastError marks a missing extension as handled instead of a console error.
        void rt.lastError;
        clearTimeout(timer);
        resolve(response ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export interface InstalledExtension {
  id: string;
  connected: boolean;
  version: string | null;
}

/** The IDs to try: the link's own first, then the known builds. */
function candidates(hint: string | null | undefined): string[] {
  const ids = hint && EXTENSION_ID.test(hint) ? [hint, ...EXTENSION_IDS] : [...EXTENSION_IDS];
  return [...new Set(ids)];
}

/** The installed Trench Overlay, if this browser has one of the known builds or the link's. */
export async function findExtension(hint?: string | null): Promise<InstalledExtension | null> {
  if (!runtime()) return null;
  for (const id of candidates(hint)) {
    const reply = (await ask(id, { type: "ping" }, 1500)) as {
      ok?: unknown;
      connected?: unknown;
      version?: unknown;
    } | null;
    if (reply?.ok === true) {
      return {
        id,
        connected: reply.connected === true,
        version: typeof reply.version === "string" ? reply.version : null,
      };
    }
  }
  return null;
}

/** Hands a key Settings just made to the extension, which checks it with the API and keeps it. */
export async function handOverKey(
  id: string,
  key: string,
  hint?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!candidates(hint).includes(id)) return { ok: false, error: "Unknown extension." };
  const reply = (await ask(id, { type: "connect", key }, 15_000)) as { ok?: unknown; error?: unknown } | null;
  if (reply?.ok === true) return { ok: true };
  return {
    ok: false,
    error: typeof reply?.error === "string" ? reply.error : "The extension didn't answer.",
  };
}
