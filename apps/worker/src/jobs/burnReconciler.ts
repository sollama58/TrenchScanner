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
 * long time on the first run. Whatever it doesn't reach this pass, it reaches on the next one,
 * because the cursor only advances over signatures actually processed.
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

  // Walk backwards from the tip, collecting everything newer than where we stopped last time.
  // Newest-first is the only order the RPC offers, so the pages are gathered first and processed
  // oldest-first below - which matters, because the cursor may only advance over a contiguous
  // run of fully-processed signatures.
  const pending: { signature: string; blockTime?: number | null }[] = [];
  let before: string | undefined;
  const floor = cursor.scanFloor ?? new Date(Date.now() - env.BURN_SCAN_COLD_START_DAYS * 86_400_000);

  // Set when a cold start reaches back past its floor. Has to stop the paging loop, not just the
  // loop over the current page - breaking only the inner loop would leave the outer one happily
  // fetching the next page and walking the mint's entire history, which is the exact thing the
  // floor exists to prevent.
  let reachedFloor = false;

  for (let page = 0; page < MAX_PAGES_PER_PASS && !reachedFloor; page += 1) {
    const batch = await rpc.getSignaturesForAddress(SUBSCRIPTION_MINT, {
      limit: PAGE_SIZE,
      before,
      ...(cursor.lastSignature ? { until: cursor.lastSignature } : {}),
    });

    // An RPC failure must not look like "no burns". Returning what we have without advancing the
    // cursor means the next pass re-walks the same ground rather than skipping over it.
    if (batch === null) {
      logger.warn("signature fetch failed - leaving the cursor where it is");
      return result;
    }
    if (batch.length === 0) break;

    for (const entry of batch) {
      // On a cold start, stop at the floor rather than paging through all history. Checked before
      // the error filter so a run of failed transactions can't carry the scan past it.
      if (!cursor.lastSignature && entry.blockTime && entry.blockTime * 1000 < floor.getTime()) {
        reachedFloor = true;
        break;
      }
      // A transaction that failed on-chain burned nothing; no reason to fetch it in full.
      if (entry.err) continue;
      pending.push({ signature: entry.signature, blockTime: entry.blockTime });
    }

    if (reachedFloor || batch.length < PAGE_SIZE) break;
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }

  if (pending.length === 0) {
    logger.debug("no new transactions since the last pass");
    return result;
  }

  // Oldest first, so a failure part-way leaves the cursor on a contiguous prefix and the next pass
  // resumes exactly where this one stopped.
  pending.reverse();

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

  // Fetched a batch at a time. At this mint's measured rate (~53 transactions a day) a routine
  // pass has nothing to fetch at all, but a cold start has a month of them, and one POST per
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

  // Advance only over what was actually processed. `scanFloor` is cleared once a cursor exists -
  // it only ever governed the cold start.
  if (lastProcessed) {
    await prisma.burnScanCursor.update({
      where: { id: "burn-scan" },
      data: { lastSignature: lastProcessed, scanFloor: null },
    });
  }

  if (result.burnsFound > 0 || result.scanned > 0) {
    logger.info("reconcile pass complete", { ...result });
  }
  return result;
}
