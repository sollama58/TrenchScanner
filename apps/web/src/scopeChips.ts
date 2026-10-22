import type { Card } from "./api";
import {
  ageNow,
  cardReadings,
  countCutFor,
  newestStats,
  nowReading,
  recordedPeakOf,
  scanAge,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_BLOCK_ZERO_HELD_PCT,
  SNIPER_TILE_SCALE_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  cexCountText,
} from "./components/AlertCard";
import { change, minutes, pct, usd } from "./format";
import { cardOutcome, outcomeBadge } from "./outcome";
import { cardCalibratedRate } from "./rates";
import {
  TILE_FIRST_BUYERS_OF,
  TILE_RED_FIRST_BUYERS,
  TILE_RED_KOL_BUNDLED_PCT,
  TILE_RED_TRANSFERRED_PCT,
  tileTone,
} from "./tileTone";

/**
 * The data chips a Scope row can show under its figures (user asks 2026-10-18), each read the way
 * the alert card's tile reads it: the newest scan first, the alert's where the newest has none.
 */
export type ScopeChip =
  | "holders"
  | "top10"
  | "fresh"
  | "snipers"
  | "blockZero"
  | "linked"
  | "largest"
  | "empty"
  | "buyers"
  | "dev"
  | "cex"
  | "kol"
  | "transferred"
  | "vol5m"
  | "vol1h"
  | "liquidity"
  | "vol24h"
  | "age"
  | "score"
  | "modelScore"
  | "conviction"
  | "rate2x"
  | "narrative"
  | "alertMcap"
  | "peak"
  | "ath"
  | "result"
  | "move"
  | "drawdown"
  | "gradeLeft"
  | "flagged"
  | "buySell"
  | "contract";

export interface ChipReading {
  value: string;
  title: string;
  /** Where the reading sits on its tile's color scale, or null for none. */
  tone: number | null;
  /** Fails the safety screen's cut (or the tile's red bound). */
  risky: boolean;
  /** The age of the scan behind a scan chip once that is old enough to matter (AlertCard scanAge). */
  aged?: string;
}

/** The chips read from the card's newest scan, which dim and say its age once it is old. */
const SCAN_CHIPS: ReadonlySet<ScopeChip> = new Set<ScopeChip>([
  "holders",
  "top10",
  "largest",
  "vol5m",
  "vol1h",
  "vol24h",
  "liquidity",
  "score",
]);

type Readings = ReturnType<typeof cardReadings>;
type Stats = ReturnType<typeof newestStats>;

