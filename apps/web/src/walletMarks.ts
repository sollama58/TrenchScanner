import type { ChartMarkKind } from "./api";
import { CHART_MARK_MAX_SOL, CHART_MARK_MIN_SOL } from "./appearance";
import { shortAddress } from "./format";

/**
 * Labeled-wallet trade marks on the token chart (user ask 2026-10-18): the trades of KOLs, their
 * side wallets and the other flagged wallets in the coin (apps/api/src/tokenChart.ts MarkedWallet),
 * drawn as lettered rings, apart from a Pro trader's own buy and sell arrows. The reader picks
 * which kinds of wallet show and the smallest trade that does in Customize (saved with the feed's
 * appearance, so every device marks the same); trades under MIN_SOL_FLOOR never show (only the
 * reader's own trades do, and those are drawn elsewhere).
 */

/** A flagged wallet as the chart answer sends it, the parts the marks read. */
export interface MarkSource {
  wallet: string;
  tags: readonly string[];
  kol?: string | null;
  knownSideOf?: string;
  side?: {
    kind: "funded" | "probable";
    kolWallet: string;
    kolName: string | null;
    tracked?: "kol" | "tracked";
  };
  /** The name the reader gave it as a User Tracked wallet (tag "tracked"): marked with the KOLs, as "T". */
  tracked?: string;
  trades: readonly (readonly [number, 1 | -1, number | null])[];
}

/** The kinds of wallet a reader can show or hide, in the order the picker lists them. */
export type MarkKind = ChartMarkKind;

export const MARK_KINDS: readonly { kind: MarkKind; label: string; letter: string; title: string }[] = [
  {
    kind: "kol",
    label: "KOLs",
    letter: "K",
    title: "Wallets on the KOL roster, and the wallets you labeled (User Tracked ones as T)",
  },
  // A KOL's sides are marked as the KOL is, K or its picture (user ask 2026-10-20); the readout
  // still says which tie it is.
  { kind: "known", label: "Known Sides", letter: "K", title: "Other wallets we know are a KOL's own" },
  { kind: "funded", label: "KOL Funded", letter: "K", title: "Wallets a KOL paid for (their first SOL)" },
  {
    kind: "probable",
    label: "Probable Sides",
    letter: "K",
    title: "Wallets that keep buying a KOL's coins within minutes of it, or move coins with it",
  },
  { kind: "dev", label: "Dev", letter: "D", title: "The coin's creator" },
  { kind: "risky", label: "Risky & dumpers", letter: "R", title: "High risk scores and known dumpers" },
  { kind: "winner", label: "Winners", letter: "W", title: "Wallets that often buy early into 2x coins" },
  { kind: "linked", label: "Linked", letter: "L", title: "Holders that share a funder in this coin" },
];

/** Trades under this many SOL are never marked, whatever the setting. */
export const MIN_SOL_FLOOR = CHART_MARK_MIN_SOL;
export const DEFAULT_MIN_SOL = 0.5;
const MAX_SOL = CHART_MARK_MAX_SOL;

/** What the reader chose in Customize (FeedAppearance's chartMarks, chartMarkKinds, chartMarkMinSol). */
export interface MarkPrefs {
  on: boolean;
  kinds: readonly MarkKind[];
  minSol: number;
}

/** The reader's appearance as mark prefs. */
export function markPrefsOf(look: {
  chartMarks: boolean;
  chartMarkKinds: readonly MarkKind[];
  chartMarkMinSol: number;
}): MarkPrefs {
  return { on: look.chartMarks, kinds: look.chartMarkKinds, minSol: look.chartMarkMinSol };
}

/** A typed size held to the floor (and the account's ceiling); anything unreadable is the default. */
export function clampMinSol(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_MIN_SOL;
  return Math.min(MAX_SOL, Math.max(MIN_SOL_FLOOR, Math.round(n * 100) / 100));
}

