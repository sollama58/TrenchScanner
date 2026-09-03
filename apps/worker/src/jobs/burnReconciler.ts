import {
  createLogger,
  creditBurn,
  parseBurnTransaction,
  prisma,
  SolanaRpc,
  SUBSCRIPTION_MINT,
  type Env,
} from "@trenchscanner/core";

const logger = createLogger("burn-reconciler");

/** Signatures fetched per RPC page. 1000 is the endpoint's maximum. */
const PAGE_SIZE = 1000;

/**
 * Most pages one pass will walk.
 *
 * A bound, not a target: without it, a cold start on a busy mint could sit in this loop for a very
 * long time on the first run. Whatever it doesn't reach this pass it reaches on the next, which
 * is what BurnScanCursor.backfillBefore is for - the cap is roughly half the default cold-start
 * window, so a first pass genuinely does stop short and something has to remember where.
 */
const MAX_PAGES_PER_PASS = 10;

/**
 * Transactions fetched per JSON-RPC batch.
 *
 * 50 rather than the 100 an RPC will happily accept: public endpoints weight a batch by the number
 * of calls inside it, and measured against api.mainnet-beta.solana.com a batch of 100 draws a 429
 * on its own. Production should point SOLANA_RPC_URL at a paid endpoint regardless - a rate-limited
 * reconciler is a paying user waiting - but the default shouldn't be self-defeating.
 */
const FETCH_BATCH_SIZE = 50;

/**
 * Pause between batches, so a cold start doesn't arrive as one burst.
 *
 * Only paid for when there is more than one batch to fetch, which outside a cold start is never:
 * this mint sees ~53 transactions a day, so a routine pass has nothing to fetch at all.
 */
const BATCH_PAUSE_MS = 250;

export interface ReconcileResult {
  scanned: number;
  burnsFound: number;
  credited: number;
  held: number;
  alreadyCredited: number;
}

/**
 * Find burns of the subscription token that nobody claimed, and credit them.
 *
 * This is the layer that makes "if you burn, you get access" true rather than merely likely.
 * Every other path depends on the user's browser surviving long enough to tell us something: the
 * claim call can be lost to a closed tab, a flat battery, a dropped connection, or a user who
 * simply burned from a wallet UI and never opened the dashboard at all. The chain remembers
 * regardless, so this reads the chain.
 *
 * It works off `getSignaturesForAddress(mint)`, which returns every transaction mentioning the
 * mint - and since the SPL burn instruction takes the mint as an account, that includes every
 * burn of it, by anyone, whether or not we have ever seen that wallet.
 *
 * Safe to run concurrently with the claim endpoint and with itself: crediting is guarded by the
 * unique constraint on the signature, so the worst case of two passes overlapping is some wasted
 * RPC calls.
 */
export async function reconcileBurns(env: Env, rpc: SolanaRpc): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, burnsFound: 0, credited: 0, held: 0, alreadyCredited: 0 };

  const cursor = await prisma.burnScanCursor.upsert({
    where: { id: "burn-scan" },
    update: {},
    create: { id: "burn-scan", scanFloor: new Date(Date.now() - env.BURN_SCAN_COLD_START_DAYS * 86_400_000) },
  });

  const floor = cursor.scanFloor ?? new Date(Date.now() - env.BURN_SCAN_COLD_START_DAYS * 86_400_000);

  // Pass one: everything newer than where we stopped last time. On a fresh install there is no
  // `until`, so this is the cold start's first bite - bounded by the page cap, and by the floor
  // if it gets that far.
  const forward = await collectSignatures(rpc, {
    until: cursor.lastSignature ?? undefined,
    stopAtFloor: cursor.lastSignature ? null : floor,
  });

  if (forward.pages > 0 || forward.pending.length > 0) {
    const { lastProcessed, completed } = await processSignatures(forward.pending, rpc, result);
    if (lastProcessed) {
      // The cold start clears its floor only once the backfill has actually reached it - see
      // below. Advancing lastSignature here is what keeps ordinary forward passes cheap.
      await prisma.burnScanCursor.update({
        where: { id: "burn-scan" },
        data: {
          lastSignature: lastProcessed,
          // A first pass that stopped on the page cap rather than the floor leaves the rest of
          // the window to the backfill, and records where to resume from. One that reached the
          // floor (or ran out of history) is done: no backfill, no floor.
          ...(cursor.lastSignature
            ? {}
            : forward.reachedFloor || forward.exhausted
              ? { scanFloor: null, backfillBefore: null }
              : { backfillBefore: completed ? forward.oldestSeen : null }),
        },
      });
    }
  }

  // Pass two: the rest of the cold-start window, a page-cap's worth at a time, continuing
  // backwards from wherever the last pass stopped. Skipped entirely once the floor is reached,
  // which is the normal steady state.
  const backfillFrom = cursor.backfillBefore;
  if (backfillFrom && cursor.scanFloor) {
    const older = await collectSignatures(rpc, { before: backfillFrom, stopAtFloor: cursor.scanFloor });
    const { completed } = await processSignatures(older.pending, rpc, result);

    if (completed) {
      const done = older.reachedFloor || older.exhausted;
      await prisma.burnScanCursor.update({
        where: { id: "burn-scan" },
        data: done
          ? { backfillBefore: null, scanFloor: null }
          : { backfillBefore: older.oldestSeen ?? backfillFrom },
      });
      if (done) logger.info("burn backfill reached the cold-start floor");
    }
    // A pass that stopped early leaves the resume point untouched: re-walking the same range is
    // idempotent (crediting is guarded by the signature's unique constraint, and already-stored
    // signatures are not re-fetched), whereas advancing over unprocessed ground loses burns.
  }

  if (result.burnsFound > 0 || result.scanned > 0) {
    logger.info("reconcile pass complete", { ...result });
  }
  return result;
}