export const SCOPE_CHIP_DEFS: {
  id: ScopeChip;
  /** In the settings window. */
  label: string;
  /** On the chip. */
  short: string;
  group: "Holders" | "Wallets" | "Market" | "Alert" | "Token";
  read: (card: Card, r: Readings, t: Stats, now: number) => ChipReading | null;
}[] = [
  {
    id: "holders",
    label: "Holders",
    short: "Hold",
    group: "Holders",
    read: (_c, _r, t) =>
      t.holders == null
        ? null
        : { value: t.holders.toLocaleString(), title: "Holders", tone: null, risky: false },
  },
  {
    id: "top10",
    label: "Top 10 %",
    short: "T10",
    group: "Holders",
    read: (_c, _r, t) =>
      t.top10Pct == null
        ? null
        : {
            value: pct(t.top10Pct),
            title: "Top 10 holders' share of supply",
            tone: tileTone(t.top10Pct, SAFETY_REJECT_TOP10_HOLDER_PCT),
            risky: t.top10Pct >= SAFETY_REJECT_TOP10_HOLDER_PCT,
          },
  },
  {
    id: "largest",
    label: "Largest holder %",
    short: "Top1",
    group: "Holders",
    read: (_c, r) =>
      r.largestPct == null
        ? null
        : {
            value: pct(r.largestPct, 1),
            title: "One wallet's share of supply, pools aside",
            tone: tileTone(r.largestPct, SAFETY_MAX_LARGEST_HOLDER_PCT),
            risky: r.largestPct > SAFETY_MAX_LARGEST_HOLDER_PCT,
          },
  },
  {
    id: "dev",
    label: "Dev still holds",
    short: "Dev",
    group: "Holders",
    read: (_c, r) =>
      r.devHolding == null
        ? null
        : {
            value: r.devHolding ? "holds" : "sold",
            title: r.devHolding ? "The dev still holds the token" : "The dev has sold out",
            tone: null,
            risky: false,
          },
  },
  {
    id: "fresh",
    label: "Fresh wallets",
    short: "Fresh",
    group: "Wallets",
    read: (_c, r) =>
      r.freshPct == null
        ? null
        : {
            value: pct(r.freshPct),
            title: "Top holders on fresh wallets",
            tone: tileTone(r.freshPct, SAFETY_MAX_FRESH_WALLET_PCT),
            risky: r.freshPct >= SAFETY_MAX_FRESH_WALLET_PCT,
          },
  },
  {
    id: "empty",
    label: "Empty wallets",
    short: "Empty",
    group: "Wallets",
    read: (_c, r) =>
      r.emptyPct == null
        ? null
        : {
            value: pct(r.emptyPct),
            title: "Top 10 holders with under $25 of other tokens",
            tone: tileTone(r.emptyPct, SAFETY_REJECT_EMPTY_WALLET_PCT),
            risky: r.emptyPct >= SAFETY_REJECT_EMPTY_WALLET_PCT,
          },
  },
  {
    id: "snipers",
    label: "Snipers",
    short: "Snip",
    group: "Wallets",
    read: (_c, r) =>
      !r.snipers
        ? null
        : {
            value: `${r.snipers.count}/${r.snipers.of}`,
            title: "Top holders who were among the launch's first 25 buyers",
            tone: tileTone(r.snipers.top10Pct, SNIPER_TILE_SCALE_PCT),
            risky: false,
          },
  },
  {
    id: "blockZero",
    label: "Block 0",
    short: "B0",
    group: "Wallets",
    read: (_c, r) =>
      r.blockZeroPct == null
        ? null
        : {
            value: pct(r.blockZeroPct, 1),
            title: "Supply held by the wallets that bought in the launch's own block (block-zero snipers)",
            tone: tileTone(r.blockZeroPct, SAFETY_REJECT_BLOCK_ZERO_HELD_PCT),
            risky: r.blockZeroPct >= SAFETY_REJECT_BLOCK_ZERO_HELD_PCT,
          },
  },
  {
    id: "buyers",
    label: "First buyers holding",
    short: "1st",
    group: "Wallets",
    read: (_c, r) => {
      if (r.firstHolding == null) return null;
      const of = r.firstSeen ?? TILE_FIRST_BUYERS_OF;
      return {
        value: `${r.firstHolding}/${of}`,
        title: "Of the launch's first buyers, how many still hold 0.1% of supply or more",
        tone: tileTone(r.firstHolding, (TILE_RED_FIRST_BUYERS * of) / TILE_FIRST_BUYERS_OF),
        risky: false,
      };
    },
  },
  {
    id: "linked",
    label: "Linked wallets",
    short: "Link",
    group: "Wallets",
    read: (_c, r) => {
      if (r.linkedPct == null) return null;
      const cut = countCutFor(SAFETY_REJECT_LINKED_COUNT, r.linkedCount?.of);
      return {
        value: pct(r.linkedPct),
        title: r.linkedCount
          ? `${r.linkedCount.linked} of the top ${r.linkedCount.of} holders are linked`
          : "Supply held by linked wallets",
        tone: r.linkedCount ? tileTone(r.linkedCount.linked, cut) : null,
        risky: !!r.linkedCount && r.linkedCount.linked >= cut,
      };
    },
  },
  {
    id: "cex",
    label: "Exchange-funded %",
    short: "CEX",
    group: "Wallets",
    read: (_c, r) => {
      if (r.cexPct == null) return null;
      // As the card's tile: the count of exchange-funded top holders, red at the screen's cut.
      const cut = countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, r.cexHolders);
      return {
        value: cexCountText(r.cexCount, r.cexHolders) ?? pct(r.cexPct),
        title: `Top holders opened from an exchange, ${pct(r.cexPct)} of supply. The safety screen rejects ${cut} or more.`,
        tone: tileTone(r.cexCount, cut),
        risky: r.cexCount !== null && r.cexCount >= cut,
      };
    },
  },
  {
    id: "kol",
    label: "KOL bundled %",
    short: "KOL",
    group: "Wallets",
    read: (_c, r) =>
      r.kolBundledPct == null
        ? null
        : {
            value: pct(r.kolBundledPct),
            title: "Supply in KOLs' bundles",
            tone: tileTone(r.kolBundledPct, TILE_RED_KOL_BUNDLED_PCT),
            risky: false,
          },
  },
  {
    id: "transferred",
    label: "Transferred supply %",
    short: "Xfer",
    group: "Wallets",
    read: (_c, r) =>
      r.transferredPct == null
        ? null
        : {
            value: pct(r.transferredPct),
            title: "Supply moved holder to holder",
            tone: tileTone(r.transferredPct, TILE_RED_TRANSFERRED_PCT),
            risky: false,
          },
  },
  {
    id: "flagged",
    label: "Flagged traders",
    short: "Flag",
    group: "Wallets",
    read: (c) => {
      const s = c.snapshot;
      if (s.flaggedBuyers == null && s.flaggedSellers == null) return null;
      const buyers = s.flaggedBuyers ?? 0;
      const sellers = s.flaggedSellers ?? 0;
      return {
        value: `${buyers}B ${sellers}S`,
        title: `Risky wallets and known dumpers in the trades before the call: ${buyers} buying (${(s.flaggedBuySol ?? 0).toFixed(1)} SOL), ${sellers} selling (${(s.flaggedSellSol ?? 0).toFixed(1)} SOL)`,
        tone: null,
        risky: buyers + sellers > 0,
      };
    },
  },
  {
    id: "buySell",
    label: "Buys / sells 24h",
    short: "B/S",
    group: "Market",
    read: (c) => {
      const s = c.latestSnapshot ?? c.snapshot;
      if (s.buys24h == null || s.sells24h == null) return null;
      return {
        value: `${s.buys24h.toLocaleString()}/${s.sells24h.toLocaleString()}`,
        title: `${s.buys24h.toLocaleString()} buys and ${s.sells24h.toLocaleString()} sells over 24 hours`,
        tone: null,
        risky: false,
      };
    },
  },
  {
    id: "vol5m",
    label: "Volume 5m",
    short: "V5m",
    group: "Market",
    read: (_c, _r, t) =>
      t.volume5mUsd == null
        ? null
        : {
            value: usd(t.volume5mUsd),
            title: "Trading volume over the last 5 minutes",
            tone: null,
            risky: false,
          },
  },
  {
    id: "vol1h",
    label: "Volume 1h",
    short: "V1h",
    group: "Market",
    read: (_c, _r, t) =>
      t.volume1hUsd == null
        ? null
        : { value: usd(t.volume1hUsd), title: "Trading volume over the last hour", tone: null, risky: false },
  },
  {
    id: "liquidity",
    label: "Liquidity",
    short: "Liq",
    group: "Market",
    read: (c) => {
      const liq = c.latestSnapshot?.liquidityUsd ?? c.snapshot.liquidityUsd;
      return liq == null ? null : { value: usd(liq), title: "Pool liquidity", tone: null, risky: false };
    },
  },
  {
    id: "vol24h",
    label: "Volume 24h",
    short: "V24h",
    group: "Market",
    read: (_c, _r, t) =>
      t.volume24hUsd == null
        ? null
        : {
            value: usd(t.volume24hUsd),
            title: "Trading volume over the last 24 hours (since launch, for a younger token)",
            tone: null,
            risky: false,
          },
  },
  {
    id: "score",
    label: "Score",
    short: "Score",
    group: "Market",
    read: (_c, _r, t) =>
      t.score == null
        ? null
        : { value: String(Math.round(t.score)), title: "The scan's score", tone: null, risky: false },
  },
  {
    id: "age",
    label: "Token age",
    short: "Age",
    group: "Token",
    read: (c, _r, _t, now) => {
      const age = ageNow(c.snapshot, now);
      return age == null
        ? null
        : { value: minutes(age), title: "How old the coin is now", tone: null, risky: false };
    },
  },
  {
    id: "contract",
    label: "Contract check",
    short: "Contract",
    group: "Token",
    read: (c) => {
      const s = c.latestSnapshot ?? c.snapshot;
      const issues = [
        s.mintAuthorityActive === true && ["Mint", "mint authority still active"],
        s.freezeAuthorityActive === true && ["Freeze", "freeze authority still active"],
        s.lpBurned === false && ["LP", "LP not burned"],
        s.isMayhemMode === true && ["Mayhem", "Mayhem Mode"],
      ].filter((x): x is string[] => Array.isArray(x));
      const read = [s.mintAuthorityActive, s.freezeAuthorityActive, s.lpBurned].some((x) => x != null);
      if (!read && !s.isMayhemMode) return null;
      return issues.length === 0
        ? { value: "OK", title: "Mint and freeze authority renounced, LP burned", tone: null, risky: false }
        : {
            value: issues.map((i) => i[0]).join(" "),
            title: `Contract: ${issues.map((i) => i[1]).join(", ")}`,
            tone: null,
            risky: true,
          };
    },
  },
  {
    id: "alertMcap",
    label: "Market cap at alert",
    short: "At",
    group: "Alert",
    read: (c) =>
      c.snapshot.marketCapUsd == null
        ? null
        : { value: usd(c.snapshot.marketCapUsd), title: "Market cap at the alert", tone: null, risky: false },
  },
  {
    id: "peak",
    label: "Peak",
    short: "Peak",
    group: "Alert",
    read: (c) => {
      const peak = peakOf(c);
      return peak == null || peak <= 0
        ? null
        : { value: `+${pct(peak)}`, title: "Highest since the alert", tone: null, risky: false };
    },
  },
  {
    id: "ath",
    label: "ATH market cap",
    short: "ATH",
    group: "Alert",
    read: (c) => {
      const peak = peakOf(c);
      const at = c.snapshot.marketCapUsd;
      return peak == null || peak <= 0 || !at
        ? null
        : {
            value: usd(at * (1 + peak / 100)),
            title: "Highest market cap since the alert",
            tone: null,
            risky: false,
          };
    },
  },
  {
    id: "result",
    label: "Result",
    short: "Result",
    group: "Alert",
    read: (c, _r, _t, now) => {
      const outcome = cardOutcome(c, now);
      if (!outcome) return null;
      const badge = outcomeBadge(outcome);
      return { value: badge.text, title: badge.text, tone: null, risky: false };
    },
  },
  {
    id: "move",
    label: "Move since alert",
    short: "Move",
    group: "Alert",
    read: (c) => {
      const move = change(c.snapshot.marketCapUsd, nowReading(c));
      return move == null
        ? null
        : {
            value: `${move >= 0 ? "▲" : "▼"}${pct(Math.abs(move))}`,
            title: "Market cap now against the alert's",
            tone: null,
            risky: false,
          };
    },
  },
  {
    id: "drawdown",
    label: "Worst drop, first hour",
    short: "DD",
    group: "Alert",
    read: (c) => {
      const dd = c.outcome?.maxDrawdown1hPct;
      return dd == null
        ? null
        : {
            value: `-${pct(Math.abs(dd))}`,
            title: "The deepest fall below the alert's market cap in its first hour",
            tone: null,
            risky: false,
          };
    },
  },
  {
    id: "gradeLeft",
    label: "Time left to grade",
    short: "Left",
    group: "Alert",
    read: (c) => {
      const left = c.outcome && !c.outcome.finalized ? c.outcome.minutesLeft : null;
      return left == null || left <= 0
        ? null
        : {
            value: `${Math.ceil(left)}m`,
            title: "Minutes until the alert is graded",
            tone: null,
            risky: false,
          };
    },
  },
  {
    id: "modelScore",
    label: "Model score",
    short: "Model",
    group: "Alert",
    read: (c) => {
      const calls = c.curated?.calledBy ?? [];
      if (!c.curated) return null;
      const top = calls.length > 0 ? Math.max(...calls.map((x) => x.confidence)) : c.curated.confidence;
      return {
        value: top.toFixed(0),
        title:
          calls.length > 1
            ? calls.map((x) => `${x.modelName ?? "Model"}: score ${x.confidence.toFixed(0)}`).join("\n")
            : `${c.curated.modelName ?? "Model"}: score ${c.curated.confidence.toFixed(0)}`,
        tone: null,
        risky: false,
      };
    },
  },
  {
    id: "conviction",
    label: "High conviction",
    short: "HC",
    group: "Alert",
    read: (c) =>
      c.curated && (c.curated.tier === "high" || (c.curated.calledBy ?? []).some((x) => x.tier === "high"))
        ? {
            value: "high",
            title: "High conviction: in the model's top half-percent of decision moments",
            tone: null,
            risky: false,
          }
        : null,
  },
  {
    id: "rate2x",
    label: "Calibrated 2x rate",
    short: "2x",
    group: "Alert",
    read: (c) => {
      if (!c.curated) return null;
      const rate = cardCalibratedRate(c.curated, c.curated.calledBy ?? []);
      return rate == null
        ? null
        : {
            value: `≈${rate.toFixed(0)}%`,
            title:
              "Of recent out-of-sample alerts ranked like this one, the share that hit 2x within 15 min of the alert, before a 50% stop",
            tone: null,
            risky: false,
          };
    },
  },
  {
    id: "narrative",
    label: "Narrative read",
    short: "Narr",
    group: "Alert",
    read: (c) => {
      const n = c.curated?.narrative;
      return n
        ? {
            value: n.verdict,
            title:
              n.verdict === "agrees"
                ? "The Narrative seat's deep read would have flagged this coin too"
                : "The Narrative seat's deep read would not have flagged this coin",
            tone: null,
            risky: n.verdict !== "agrees",
          }
        : null;
    },
  },
];

