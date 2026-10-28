/** Display formatting. Pure, so it is unit-tested (format.test.ts). */

/** The smallest realized profit that counts as a wallet win (core's MIN_WIN_SOL, wallets/riskScore.ts); keep the two equal. */
export const MIN_WIN_SOL = 0.5;

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  // The unit is picked on the value as it will be shown: $999.6K rounds to "1000K", which reads
  // as $1.00M.
  const abs = Math.abs(value);
  // "-$150K", not "$-150.00K": trim() picks its decimals on the size, so it gets the magnitude.
  const sign = value < 0 && Math.round(abs) > 0 ? "-" : "";
  if (abs >= 999_500_000) return `${sign}$${trim(abs / 1_000_000_000)}B`;
  if (abs >= 999_500) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 999.5) return `${sign}$${trim(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** A rate already in percent (75 = 75%). */
export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `${value.toFixed(digits)}%`;
}

/** A return in percent with its sign: +12%, -8%, 0%. */
export function signedPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return `${(0).toFixed(digits)}%`;
  return `${value > 0 ? "+" : "-"}${text}%`;
}

/** A total return in percent of one stake, as stakes won or lost: +340% -> "+3.4 stakes". */
export function stakes(totalPct: number | null | undefined): string {
  if (totalPct === null || totalPct === undefined || !Number.isFinite(totalPct)) return "–";
  const n = totalPct / 100;
  const text = Math.abs(n) >= 100 ? Math.abs(n).toFixed(0) : Math.abs(n).toFixed(1);
  if (Number(text) === 0) return "0 stakes";
  return `${n > 0 ? "+" : "-"}${text} stake${text === "1.0" ? "" : "s"}`;
}

/** A return in percent as a price multiple: +100% -> 2.0x. */
export function multiple(returnPct: number | null | undefined): string {
  if (returnPct === null || returnPct === undefined || !Number.isFinite(returnPct)) return "–";
  const x = 1 + returnPct / 100;
  // Decided on the rounded figure, so 9.97x reads "10x" rather than "10.0x".
  return `${Math.round(x * 10) / 10 >= 10 ? x.toFixed(0) : x.toFixed(1)}x`;
}

/** Signed percent change between two values. */
export function change(from: number | null | undefined, to: number | null | undefined): number | null {
  if (!from || to === null || to === undefined) return null;
  return ((to - from) / from) * 100;
}

export function ago(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** An open position's price is this old before its row says so (the bots reprice every scan cycle). */
export const PRICED_STALE_MS = 3 * 60_000;

/**
 * "priced 12m ago" for an open position whose last price is PRICED_STALE_MS or older, "not priced
 * yet" without one; null while it is current.
 */
export function pricedAgeText(at: string | null | undefined, now = Date.now()): string | null {
  if (!at) return "not priced yet";
  return now - new Date(at).getTime() >= PRICED_STALE_MS ? `priced ${ago(at, now)}` : null;
}

/** A SOL price this old is named with its age where dollar figures use it (the api refreshes it every minute). */
export const SOL_PRICE_STALE_MS = 5 * 60_000;

/** "12m ago" for a SOL price read SOL_PRICE_STALE_MS or longer ago; null while current or unknown. */
export function solUsdAgeText(at: string | null | undefined, now = Date.now()): string | null {
  if (!at) return null;
  return now - new Date(at).getTime() >= SOL_PRICE_STALE_MS ? ago(at, now) : null;
}

/** How far off a future moment is: "in 5m", "in 3h", "in 2d"; "now" once it has passed. */
export function until(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = new Date(iso).getTime() - now;
  const min = Math.ceil(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

export function minutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value < 60) return `${Math.round(value)}m`;
  if (value < 48 * 60) return `${(value / 60).toFixed(1)}h`;
  return `${Math.round(value / 1440)}d`;
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function tokenLabel(token: {
  symbol: string | null;
  name: string | null;
  mintAddress: string;
}): string {
  return token.symbol ? `$${token.symbol}` : (token.name ?? shortAddress(token.mintAddress));
}

/**
 * A small thumbnail for a token's launcher-supplied image. Most Pump.fun images are IPFS files on
 * public gateways (ipfs.io rate-limits with 429s) at full size, often hundreds of KB for a 40px
 * avatar. An IPFS image is served instead through Pump.fun's Pinata gateway, resized there to
 * `size` px (96 by default, ~2-3 KB). DexScreener's CDN images carry their own size in the query
 * (`?width=800&height=800&quality=95`, ~200 KB): those ask the CDN for the smallest size it serves
 * that covers `size` (it answers other sizes with a 422). Anything else is returned unchanged. The
 * card falls back to the original URL if the thumbnail fails to load.
 */
export function tokenThumb(url: string, size = 96): string {
  const cid = ipfsCid(url);
  if (cid)
    return `https://pump.mypinata.cloud/ipfs/${cid}?img-width=${size}&img-height=${size}&img-fit=cover`;
  return dexScreenerThumb(url, size) ?? url;
}

