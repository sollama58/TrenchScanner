import { createLogger, prisma, type PricePathBook } from "@trenchscanner/core";

const logger = createLogger("price-tape-seed");

/** The tape the price-path inputs look back over (curation/pricePath.ts keeps 65 minutes). */
const SEED_LOOKBACK_MS = 65 * 60_000;
/** Tokens per query: each is a probe of TokenSnapshot(tokenId, takenAt), the table's one index. */
const SEED_CHUNK = 200;

type SnapshotTick = {
  tokenId: string;
  takenAt: Date;
  priceUsd: number;
  holderCount: number | null;
  holderCountAt: Date | null;
};
type LoadTicks = (tokenIds: string[], since: Date) => Promise<SnapshotTick[]>;

const loadScanTicks: LoadTicks = (tokenIds, since) =>
  prisma.tokenSnapshot.findMany({
    // Fast-pass rows copy the scan's holder count under a later stamp (snapshotData.ts), and the
    // live tape never saw them: only the scan's own observations go back on.
    where: { tokenId: { in: tokenIds }, takenAt: { gt: since }, source: "scan" },
    select: { tokenId: true, takenAt: true, priceUsd: true, holderCount: true, holderCountAt: true },
  });

/**
 * Refills the price tape from the scan's own snapshots after the worker starts. The book is in
 * memory and every deploy emptied it, so for the half hour after one the 15/30-minute returns
 * and the holder slope were null on every decision, and the 5-minute return for the first five
 * (6h fill of pathRet30mPct on 2026-10-12: 6% against 17% over 48h). Each mint is asked for once,
 * the first cycle it is a candidate, and only while the process is younger than the tape: after
 * that, everything the snapshots hold the book has seen itself.
 *
 * Fire-and-forget from the scan cycle: a decision never waits on it. The cycle that asks scores
 * on the tape it has; the next one, 30 seconds later, reads the refilled tape.
 */
export class PricePathSeeder {
  private readonly asked = new Set<string>();
  private readonly startedAt: number;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly book: PricePathBook,
    private readonly load: LoadTicks = loadScanTicks,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  /** Asks for the stored tape of these candidates (mint and token id) not asked for before. */
  seed(candidates: readonly { mint: string; tokenId: string | undefined }[], now: number = Date.now()): void {
    if (now - this.startedAt > SEED_LOOKBACK_MS) return;
    const mintByToken = new Map<string, string>();
    for (const { mint, tokenId } of candidates) {
      if (!tokenId || this.asked.has(mint)) continue;
      this.asked.add(mint);
      mintByToken.set(tokenId, mint);
    }
    if (mintByToken.size === 0) return;
    const since = new Date(now - SEED_LOOKBACK_MS);
    const ids = [...mintByToken.keys()];
    // One batch at a time, so a slow first query never stacks a second on the pool behind it.
    this.inFlight = this.inFlight.then(async () => {
      let seeded = 0;
      for (let i = 0; i < ids.length; i += SEED_CHUNK) {
        try {
          const rows = await this.load(ids.slice(i, i + SEED_CHUNK), since);
          const byToken = new Map<string, SnapshotTick[]>();
          for (const row of rows) {
            const list = byToken.get(row.tokenId) ?? [];
            list.push(row);
            byToken.set(row.tokenId, list);
          }
          for (const [tokenId, list] of byToken) {
            this.book.seed(
              mintByToken.get(tokenId)!,
              list.map((r) => ({
                at: r.takenAt,
                priceUsd: r.priceUsd,
                holders: r.holderCount,
                holdersAt: r.holderCountAt,
              })),
            );
            seeded += 1;
          }
        } catch (err) {
          logger.warn("price tape seed failed", { error: String(err) });
        }
      }
      if (seeded > 0) logger.info("price tape seeded from snapshots", { mints: seeded, asked: ids.length });
    });
  }

  /** Resolves once every seed asked for so far has landed (tests). */
  settled(): Promise<void> {
    return this.inFlight;
  }
}
