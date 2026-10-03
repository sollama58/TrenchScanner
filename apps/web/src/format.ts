/** Display formatting. Pure, so it is unit-tested (format.test.ts). */

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `$${trim(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** A rate already in percent (75 = 75%). */
export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `${value.toFixed(digits)}%`;
}

/** A return in percent as a price multiple: +100% -> 2.0x. */
export function multiple(returnPct: number | null | undefined): string {
  if (returnPct === null || returnPct === undefined || !Number.isFinite(returnPct)) return "–";
  const x = 1 + returnPct / 100;
  return `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x`;
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