function ipfsCid(url: string): string | undefined {
  return (
    /^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{46,})\/?(?:[?#].*)?$/.exec(url)?.[1] ??
    /^https:\/\/([A-Za-z0-9]{46,})\.ipfs\.[^/]+\/?(?:[?#].*)?$/.exec(url)?.[1]
  );
}

/**
 * Where to load a token's image from, in order, for an `<img>` that moves to the next on error
 * or when it stalls (TokenImage), and shows the initials when none loads. First the small
 * thumbnail (tokenThumb) when it could resize the URL; then, for a Pump.fun mint, Pump.fun's own image CDN (it has every coin
 * it launched, small and cached, even when we never got the launcher's URL); for an IPFS image,
 * then Filebase's gateway, which has the CIDs Pump.fun's Pinata gateway refuses (403, "not
 * pinned") in ~0.4 s; then the launcher's own URL; then a second public gateway. ipfs.io and
 * dweb.link answer most reads with 429s (checked 2026-10-23), so they come last. Empty for
 * anything but https when the mint is not a Pump.fun one.
 */
export function tokenImageSources(url: string | null | undefined, size = 96, mint?: string | null): string[] {
  const safe = url?.trim() ?? "";
  const pump = pumpCdnImage(mint, size);
  if (!/^https:\/\/\S+$/.test(safe)) return pump ? [pump] : [];
  // A URL tokenThumb can't resize (the launcher's own host) is the full-size original, a
  // megabyte for a 40px avatar at worst (audit 10-27 WB-16): Pump.fun's small copy goes first.
  const thumb = tokenThumb(safe, size);
  const out = thumb === safe ? [] : [thumb];
  if (pump) out.push(pump);
  const cid = ipfsCid(safe);
  if (cid) out.push(`https://ipfs.filebase.io/ipfs/${cid}`);
  out.push(safe);
  if (cid) {
    const host = new URL(safe).hostname;
    out.push(host === "ipfs.io" ? `https://dweb.link/ipfs/${cid}` : `https://ipfs.io/ipfs/${cid}`);
  }
  return [...new Set(out)];
}

/** The square variants images.pump.fun serves (checked 2026-10-23; 100, 160, 200 and 512 are refused). */
const PUMP_CDN_SIZES = [32, 40, 48, 64, 86, 96, 128, 256, 300, 400];

/**
 * A Pump.fun coin's image on Pump.fun's CDN, resized to the smallest variant that covers `size`.
 * Only for mints ending in "pump": for a mint it does not know, the CDN answers with a stock
 * placeholder picture rather than an error, which would hide the initials.
 */
function pumpCdnImage(mint: string | null | undefined, size: number): string | null {
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !mint.endsWith("pump")) return null;
  const fit = PUMP_CDN_SIZES.find((s) => s >= size) ?? 400;
  return `https://images.pump.fun/coin-image/${mint}?variant=${fit}x${fit}`;
}

/** The square sizes cdn.dexscreener.com resizes to (checked 2026-10-14; 96, 200, 512 and others are refused). */
const DEXSCREENER_SIZES = [64, 128, 160, 256, 800];

function dexScreenerThumb(url: string, size: number): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "cdn.dexscreener.com" || !u.searchParams.has("width")) return null;
  const width = Number(u.searchParams.get("width"));
  const fit = DEXSCREENER_SIZES.find((s) => s >= size) ?? 800;
  // Never ask for more than the launcher's own URL did.
  if (!Number.isFinite(width) || fit >= width) return null;
  u.searchParams.set("width", String(fit));
  // It needs both sides: a width alone is refused.
  u.searchParams.set("height", String(fit));
  u.searchParams.set("quality", "80");
  return u.toString();
}

/**
 * Hour buckets start on the UTC hour, which a :30 or :45 zone (Kolkata, Adelaide, Newfoundland)
 * reads as 5:30 rather than 5: the `minute` option for a bucket's time label, shown only then.
 */
export const halfHour = (t: Date) => (t.getMinutes() !== 0 ? ("2-digit" as const) : undefined);
