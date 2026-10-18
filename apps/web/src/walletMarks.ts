import { shortAddress } from "./format";

/**
 * Labeled-wallet trade marks on the token chart (user ask 2026-10-18): the trades of KOLs, their
 * side wallets and the other flagged wallets in the coin (apps/api/src/tokenChart.ts MarkedWallet),
 * drawn as lettered rings, apart from a Pro trader's own buy and sell arrows. The reader picks
 * which kinds of wallet show and the smallest trade that does; trades under MIN_SOL_FLOOR never
 * show (only the reader's own trades do, and those are drawn elsewhere).
 */

/** A flagged wallet as the chart answer sends it, the parts the marks read. */
export interface MarkSource {
  wallet: string;
  tags: readonly string[];
  kol?: string | null;
  knownSideOf?: string;
  side?: { kind: "funded" | "probable"; kolWallet: string; kolName: string | null };
  trades: readonly (readonly [number, 1 | -1, number | null])[];
}

/** The kinds of wallet a reader can show or hide, in the order the picker lists them. */
export type MarkKind = "kol" | "known" | "funded" | "probable" | "dev" | "risky" | "winner" | "linked";

export const MARK_KINDS: readonly { kind: MarkKind; label: string; letter: string; title: string }[] = [
  { kind: "kol", label: "KOLs", letter: "K", title: "Wallets on the KOL roster" },
  { kind: "known", label: "Known Sides", letter: "S", title: "Other wallets we know are a KOL's own" },
  { kind: "funded", label: "KOL Funded", letter: "F", title: "Wallets a KOL paid for (their first SOL)" },
  {
    kind: "probable",
    label: "Probable Sides",
    letter: "P",
    title: "Wallets that keep buying a KOL's coins within minutes of it, or move coins with it",
  },
  { kind: "dev", label: "Dev", letter: "D", title: "The coin's creator" },
  { kind: "risky", label: "Risky & dumpers", letter: "R", title: "High risk scores and known dumpers" },
  { kind: "winner", label: "Winners", letter: "W", title: "Wallets that often buy early into 2x coins" },
  { kind: "linked", label: "Linked", letter: "L", title: "Holders that share a funder in this coin" },
];

/** Trades under this many SOL are never marked, whatever the setting. */
export const MIN_SOL_FLOOR = 0.25;
export const DEFAULT_MIN_SOL = 0.5;

export interface MarkPrefs {
  on: boolean;
  kinds: MarkKind[];
  minSol: number;
}

export const DEFAULT_MARK_PREFS: MarkPrefs = {
  on: true,
  kinds: MARK_KINDS.map((k) => k.kind),
  minSol: DEFAULT_MIN_SOL,
};

const PREFS_KEY = "ts.chartWalletMarks.v1";

/** A size setting held to the floor; anything unreadable is the default. */
export function clampMinSol(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_MIN_SOL;
  return Math.max(MIN_SOL_FLOOR, Math.round(n * 100) / 100);
}

/** Exported for tests. Stored prefs, read leniently: unknown kinds dropped, the size clamped. */
export function parseMarkPrefs(raw: unknown): MarkPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_MARK_PREFS;
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(MARK_KINDS.map((k) => k.kind));
  return {
    on: typeof r.on === "boolean" ? r.on : DEFAULT_MARK_PREFS.on,
    kinds: Array.isArray(r.kinds)
      ? MARK_KINDS.map((k) => k.kind).filter((k) => (r.kinds as unknown[]).includes(k) && known.has(k))
      : DEFAULT_MARK_PREFS.kinds,
    minSol: r.minSol === undefined ? DEFAULT_MIN_SOL : clampMinSol(r.minSol),
  };
}

export function loadMarkPrefs(): MarkPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? parseMarkPrefs(JSON.parse(raw)) : DEFAULT_MARK_PREFS;
  } catch {
    return DEFAULT_MARK_PREFS;
  }
}

export function saveMarkPrefs(p: MarkPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // A private window or blocked storage: the setting lasts this visit only.
  }
}

