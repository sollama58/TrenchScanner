import { prisma } from "../db.js";

/**
 * A coin's bubble map kept at a moment other than its first model call (user ask 2026-10-16):
 * when it first passed the safety screen inside the band ("screen"), and when a user's filter first
 * caught it and that user opened it ("filter"). The map at the call stays in BubbleMapAtAlert.
 *
 * A moment keeps the top-25 reading the scan had then, the fields the token view's bubble map and
 * top-holder list draw (web src/bubbleMap.ts buildGraph), packed small (packBubbleReading): every
 * screen pass keeps one, so the bytes a row costs are paid about a thousand times a day.
 */

/** Which moment a BubbleMapMoment row keeps. */
export type BubbleMomentKind = "screen" | "filter";

/** The numbers a reading carries beside its lists, named as on TokenSnapshot. */
export const BUBBLE_READING_NUMBERS = [
  "linkedWalletPct",
  "linkedWalletCount",
  "linkedWalletsChecked",
  "top10HolderPct",
  "top10WalletsChecked",
  "sameTimeFundedPct",
  "sameTimeFundedCount",
  "cexFundedPct",
  "cexFundedCount",
  "cexFundedHolders",
  "transferredSupplyPct",
  "transferWalletCount",
  "transferHoldersChecked",
  "kolBundledPct",
  "bundledSupplyPct",
  "bundledSupplyCount",
  "linkedWalletPctExTransfers",
  "linkedWalletCountExTransfers",
  "kolBundledPctExTransfers",
  "bundledSupplyPctExTransfers",
  "bundledSupplyCountExTransfers",
] as const;

/** The lists, named as on TokenSnapshot. */
export const BUBBLE_READING_LISTS = [
  "linkedHolders",
  "linkedClusters",
  "sameTimeClusters",
  "holderTransfers",
  "linkedClustersExTransfers",
] as const;

type NumberField = (typeof BUBBLE_READING_NUMBERS)[number];
type ListField = (typeof BUBBLE_READING_LISTS)[number];

/**
 * What a moment keeps: the holder list and whichever of the other lists and numbers the reading
 * had, unknown ones left out. Shapes as on TokenSnapshot (ScoredToken).
 */
export type BubbleReading = { linkedHolders: unknown[] } & Partial<Record<NumberField, number>> &
  Partial<Record<Exclude<ListField, "linkedHolders">, unknown[]>>;

/**
 * The reading in a snapshot row or a scored token (both name the fields alike), or null without a
 * holder list: there is no map to keep.
 */
