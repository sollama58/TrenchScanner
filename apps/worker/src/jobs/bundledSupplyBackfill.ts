import { prisma, createLogger, Prisma } from "@trenchscanner/core";
import {
  kolBundledByMint,
  type KolBundledReading,
  type KolBundledSource,
  type KolTie,
} from "./kolBundled.js";

const logger = createLogger("bundled-supply-backfill");

/**
 * Bundled % (user ask 2026-10-15) for the rows banked before the scan recorded it, once.
 *
 * Bundled % is the linked holders and the KOL bundles together, so it can only be rebuilt where
 * the KOL half was read at the time: rows from when KOL Bundled % started (2026-10-14 19:44 UTC).
 * Older rows keep it null; rebuilding their KOL half from today's roster and side-wallet table
 * would hand the models what was learned after the decision.
 *
 * - KOL Bundled % 0: no KOL bundled anyone, so Bundled % is the linked share itself, exactly.
 * - KOL Bundled % above 0: the KOL bundles are rebuilt from the scan's stored holder list, the
 *   roster as it stood when the scan ran, and the holders' funders, and kept only where the
 *   rebuilt KOL Bundled % matches the one recorded at the time (the same KOL groups, then). A row
 *   whose KOL groups differ keeps it null.
 *
 * Point-in-time (2026-10-16, data-correctness audit, skew section 8): a rebuild uses only what
 * the scan could have known. The roster is read as of the scan (KolWallet.firstSeenAt, when the
 * roster first carried the wallet; a wallet dropped and re-added counts from the re-add, and
 * entries from before the column count from the roster's first sync, 2026-10-13, before any row
 * in the window). The possible side wallets are not read at all: KolPossibleSide is rebuilt
 * whole every hour from later coins and their outcomes, with no record of when a label was first
 * earned, so a bundle that needed one stays null through the match rule. Funders are first
 * transactions, which never change. The scan behind an outcome row is a snapshot taken at or
 * before the anchor, never after. Rows backfilled before this ran can't be told apart and read
 * null to the learners (core's features.ts BUNDLED_SUPPLY_POINT_IN_TIME_FROM).
 *
 * Covers the decision rows' feature vectors (CandidateOutcome.features, what the models train
 * on) and the snapshots alert cards show (CuratedAlert's and Match's), which the Linked tile
 * reads. A few hundred rows a run on the history re-grade's schedule; once through, a no-op that
 * never asks the database again in this process.
 */
export const BUNDLED_SUPPLY_BACKFILL_FROM = new Date("2026-10-14T19:00:00Z");
export const BUNDLED_SUPPLY_ROWS_PER_RUN = 400;
/** How far before its outcome's anchor a snapshot can sit and still be the scan that banked it. */
const SNAPSHOT_WINDOW_MS = 90_000;
/** Recorded and rebuilt KOL Bundled % agree within rounding. */
const SAME_PCT = 0.011;

let cursor: { at: Date; id: string } | null = null;
let snapshotCursor: string | null = null;
let until: Date | null = null;
let finished = false;
const totals = { exact: 0, rebuilt: 0, changed: 0, noScan: 0, unknown: 0, snapshots: 0 };

/** Test hook. */
export function resetBundledSupplyBackfill(): void {
  cursor = null;
  snapshotCursor = null;
  until = null;
  finished = false;
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = 0;
}

export interface BackfillDeps {
  /**
   * The possible side wallets of these wallets. None by default (2026-10-16): the live table
   * (KolPossibleSide) holds today's labels, not the scan's. A test hook.
   */
  loadSides?: (wallets: readonly string[]) => Promise<KolTie[]>;
  now?: () => number;
  rowsPerRun?: number;
}

/** No side wallets: see the file's note on point-in-time rebuilds. */
const noSides = async (): Promise<KolTie[]> => [];

type ScanRow = {
  id: string;
  /** When the scan ran: the roster is read as it stood then. */
  takenAt: Date;
  kolBundledPct: number | null;
  linkedWalletPct: number | null;
  linkedWalletCount: number | null;
  linkedHolders: Prisma.JsonValue;
  linkedClusters: Prisma.JsonValue;
  sameTimeClusters: Prisma.JsonValue;
  bundledSupplyPct: number | null;
  bundledSupplyCount: number | null;
};

