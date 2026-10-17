/**
 * Admin > Safety screen's live rejection feed (apps/api's GET /admin/screen/rejections): the
 * reason chips, which reasons the admin has hidden, and which rows those leave showing.
 */

export interface RejectionReason {
  /** The screen's own words, with the measured figure ("owns 12.4% of supply (over 10%)"). */
  text: string;
  /** The same reason with its figures as N, so every token failing it groups under one chip. */
  label: string;
}
export interface Rejection {
  mint: string;
  symbol: string | null;
  firstSeenAt: string;
  takenAt: string;
  marketCapUsd: number | null;
  /** A later scan of this token passed the screen. */
  passedSince: boolean;
  reasons: RejectionReason[];
}
export interface RejectionFeed {
  window: { minutes: number; since: string };
  checkedAt: string;
  rejections: Rejection[];
}

/** Each reason in the feed with how many rejected tokens carry it, most common first. */
export function reasonCounts(rows: readonly Rejection[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const label of new Set(r.reasons.map((x) => x.label)))
      counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The rows left with some reasons hidden, each carrying only its reasons still shown. A token
 * rejected for a hidden reason and a shown one stays, so hiding a noisy reason never hides a
 * token that also failed something else; one with every reason hidden drops out.
 */
export function visibleRejections(
  rows: readonly Rejection[],
  hidden: ReadonlySet<string>,
): (Rejection & { hiddenCount: number })[] {
  const out: (Rejection & { hiddenCount: number })[] = [];
  for (const r of rows) {
    const shown = r.reasons.filter((x) => !hidden.has(x.label));
    // A rejection with no reason recorded has nothing to hide behind.
    if (shown.length === 0 && r.reasons.length > 0) continue;
    out.push({ ...r, reasons: shown, hiddenCount: r.reasons.length - shown.length });
  }
  return out;
}

/** A row's identity in the feed: the token at that rejecting scan. */
export const rejectionKey = (r: Pick<Rejection, "mint" | "takenAt">) => `${r.mint}@${r.takenAt}`;

const HIDDEN_KEY = "ts.admin.hiddenRejectReasons";

/** The reasons the admin hid on this device, kept across visits. */
export function loadHiddenReasons(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveHiddenReasons(hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch {
    // Private mode: the choice simply doesn't persist.
  }
}

/** "fresh wallets ..." as "Fresh wallets ...", matching how the token modal writes reasons. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