export function bubbleReadingOf(
  source: Partial<Record<NumberField | ListField, unknown>>,
): BubbleReading | null {
  const holders = source.linkedHolders;
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const out: Record<string, unknown> = { linkedHolders: holders };
  for (const key of BUBBLE_READING_LISTS) {
    const v = source[key];
    // An empty list without transfers is a reading too: no clusters once transfers are hidden.
    if (
      key === "linkedClustersExTransfers"
        ? Array.isArray(v)
        : key !== "linkedHolders" && Array.isArray(v) && v.length > 0
    )
      out[key] = v;
  }
  for (const key of BUBBLE_READING_NUMBERS) {
    const v = source[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out as BubbleReading;
}

// ---------------------------------------------------------------------------------------------
// Packing

/** The packed form's version, so a later change of shape can still read today's rows. */
const PACK_VERSION = 1;

/** Holder flags, as bits. */
const SNIPER = 1;
const FRESH = 2;
const EMPTY = 4;

type Holder = {
  wallet: string;
  pct: number;
  cexFunder?: string;
  sniper?: boolean;
  fresh?: boolean;
  empty?: boolean;
};
type Cluster = {
  funder: string;
  wallets: { wallet: string; pct: number }[];
  pct: number;
  creatorLinked: boolean;
  transfers?: number;
};
type SameTime = {
  atMs: number;
  spanMs: number;
  wallets: { wallet: string; pct: number; fundedAtMs: number; funder: string | null }[];
  pct: number;
};
type Transfer = { from: string; to: string; pct: number; count: number; lastAtMs?: number | null };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * A reading packed for storage, as JSON text: every list as rows of values in a fixed order rather
 * than objects (no key repeated on each of 25 holders), every wallet address written once in `a`
 * and referred to by its index (an address recurs in the holder list, its cluster, its same-minute
 * group and its transfers), and the numbers in BUBBLE_READING_NUMBERS order. Text, not jsonb:
 * nothing reads inside it, and jsonb spends several bytes on each number. The same reading always
 * packs to the same text, so equal readings compare as equal strings. unpackBubbleReading undoes it.
 */
export function packBubbleReading(reading: BubbleReading): string {
  const addresses: string[] = [];
  const indexOf = new Map<string, number>();
  const at = (a: string | null | undefined): number => {
    if (!a) return -1;
    let i = indexOf.get(a);
    if (i === undefined) {
      i = addresses.length;
      addresses.push(a);
      indexOf.set(a, i);
    }
    return i;
  };
  const h = (reading.linkedHolders as Holder[]).map((x) => {
    const flags = (x.sniper ? SNIPER : 0) | (x.fresh ? FRESH : 0) | (x.empty ? EMPTY : 0);
    const row: number[] = [at(x.wallet), num(x.pct), flags];
    if (x.cexFunder) row.push(at(x.cexFunder));
    return row;
  });
  const clusters = (list: unknown[] | undefined) =>
    ((list ?? []) as Cluster[]).map((x) => {
      const row: unknown[] = [
        at(x.funder),
        (x.wallets ?? []).map((w) => [at(w.wallet), num(w.pct)]),
        num(x.pct),
        x.creatorLinked ? 1 : 0,
      ];
      if (typeof x.transfers === "number") row.push(x.transfers);
      return row;
    });
  const c = clusters(reading.linkedClusters);
  const ce = clusters(reading.linkedClustersExTransfers);
  const t = ((reading.sameTimeClusters ?? []) as SameTime[]).map((x) => [
    num(x.atMs),
    num(x.spanMs),
    num(x.pct),
    (x.wallets ?? []).map((w) => [at(w.wallet), num(w.pct), num(w.fundedAtMs), at(w.funder)]),
  ]);
  const x = ((reading.holderTransfers ?? []) as Transfer[]).map((m) => {
    const row = [at(m.from), at(m.to), num(m.pct), num(m.count)];
    if (typeof m.lastAtMs === "number") row.push(m.lastAtMs);
    return row;
  });
  const n = BUBBLE_READING_NUMBERS.map((k) => reading[k] ?? null);
  return JSON.stringify({
    v: PACK_VERSION,
    a: addresses,
    h,
    ...(c.length ? { c } : {}),
    ...(Array.isArray(reading.linkedClustersExTransfers) ? { ce } : {}),
    ...(t.length ? { t } : {}),
    ...(x.length ? { x } : {}),
    n,
  });
}

/** A packed reading back as bubbleReadingOf made it; null for text in no shape it knows. */
export function unpackBubbleReading(packed: string | null | undefined): BubbleReading | null {
  if (!packed) return null;
  let p: {
    v?: unknown;
    a?: unknown;
    h?: unknown;
    c?: unknown;
    ce?: unknown;
    t?: unknown;
    x?: unknown;
    n?: unknown;
  };
  try {
    p = JSON.parse(packed) as typeof p;
  } catch {
    return null;
  }
  if (p?.v !== PACK_VERSION || !Array.isArray(p.a) || !Array.isArray(p.h)) return null;
  const a = p.a as unknown[];
  const addr = (i: unknown): string | null => (typeof i === "number" && i >= 0 ? str(a[i]) : null);
  const rows = (v: unknown): unknown[][] => (Array.isArray(v) ? v.filter(Array.isArray) : []);
  const linkedHolders = rows(p.h).flatMap(([w, pct, flags, cex]) => {
    const wallet = addr(w);
    if (!wallet) return [];
    const f = num(flags);
    const cexFunder = addr(cex);
    return [
      {
        wallet,
        pct: num(pct),
        ...(cexFunder ? { cexFunder } : {}),
        ...(f & SNIPER ? { sniper: true } : {}),
        ...(f & FRESH ? { fresh: true } : {}),
        ...(f & EMPTY ? { empty: true } : {}),
      },
    ];
  });
  const clusters = (v: unknown) =>
    rows(v).map(([funder, wallets, pct, creatorLinked, transfers]) => ({
      funder: addr(funder) ?? "",
      wallets: rows(wallets).map(([w, wp]) => ({ wallet: addr(w) ?? "", pct: num(wp) })),
      pct: num(pct),
      creatorLinked: creatorLinked === 1,
      ...(typeof transfers === "number" ? { transfers } : {}),
    }));
  const linkedClusters = clusters(p.c);
  const linkedClustersExTransfers = "ce" in p ? clusters(p.ce) : undefined;
  const sameTimeClusters = rows(p.t).map(([atMs, spanMs, pct, wallets]) => ({
    atMs: num(atMs),
    spanMs: num(spanMs),
    wallets: rows(wallets).map(([w, wp, fundedAtMs, funder]) => ({
      wallet: addr(w) ?? "",
      pct: num(wp),
      fundedAtMs: num(fundedAtMs),
      funder: addr(funder),
    })),
    pct: num(pct),
  }));
  const holderTransfers = rows(p.x).map(([from, to, pct, count, lastAtMs]) => ({
    from: addr(from) ?? "",
    to: addr(to) ?? "",
    pct: num(pct),
    count: num(count),
    ...(typeof lastAtMs === "number" ? { lastAtMs } : {}),
  }));
  const numbers = Array.isArray(p.n) ? (p.n as unknown[]) : [];
  return bubbleReadingOf({
    linkedHolders,
    linkedClusters,
    linkedClustersExTransfers,
    sameTimeClusters,
    holderTransfers,
    ...Object.fromEntries(BUBBLE_READING_NUMBERS.map((k, i) => [k, numbers[i]])),
  });
}

// ---------------------------------------------------------------------------------------------
// Keeping a moment

export interface BubbleMomentInput {
  mintAddress: string;
  kind: BubbleMomentKind;
  /** Who caused it: the filter's owner. Absent for the screen pass, which is everyone's. */
  userId?: string;
  filterId?: string;
  /** Shown to everyone: always for a screen pass; for a filter, when it was a public filter. */
  isPublic: boolean;
  /** The moment: the passing scan, or the filter's match. */
  momentAt: Date;
  /** When the reading was taken: the moment's own scan, or the first after it with a holder list. */
  readAt: Date;
  reading: BubbleReading;
}

/**
 * Keeps a moment's map, once: a second save of the same moment (kind, coin and, for a filter, the
 * user) is a no-op. A reading equal to one another moment of the coin already keeps (a filter that
 * caught the coin on the scan that passed it) is not stored twice: the row points at that one
 * (sameAsId). Resolves true when a row was written.
 */
export async function saveBubbleMoment(input: BubbleMomentInput): Promise<boolean> {
  const packed = packBubbleReading(input.reading);
  const same = await prisma.bubbleMapMoment.findFirst({
    where: { mintAddress: input.mintAddress, reading: packed },
    select: { id: true },
  });
  const { count } = await prisma.bubbleMapMoment.createMany({
    data: [
      {
        mintAddress: input.mintAddress,
        kind: input.kind,
        userId: input.userId ?? "",
        filterId: input.filterId ?? null,
        isPublic: input.isPublic,
        momentAt: input.momentAt,
        readAt: input.readAt,
        ...(same ? { sameAsId: same.id } : { reading: packed }),
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}