const SCAN_SELECT = {
  id: true,
  takenAt: true,
  kolBundledPct: true,
  linkedWalletPct: true,
  linkedWalletCount: true,
  linkedHolders: true,
  linkedClusters: true,
  sameTimeClusters: true,
  bundledSupplyPct: true,
  bundledSupplyCount: true,
} satisfies Prisma.TokenSnapshotSelect;

const arr = <T>(v: Prisma.JsonValue): T[] => (Array.isArray(v) ? (v as unknown as T[]) : []);

function sourceOf(s: ScanRow): KolBundledSource | null {
  const holders = arr<{ wallet: string; pct: number }>(s.linkedHolders).filter(
    (h) => h && typeof h.wallet === "string" && typeof h.pct === "number",
  );
  if (holders.length === 0) return null;
  return {
    holders,
    clusters: arr<KolBundledSource["clusters"][number]>(s.linkedClusters),
    sameTimeClusters: arr<KolBundledSource["sameTimeClusters"][number]>(s.sameTimeClusters),
  };
}

/**
 * Each scan's Bundled % where it can be trusted: exact from the linked share when no KOL bundled
 * anyone, else rebuilt and kept only when the rebuilt KOL Bundled % matches the recorded one.
 */
async function bundledOf(
  scans: readonly ScanRow[],
  deps: BackfillDeps,
): Promise<Map<string, { pct: number; count: number | null }>> {
  const out = new Map<string, { pct: number; count: number | null }>();
  const rebuild = new Map<string, KolBundledSource>();
  for (const s of scans) {
    if (s.bundledSupplyPct != null) out.set(s.id, { pct: s.bundledSupplyPct, count: s.bundledSupplyCount });
    else if (s.kolBundledPct === 0 && s.linkedWalletPct != null)
      out.set(s.id, { pct: s.linkedWalletPct, count: s.linkedWalletCount });
    else if (s.kolBundledPct != null && s.linkedWalletPct != null) {
      const src = sourceOf(s);
      if (src) rebuild.set(s.id, src);
    }
  }
  if (rebuild.size === 0) return out;
  const wallets = [...new Set([...rebuild.values()].flatMap((r) => r.holders.map((h) => h.wallet)))];
  const [roster, funders] = await Promise.all([
    prisma.kolWallet.findMany({ select: { wallet: true, firstSeenAt: true } }),
    prisma.walletFunder.findMany({
      where: { wallet: { in: wallets } },
      select: { wallet: true, funder: true },
    }),
  ]);
  if (roster.length === 0) return out;
  const kolSince = new Map(roster.map((r) => [r.wallet, r.firstSeenAt.getTime()]));
  const funderOf = new Map(funders.map((f) => [f.wallet, f.funder]));
  // One scan at a time: each reads the roster as of its own moment (2026-10-16).
  for (const s of scans) {
    const src = rebuild.get(s.id);
    if (!src) continue;
    const asOf = s.takenAt.getTime();
    const rebuilt: Map<string, KolBundledReading> = await kolBundledByMint(
      new Map([[s.id, src]]),
      funderOf,
      (w) => (kolSince.get(w) ?? Infinity) <= asOf,
      deps.loadSides ?? noSides,
    );
    const r = rebuilt.get(s.id);
    if (r && Math.abs(r.kolBundledPct - s.kolBundledPct!) <= SAME_PCT)
      out.set(s.id, { pct: r.bundledSupplyPct, count: r.bundledSupplyCount });
  }
  return out;
}

async function setOutcomes(values: readonly { id: string; pct: number }[]): Promise<void> {
  for (const v of values) {
    await prisma.$executeRaw`
      UPDATE "CandidateOutcome"
         SET "features" = jsonb_set("features", '{bundledSupplyPct}', to_jsonb(${v.pct}::float8))
       WHERE "id" = ${v.id}`;
  }
}