/** Every kind a wallet counts as, strongest first (the order of MARK_KINDS). */
export function kindsOf(w: MarkSource): MarkKind[] {
  const out = new Set<MarkKind>();
  if (w.tags.includes("kol")) out.add(w.knownSideOf ? "known" : "kol");
  if (w.side) out.add(w.side.kind);
  if (w.tags.includes("creator")) out.add("dev");
  if (w.tags.includes("risky") || w.tags.includes("dumper")) out.add("risky");
  if (w.tags.includes("winner")) out.add("winner");
  if (w.tags.includes("linked")) out.add("linked");
  return MARK_KINDS.map((k) => k.kind).filter((k) => out.has(k));
}

/** "Cupsey (KOL)", "Cupsey Known Side", "Dev", "Known dumper 7Xk2…9fQa": who made a marked trade. */
export function markName(w: MarkSource, kind: MarkKind): string {
  const kolName = (w.kol ?? "").trim();
  const sideKol = w.side?.kolName?.trim() || (w.side ? shortAddress(w.side.kolWallet) : "");
  const short = shortAddress(w.wallet);
  switch (kind) {
    case "kol":
      return kolName ? `${kolName} (KOL)` : `KOL ${short}`;
    case "known":
      return `${kolName || "KOL"} Known Side`;
    case "funded":
      return `${sideKol} KOL Funded Wallet ${short}`;
    case "probable":
      return `${sideKol} Probable Side ${short}`;
    case "dev":
      return `Dev ${short}`;
    case "risky":
      return `${w.tags.includes("dumper") ? "Known dumper" : "Risky wallet"} ${short}`;
    case "winner":
      return `Winner ${short}`;
    case "linked":
      return `Linked wallet ${short}`;
  }
}

/** One labeled wallet's trade, as the chart marks it. */
export interface WalletMark {
  t: number;
  side: "buy" | "sell";
  sol: number;
  kind: MarkKind;
  letter: string;
  /** The readout's line: "Cupsey (KOL) bought 2.4 SOL". */
  text: string;
  wallet: string;
}

/**
 * The trades to mark under `prefs`: those of wallets of a shown kind (each marked as its strongest
 * shown kind), of at least the set size and never under MIN_SOL_FLOOR. A trade whose size isn't
 * known (a row read before the tape kept amounts) can't be shown to clear it, so it is left out.
 * `exclude`: wallets whose trades are drawn otherwise (the reader's own).
 */
export function walletMarks(
  wallets: readonly MarkSource[],
  prefs: MarkPrefs,
  exclude: ReadonlySet<string> = new Set(),
): WalletMark[] {
  if (!prefs.on || prefs.kinds.length === 0) return [];
  const min = Math.max(MIN_SOL_FLOOR, prefs.minSol);
  const shown = new Set(prefs.kinds);
  const out: WalletMark[] = [];
  for (const w of wallets) {
    if (exclude.has(w.wallet)) continue;
    const kind = kindsOf(w).find((k) => shown.has(k));
    if (!kind) continue;
    const meta = MARK_KINDS.find((k) => k.kind === kind)!;
    const name = markName(w, kind);
    for (const [t, side, sol] of w.trades) {
      if (sol === null || !(sol >= min)) continue;
      out.push({
        t,
        side: side === 1 ? "buy" : "sell",
        sol,
        kind,
        letter: meta.letter,
        text: `${name} ${side === 1 ? "bought" : "sold"} ${solText(sol)} SOL`,
        wallet: w.wallet,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A trade's size: two decimals under 10 SOL, one under 100, whole past it. */
export function solText(sol: number): string {
  return sol < 10 ? sol.toFixed(2) : sol < 100 ? sol.toFixed(1) : Math.round(sol).toString();
}

/** A mark's ring radius in px, growing with the trade's size: 6 at the floor, 10 at 50 SOL or more. */
export function markRadius(sol: number): number {
  const f = Math.min(1, Math.log10(Math.max(1, sol / MIN_SOL_FLOOR)) / Math.log10(50 / MIN_SOL_FLOOR));
  return 6 + 4 * f;
}