/** The peak since the alert as the row reads it: the recorded peak, or the move now if higher. */
function peakOf(c: Card): number | null {
  const move = change(c.snapshot.marketCapUsd, nowReading(c));
  const { pct: recorded } = recordedPeakOf(c);
  return move !== null && move > 0 ? Math.max(recorded ?? 0, move) : recorded;
}

export const SCOPE_CHIP_IDS: ScopeChip[] = SCOPE_CHIP_DEFS.map((c) => c.id);

/** The chips Scope starts with: few, so a row reads at a glance (user ask 2026-10-18: less dense), with the move since the alert (2026-10-19). */
export const DEFAULT_SCOPE_CHIPS: ScopeChip[] = ["move", "holders", "top10", "fresh"];

/** A row's chips, in the settings window's order, leaving out readings the card doesn't have. */
export function rowChips(
  card: Card,
  chips: readonly ScopeChip[],
  now = Date.now(),
): ({ id: ScopeChip; short: string } & ChipReading)[] {
  if (chips.length === 0) return [];
  const r = cardReadings(card, "newest");
  const t = newestStats(card);
  const aged = scanAge(card, now);
  return SCOPE_CHIP_DEFS.flatMap((d) => {
    if (!chips.includes(d.id)) return [];
    const reading = d.read(card, r, t, now);
    if (!reading) return [];
    if (aged !== null && SCAN_CHIPS.has(d.id))
      return [
        { id: d.id, short: d.short, ...reading, aged, title: `${reading.title}, from a scan ${aged} ago` },
      ];
    return [{ id: d.id, short: d.short, ...reading }];
  });
}