/** One batch of outcome rows; false once the window is done. */
async function outcomesBatch(deps: BackfillDeps, limit: number): Promise<boolean> {
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      anchorAt: { gte: BUNDLED_SUPPLY_BACKFILL_FROM, lt: until! },
      ...(cursor
        ? { OR: [{ anchorAt: { gt: cursor.at } }, { anchorAt: cursor.at, id: { gt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ anchorAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, tokenId: true, anchorAt: true, features: true },
  });
  if (rows.length === 0) return false;
  const last = rows[rows.length - 1]!;
  cursor = { at: last.anchorAt, id: last.id };

  const exact: { id: string; pct: number }[] = [];
  const toFind: { id: string; tokenId: string; anchorAt: Date; kol: number }[] = [];
  for (const r of rows) {
    const f = (r.features ?? {}) as Record<string, number | null | undefined>;
    if (f.bundledSupplyPct != null) continue;
    const kol = f.kolBundledPct;
    const linked = f.linkedWalletPct;
    if (kol == null || linked == null) totals.unknown++;
    else if (kol === 0) exact.push({ id: r.id, pct: linked });
    else toFind.push({ id: r.id, tokenId: r.tokenId, anchorAt: r.anchorAt, kol });
  }
  await setOutcomes(exact);
  totals.exact += exact.length;

  // Each row's own scan: the token's snapshot nearest the anchor, at or before it (2026-10-16: a
  // later one read holders the decision never saw), that recorded the same KOL Bundled %.
  const scanOf = new Map<string, ScanRow>();
  for (const r of toFind) {
    const near = await prisma.tokenSnapshot.findMany({
      where: {
        tokenId: r.tokenId,
        takenAt: { gte: new Date(r.anchorAt.getTime() - SNAPSHOT_WINDOW_MS), lte: r.anchorAt },
        kolBundledPct: { not: null },
      },
      select: SCAN_SELECT,
    });
    const pick = near
      .filter((s) => Math.abs(s.kolBundledPct! - r.kol) <= SAME_PCT)
      .sort(
        (a, b) =>
          Math.abs(a.takenAt.getTime() - r.anchorAt.getTime()) -
          Math.abs(b.takenAt.getTime() - r.anchorAt.getTime()),
      )[0];
    if (pick) scanOf.set(r.id, pick);
    else totals.noScan++;
  }
  const bundled = await bundledOf([...new Set(scanOf.values())], deps);
  const rebuilt: { id: string; pct: number }[] = [];
  for (const r of toFind) {
    const scan = scanOf.get(r.id);
    if (!scan) continue;
    const b = bundled.get(scan.id);
    if (b) rebuilt.push({ id: r.id, pct: b.pct });
    else totals.changed++;
  }
  await setOutcomes(rebuilt);
  totals.rebuilt += rebuilt.length;
  return true;
}

/** One batch of the snapshots alert cards show; false once none is left. */
async function snapshotsBatch(deps: BackfillDeps, limit: number): Promise<boolean> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s."id"
      FROM "TokenSnapshot" s
     WHERE s."id" IN (
             SELECT "snapshotId" FROM "CuratedAlert"
              WHERE "createdAt" >= ${BUNDLED_SUPPLY_BACKFILL_FROM} AND "createdAt" < ${until!} AND "snapshotId" IS NOT NULL
             UNION
             SELECT "snapshotId" FROM "Match"
              WHERE "matchedAt" >= ${BUNDLED_SUPPLY_BACKFILL_FROM} AND "matchedAt" < ${until!})
       AND s."kolBundledPct" IS NOT NULL
       AND s."bundledSupplyPct" IS NULL
       AND s."id" > ${snapshotCursor ?? ""}
     ORDER BY s."id"
     LIMIT ${limit}`;
  if (ids.length === 0) return false;
  snapshotCursor = ids[ids.length - 1]!.id;
  const scans = await prisma.tokenSnapshot.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: SCAN_SELECT,
  });
  const bundled = await bundledOf(scans, deps);
  for (const [id, b] of bundled) {
    await prisma.tokenSnapshot.update({
      where: { id },
      data: { bundledSupplyPct: b.pct, bundledSupplyCount: b.count },
    });
  }
  totals.snapshots += bundled.size;
  return true;
}

export async function runBundledSupplyBackfill(
  deps: BackfillDeps = {},
): Promise<Record<string, number> | null> {
  if (finished) return null;
  const limit = deps.rowsPerRun ?? BUNDLED_SUPPLY_ROWS_PER_RUN;
  // Rows banked from now on carry Bundled % from the scan itself.
  until ??= new Date((deps.now ?? Date.now)());
  if (!(await outcomesBatch(deps, limit)) && !(await snapshotsBatch(deps, limit))) {
    finished = true;
    logger.info("Bundled % backfill finished", totals);
    return null;
  }
  return { ...totals };
}