/** Every kind a wallet counts as, strongest first (the order of MARK_KINDS). */
export function kindsOf(w: MarkSource): MarkKind[] {
  const out = new Set<MarkKind>();
  if (w.tags.includes("kol")) out.add(w.knownSideOf ? "known" : "kol");
  // A wallet the reader labeled User Tracked is marked with the KOLs (lettered T, markLetter).
  if (w.tags.includes("tracked")) out.add("kol");
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
      if (isTrackedOnly(w)) return `${w.tracked!.trim() || short} (Tracked)`;
      return kolName ? `${kolName} (KOL)` : `KOL ${short}`;
    case "known":
      return `${kolName || "KOL"} Known Side`;
    case "funded":
      return w.side?.tracked === "tracked"
        ? `${sideKol} Funded Wallet ${short}`
        : `${sideKol} KOL Funded Wallet ${short}`;
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

/** A wallet the reader tracks that isn't also a KOL: marked with the KOLs, but as User Tracked. */
const isTrackedOnly = (w: MarkSource) => !!w.tracked && !w.tags.includes("kol");

/**
 * A mark's letter: its kind's (K for a KOL and its sides), but T for a User Tracked wallet marked
 * with the KOLs, and for the wallets it funded or that side with it.
 */
export function markLetter(w: MarkSource, kind: MarkKind): string {
  if (kind === "kol" && isTrackedOnly(w)) return "T";
  if ((kind === "funded" || kind === "probable") && w.side?.tracked === "tracked") return "T";
  return MARK_KINDS.find((k) => k.kind === kind)!.letter;
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
  /** A KOL's X picture (an API path), drawn in place of the letter while the reader shows them. */
  avatar?: string;
  /** The wallet whose name carries the mark's picture: the KOL's own, or the KOL a side is tied to. */
  picFrom?: string;
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
    const kinds = kindsOf(w);
    // A known dumper stays hidden while dumpers are off, even when it is also linked or a KOL (the
    // coin's own dev still shows as the dev).
    if (w.tags.includes("dumper") && !shown.has("risky") && !kinds.includes("dev")) continue;
    const kind = kinds.find((k) => shown.has(k));
    if (!kind) continue;
    const letter = markLetter(w, kind);
    const name = markName(w, kind);
    const picFrom = picWallet(w, kind);
    for (const [t, side, sol] of w.trades) {
      if (sol === null || !(sol >= min)) continue;
      out.push({
        t,
        side: side === 1 ? "buy" : "sell",
        sol,
        kind,
        letter,
        text: `${name} ${side === 1 ? "bought" : "sold"} ${solText(sol)} SOL`,
        wallet: w.wallet,
        ...(picFrom ? { picFrom } : {}),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The wallet whose name carries a mark's KOL picture: a KOL's own; a Known Side's, or its KOL's main
 * wallet where the chart knows it; a funded wallet's or Probable Side's KOL. None for the rest.
 */
function picWallet(w: MarkSource, kind: MarkKind): string | null {
  switch (kind) {
    case "kol":
      return isTrackedOnly(w) ? null : w.wallet;
    case "known":
      return w.knownSideOf ?? w.wallet;
    case "funded":
    case "probable":
      return w.side && w.side.tracked !== "tracked" ? w.side.kolWallet : null;
    default:
      return null;
  }
}

/**
 * The chart's marked wallets across its re-reads (user report 2026-10-20: marks that disappear):
 * the API sends the 40 strongest wallets each time, so one near the cut came and went between
 * reads. A wallet read before stays, with the trades of every read, and takes the newest read's
 * labels when it is in it.
 */
export function keepMarkSources<T extends MarkSource>(prev: readonly T[], next: readonly T[]): T[] {
  if (prev.length === 0) return next as T[];
  const nextBy = new Map(next.map((w) => [w.wallet, w]));
  const prevBy = new Map(prev.map((w) => [w.wallet, w]));
  const out: T[] = [];
  for (const w of next) {
    const old = prevBy.get(w.wallet);
    if (!old) {
      out.push(w);
      continue;
    }
    const seen = new Set(w.trades.map(([t, side]) => `${t}|${side}`));
    const extra = old.trades.filter(([t, side]) => !seen.has(`${t}|${side}`));
    out.push(extra.length ? { ...w, trades: [...extra, ...w.trades].sort((a, b) => a[0] - b[0]) } : w);
  }
  for (const w of prev) if (!nextBy.has(w.wallet)) out.push(w);
  return out;
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

/** A live trade as the marks read it (liveTrades.ts LiveTokenTrade). */
export interface LiveMarkTrade {
  wallet: string;
  side: "buy" | "sell";
  sol: number | null;
  atMs: number;
}

/** Two reads of one trade are this close at most (the tape's time is the block's, live's the log's). */
const SAME_TRADE_MS = 3_000;

/**
 * The chart's flagged wallets with the coin's live trades folded in (user ask 2026-10-19: flagged
 * wallets' trades should show as they happen, not when the chart's tape next catches up). A flagged
 * wallet gets each live trade its rows don't already hold; a trader the chart doesn't flag joins
 * when its name says it is a KOL, a KOL's Known Side or a wallet the reader tracks, or when it is a
 * KOL's funded wallet or Probable Side (`sides`, possibleSides.ts, read only while those show).
 */
export function withLiveMarks(
  wallets: readonly MarkSource[],
  live: readonly LiveMarkTrade[],
  names: Readonly<Record<string, { name: string; source: string; mine?: boolean }>>,
  sides: Readonly<
    Record<
      string,
      readonly {
        kolWallet: string;
        kolName: string | null;
        funded?: boolean;
        known?: boolean;
        tracked?: "kol" | "tracked";
      }[]
    >
  > = {},
): MarkSource[] {
  if (live.length === 0) return wallets as MarkSource[];
  type Trade = MarkSource["trades"][number];
  const byWallet = new Map<string, Omit<MarkSource, "trades"> & { trades: Trade[] }>();
  for (const w of wallets) byWallet.set(w.wallet, { ...w, trades: [...w.trades] });
  for (const t of live) {
    let w = byWallet.get(t.wallet);
    if (!w) {
      const n = names[t.wallet];
      if (n?.source === "kol") w = { wallet: t.wallet, tags: ["kol"], kol: n.name, trades: [] };
      else if (n?.source === "kol-side")
        // Named "<KOL> Known Side" (markName adds it back); the KOL's main wallet isn't in the name.
        w = {
          wallet: t.wallet,
          tags: ["kol"],
          kol: n.name.replace(/\s*Known Side$/i, ""),
          knownSideOf: t.wallet,
          trades: [],
        };
      else if (n?.source === "tracked" || n?.mine)
        w = { wallet: t.wallet, tags: ["tracked"], tracked: n.name, trades: [] };
      else {
        // A Known Side is named as one above; the strongest other tie, funded ahead of probable.
        const all = sides[t.wallet]?.filter((x) => !x.known) ?? [];
        const s = all.find((x) => x.funded) ?? all[0];
        if (!s) continue;
        w = {
          wallet: t.wallet,
          tags: ["side"],
          side: {
            kind: s.funded ? "funded" : "probable",
            kolWallet: s.kolWallet,
            kolName: s.kolName,
            ...(s.tracked ? { tracked: s.tracked } : {}),
          },
          trades: [],
        };
      }
      byWallet.set(t.wallet, w);
    }
    const side: 1 | -1 = t.side === "buy" ? 1 : -1;
    if (w.trades.some(([at, s]) => s === side && Math.abs(at - t.atMs) <= SAME_TRADE_MS)) continue;
    w.trades.push([t.atMs, side, t.sol]);
  }
  for (const w of byWallet.values()) w.trades.sort((a, b) => a[0] - b[0]);
  return [...byWallet.values()];
}

/** What the API knows of a live trader (apps/api/src/liveTraderLabels.ts LiveTraderLabel). */
export interface LiveTraderLabel {
  name?: { name: string; source: "kol" | "kol-side"; avatar?: string };
  side?: { kolWallet: string; kolName: string | null; funded?: boolean; avatar?: string };
  risky?: boolean;
  dumper?: boolean;
  winner?: boolean;
}

/**
 * The chart's flagged wallets with the live traders the live feed labeled (user ask 2026-10-20:
 * flag trades from TrenchScanner's own records as they land): a KOL, a Known Side, a KOL's funded
 * wallet or Probable Side, a risky wallet, a known dumper or a winner joins with no trades of its
 * own; withLiveMarks then gives it its live trades. A wallet the chart already flags is left as the
 * chart has it.
 */
export function withLabeledTraders(
  wallets: readonly MarkSource[],
  labels: Readonly<Record<string, LiveTraderLabel>>,
): MarkSource[] {
  const have = new Set(wallets.map((w) => w.wallet));
  const add: MarkSource[] = [];
  for (const [wallet, l] of Object.entries(labels)) {
    if (have.has(wallet)) continue;
    const tags: string[] = [];
    let w: MarkSource = { wallet, tags, trades: [] };
    if (l.name) {
      tags.push("kol");
      w =
        l.name.source === "kol-side"
          ? { ...w, kol: l.name.name.replace(/\s*Known Side$/i, ""), knownSideOf: wallet }
          : { ...w, kol: l.name.name };
    } else if (l.side) {
      tags.push("side");
      w = {
        ...w,
        side: {
          kind: l.side.funded ? "funded" : "probable",
          kolWallet: l.side.kolWallet,
          kolName: l.side.kolName,
        },
      };
    }
    if (l.risky) tags.push("risky");
    if (l.dumper) tags.push("dumper");
    if (l.winner) tags.push("winner");
    if (tags.length > 0) add.push(w);
  }
  return add.length > 0 ? [...wallets, ...add] : (wallets as MarkSource[]);
}

/** The KOL pictures the live feed's labels carry, keyed as withAvatars reads them. */
export function labelAvatars(
  labels: Readonly<Record<string, LiveTraderLabel>>,
): Record<string, { avatar: string }> {
  const out: Record<string, { avatar: string }> = {};
  for (const [wallet, l] of Object.entries(labels)) {
    if (l.name?.avatar) out[wallet] = { avatar: l.name.avatar };
    if (l.side?.avatar) out[l.side.kolWallet] = { avatar: l.side.avatar };
  }
  return out;
}

/**
 * The marks with their KOL's X picture (user ask 2026-10-19: KOL bubbles by their pictures, on by
 * default): a KOL's trade, or any of its sides' (user ask 2026-10-20), where the name of the wallet
 * the picture comes from (`picFrom`) carries one; a Known Side's own name may too.
 */
export function withAvatars(
  marks: readonly WalletMark[],
  names: Readonly<Record<string, { avatar?: string }>>,
): WalletMark[] {
  return marks.map((m) => {
    const avatar = m.picFrom ? (names[m.picFrom]?.avatar ?? names[m.wallet]?.avatar) : undefined;
    return avatar ? { ...m, avatar } : m;
  });
}

/** The wallets whose names carry the marks' pictures. */
export function picWallets(marks: readonly WalletMark[]): string[] {
  const out = new Set<string>();
  for (const m of marks) {
    if (!m.picFrom) continue;
    out.add(m.picFrom);
    if (m.kind === "known") out.add(m.wallet);
  }
  return [...out];
}
