import {
  bubbleReadingOf,
  createLogger,
  prisma,
  saveBubbleMoment,
  type ScoredToken,
} from "@trenchscanner/core";

const logger = createLogger("screen-moments");

/**
 * How long after a coin's first pass its first holder list can still stand for the pass: a pass on
 * a scan that had not read the holders yet keeps the first list read within this window (the
 * scan reads a coin's holders within a cycle or two of it reaching the band), as the map at the
 * call allows (core's BUBBLE_AT_ALERT_WINDOW_MS). Later than that, none is kept rather than one
 * mislabelled.
 */
export const SCREEN_MOMENT_WINDOW_MS = 15 * 60_000;

/** Coins remembered at once; past this the oldest are forgotten (and checked again if seen). */
const MAX_TRACKED = 20_000;

/** Coins whose screen moment is kept, or that passed before this process saw them: nothing to do. */
const settled = new Set<string>();
/** Coins that first passed on a scan without a holder list: when, until one is read. */
const waiting = new Map<string, number>();
/** Coins being checked or saved now, so a slow save isn't started twice. */
const inFlight = new Set<string>();

function settle(tokenId: string) {
  waiting.delete(tokenId);
  if (settled.size >= MAX_TRACKED) {
    const oldest = settled.values().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
  settled.add(tokenId);
}

/**
 * Keeps the coin's bubble map at its first safety-screen pass inside the band (user ask 2026-10-16):
 * the Stream's entry, the first scan snapshot that passed inside MCAP_FILTER_MIN..MAX. Called by
 * the scan for each such snapshot it writes; only the first of a coin's keeps anything. The reading
 * is the scan's own (ScoredToken carries the holder list whether or not this row stores it).
 * Never throws: the scan does not wait on it.
 */
export async function keepScreenMoment(
  token: { id: string; mintAddress: string },
  snapshot: { takenAt: Date },
  scored: ScoredToken,
  band: { min: number; max: number },
): Promise<void> {
  if (settled.has(token.id) || inFlight.has(token.id)) return;
  inFlight.add(token.id);
  try {
    const at = snapshot.takenAt.getTime();
    let passAt = waiting.get(token.id);
    if (passAt === undefined) {
      // First seen passing by this process: kept already, or did the coin pass before (a restart,
      // or a pass from before moments were kept)?
      const [kept, earlier] = await Promise.all([
        prisma.bubbleMapMoment.findUnique({
          where: { mintAddress_kind_userId: { mintAddress: token.mintAddress, kind: "screen", userId: "" } },
          select: { id: true },
        }),
        prisma.tokenSnapshot.findFirst({
          where: {
            tokenId: token.id,
            source: "scan",
            rugScreenPassed: true,
            marketCapUsd: { gte: band.min, lte: band.max },
            takenAt: { lt: snapshot.takenAt },
          },
          select: { id: true },
        }),
      ]);
      if (kept || earlier) return settle(token.id);
      passAt = at;
      if (waiting.size >= MAX_TRACKED) {
        const oldest = waiting.keys().next().value;
        if (oldest !== undefined) waiting.delete(oldest);
      }
      waiting.set(token.id, passAt);
    }
    if (at - passAt > SCREEN_MOMENT_WINDOW_MS) return settle(token.id);
    const reading = bubbleReadingOf(scored);
    // No holder list yet: the next scan with one stands for the pass.
    if (!reading) return;
    await saveBubbleMoment({
      mintAddress: token.mintAddress,
      kind: "screen",
      isPublic: true,
      momentAt: new Date(passAt),
      readAt: snapshot.takenAt,
      reading,
    });
    settle(token.id);
  } catch (err) {
    logger.warn("failed to keep the bubble map at the screen pass", {
      mint: token.mintAddress,
      error: String(err),
    });
  } finally {
    inFlight.delete(token.id);
  }
}

/** Test hook: forget every coin. */
export function resetScreenMomentsForTests(): void {
  settled.clear();
  waiting.clear();
  inFlight.clear();
}