/** One backwards walk over the mint's signatures, bounded by the page cap and optionally a floor. */
async function collectSignatures(
  rpc: SolanaRpc,
  opts: { until?: string; before?: string; stopAtFloor: Date | null },
): Promise<{
  pending: { signature: string; blockTime?: number | null }[];
  oldestSeen: string | null;
  reachedFloor: boolean;
  exhausted: boolean;
  pages: number;
}> {
  const pending: { signature: string; blockTime?: number | null }[] = [];
  let before = opts.before;
  let oldestSeen: string | null = null;
  let reachedFloor = false;
  let exhausted = false;
  let pages = 0;

  for (let page = 0; page < MAX_PAGES_PER_PASS && !reachedFloor; page += 1) {
    const batch = await rpc.getSignaturesForAddress(SUBSCRIPTION_MINT, {
      limit: PAGE_SIZE,
      before,
      ...(opts.until ? { until: opts.until } : {}),
    });

    // An RPC failure must not look like "no burns". Returning what we have without advancing any
    // cursor means the next pass re-walks the same ground rather than skipping over it.
    if (batch === null) {
      logger.warn("signature fetch failed - leaving the cursor where it is");
      return { pending: [], oldestSeen: null, reachedFloor: false, exhausted: false, pages };
    }
    pages += 1;
    if (batch.length === 0) {
      exhausted = true;
      break;
    }

    for (const entry of batch) {
      // Stop at the floor rather than paging through all history. Checked before the error filter
      // so a run of failed transactions can't carry the scan past it.
      if (opts.stopAtFloor && entry.blockTime && entry.blockTime * 1000 < opts.stopAtFloor.getTime()) {
        reachedFloor = true;
        break;
      }
      oldestSeen = entry.signature;
      // A transaction that failed on-chain burned nothing; no reason to fetch it in full.
      if (entry.err) continue;
      pending.push({ signature: entry.signature, blockTime: entry.blockTime });
    }

    if (reachedFloor) break;
    if (batch.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
    before = batch[batch.length - 1]?.signature;
    if (!before) {
      exhausted = true;
      break;
    }
  }

  return { pending, oldestSeen, reachedFloor, exhausted, pages };
}

/**
 * Fetches and credits a collected run of signatures, oldest first.
 *
 * `completed` reports whether the whole run was processed: a fetch that comes back empty stops
 * the pass where it stands, and every cursor decision above keys off that rather than advancing
 * over ground nothing has looked at.
 */
async function processSignatures(
  collected: { signature: string; blockTime?: number | null }[],
  rpc: SolanaRpc,
  result: ReconcileResult,
): Promise<{ lastProcessed: string | null; completed: boolean }> {
  if (collected.length === 0) return { lastProcessed: null, completed: true };

  // Oldest first, so a failure part-way leaves the cursor on a contiguous prefix and the next
  // pass resumes exactly where this one stopped.
  const pending = [...collected].reverse();

  // Which of these we have already stored, so a re-walk after an RPC failure doesn't re-fetch
  // every transaction it already knows about.
  const known = new Set(
    (
      await prisma.burnEvent.findMany({
        where: { signature: { in: pending.map((p) => p.signature) } },
        select: { signature: true },
      })
    ).map((b) => b.signature),
  );

  let lastProcessed: string | null = null;
  let completed = true;

  // Fetched a batch at a time. At this mint's measured rate (~53 transactions a day) a routine
  // pass has nothing to fetch at all, but a cold start has months of them, and one POST per
  // transaction is how you get rate-limited off a public RPC on your first run.
  outer: for (let start = 0; start < pending.length; start += FETCH_BATCH_SIZE) {
    const batch = pending.slice(start, start + FETCH_BATCH_SIZE).map((p) => p.signature);
    const toFetch = batch.filter((sig) => !known.has(sig));
    if (start > 0 && toFetch.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
    const fetched = toFetch.length > 0 ? await rpc.getParsedTransactions(toFetch) : new Map();

    for (const signature of batch) {
      result.scanned += 1;
      if (known.has(signature)) {
        lastProcessed = signature;
        continue;
      }

      const tx = fetched.get(signature) ?? null;
      if (tx === null) {
        // Could be an RPC hiccup, could be a transaction that is confirmed but not yet finalised.
        // Either way, stop advancing the cursor here: everything after this point stays
        // unprocessed and gets picked up next pass. Skipping it would mean a burn silently lost.
        logger.warn("could not fetch transaction - stopping this pass here", { signature });
        completed = false;
        break outer;
      }

      const verdict = parseBurnTransaction(tx);
      if (!verdict.ok) {
        // The overwhelmingly common case: a swap or transfer that mentions the mint. Not an error.
        lastProcessed = signature;
        continue;
      }

      result.burnsFound += 1;
      const outcome = await creditBurn(signature, verdict.credit, SUBSCRIPTION_MINT, "reconciler");
      if (outcome.status === "credited") {
        result.credited += 1;
        logger.info("credited an unclaimed burn", {
          signature,
          wallet: verdict.credit.burnerWallet,
          months: verdict.credit.months,
        });
      } else if (outcome.status === "held") {
        result.held += 1;
        logger.info("recorded a burn from a wallet with no account yet", {
          signature,
          wallet: verdict.credit.burnerWallet,
        });
      } else {
        result.alreadyCredited += 1;
      }
      lastProcessed = signature;
    }
  }

  return { lastProcessed, completed };
}
