/**
 * The site routes the browser extension's copy of the site's bubble map may call through its key
 * (POST /ext/v1/site, user ask 2026-10-25): the extension now draws the site's own map (web
 * components/TokenMapView.tsx), and these are the reads that map makes, for one coin at a time.
 * Every call is replayed inside this process as the key's owner, so a key reaches exactly what its
 * owner's signed-in token view would, and nothing past this list: no settings, no trading, no
 * account routes. Each entry is matched against the whole path and query.
 */

const MINT = "[1-9A-HJ-NP-Za-km-z]{32,44}";

/** What the map reads, by method. Paths and queries exactly as the site's code builds them. */
const ALLOWED: readonly { method: "GET" | "POST"; path: RegExp }[] = [
  // The coin's card: its alert, its scans and its token (TokenMapView).
  { method: "GET", path: new RegExp(`^/tokens/${MINT}/card$`) },
  // The newest scans and the holder reading (HoldersView useCoinScans), and their held wait.
  { method: "GET", path: new RegExp(`^/tokens/${MINT}\\?reading=1$`) },
  { method: "GET", path: new RegExp(`^/tokens/${MINT}/holders/wait$`) },
  // The chart read, for the flagged wallets the map rings.
  { method: "GET", path: new RegExp(`^/tokens/${MINT}/chart$`) },
  // The top-50 maps, live and kept (BubbleMap useBubbleMaps).
  { method: "GET", path: new RegExp(`^/tokens/${MINT}/bubble-holders$`) },
  // The live trades that move the shares between reads (liveTrades.ts).
  { method: "GET", path: new RegExp(`^/tokens/${MINT}/trades/live\\?after=\\d{1,16}&wait=1$`) },
  // The live tick for the coin, by its token id, which keeps it viewed (scanned) while open.
  { method: "GET", path: /^\/live\/market\?tokens=[a-z0-9]{20,40}$/ },
  // Names and KOL sides of the wallets on the map: reads, sent as POST for the wallet list.
  { method: "POST", path: /^\/wallets\/names$/ },
  { method: "POST", path: /^\/wallets\/possible-sides$/ },
];

/** The largest body a call may carry: a wallet list of the map's size. */
export const SITE_CALL_MAX_BODY = 16_384;

export interface SiteCall {
  method: "GET" | "POST";
  path: string;
  body: string | null;
}

/** The call, if it is one the map makes; null for anything else. */
export function allowedSiteCall(raw: unknown): SiteCall | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { method, path, body } = raw as Record<string, unknown>;
  if (method !== "GET" && method !== "POST") return null;
  if (typeof path !== "string" || path.length > 200) return null;
  if (!ALLOWED.some((a) => a.method === method && a.path.test(path))) return null;
  if (method === "GET") return body === null || body === undefined ? { method, path, body: null } : null;
  if (typeof body !== "string" || body.length > SITE_CALL_MAX_BODY) return null;
  return { method, path, body };
}
