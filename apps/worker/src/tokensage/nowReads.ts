import {
  createLogger,
  nowFieldsFromItem,
  prisma,
  tokenSageEnabled,
  TokenSageClient,
  TOKENSAGE_BATCH_MAX,
  type Env,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";
import { forgetNarrativeRead } from "./heldNarrativeReads.js";

const logger = createLogger("tokensage-now");

/**
 * Keeps TokenSage's decision-time refresh (rules 0.34.0+, POST /v1/tokens:now) current on the
 * coins in the curated band: the trend block matched against the trend lists of the moment and
 * how the coin's story trades (its leading coin on GeckoTerminal). A full read is kept for good
 * once stored (prefetch.ts), so without this every decision saw the trends of the read's moment
 * and nothing of the story's market (notes/tokensage-trend-heat-2026-10-13.md).
 *
 * The scan notes each band coin that passes the rug screen (noteNowWanted); at the end of the
 * cycle, and on the narrative poll between cycles, flushNowReads asks for the ones with a full
 * read whose stored refresh is older than NOW_REFRESH_MS. TokenSage answers a fresh refresh at
 * once and starts a new one for the rest (`pending`, with the previous values, which are stored
 * too); the next flush picks them up. Free on TokenSage's side. Nothing in the scan waits on it,
 * and the ns* inputs built from it (narrativeFeatures.ts NARRATIVE_FEATURES_V8) are null when the
 * refresh is older than NOW_FEATURE_MAX_AGE_MIN at the decision.
 */

/** A stored refresh younger than this is not asked again (TokenSage's own is 5 minutes). */
const NOW_REFRESH_MS = 4 * 60_000;
/** A coin noted this long ago and not since has left the band (or the watchlist). */
const NOW_WANTED_MS = 10 * 60_000;
/** Mints asked per flush at most: two calls. */
const MAX_PER_FLUSH = 2 * TOKENSAGE_BATCH_MAX;
const MAX_WANTED = 2_000;

const wanted = new Map<string, number>();
const askedAt = new Map<string, number>();
let flushing = false;
const stats = { asked: 0, stored: 0, errors: 0 };

/** The scan saw this band coin pass the rug screen; keep its refresh current. */
export function noteNowWanted(mint: string, env: Env, now = Date.now()): void {
  if (!tokenSageEnabled(env)) return;
  wanted.delete(mint);
  wanted.set(mint, now);
  if (wanted.size > MAX_WANTED) {
    const oldest = wanted.keys().next().value;
    if (oldest !== undefined) wanted.delete(oldest);
  }
}

/** Counters since the last read, for the scan cycle's summary. */
export function takeNowStats(): Record<string, number> {
  const out = { ...stats, wanted: wanted.size };
  stats.asked = stats.stored = stats.errors = 0;
  return out;
}

/** Test seam. */
export function resetNowReads(): void {
  wanted.clear();
  askedAt.clear();
  flushing = false;
  stats.asked = stats.stored = stats.errors = 0;
}

export async function flushNowReads(env: Env, client?: TokenSageClient, now = Date.now()): Promise<number> {
  if (!tokenSageEnabled(env) || flushing) return 0;
  flushing = true;
  try {
    for (const [mint, at] of wanted) {
      if (now - at > NOW_WANTED_MS) {
        wanted.delete(mint);
        askedAt.delete(mint);
      }
    }
    const due = [...wanted.keys()].filter((m) => now - (askedAt.get(m) ?? 0) >= NOW_REFRESH_MS / 4);
    if (due.length === 0) return 0;
    // Only coins with a full read can be refreshed, and only a refresh gone stale is asked again.
    const rows = await prisma.tokenNarrative.findMany({
      where: { mintAddress: { in: due }, depth: "full", status: { in: ["complete", "partial"] } },
      select: { mintAddress: true, nowAt: true },
    });
    const ask = rows
      .filter((r) => r.nowAt === null || now - r.nowAt.getTime() >= NOW_REFRESH_MS)
      .sort((a, b) => (a.nowAt?.getTime() ?? 0) - (b.nowAt?.getTime() ?? 0))
      .slice(0, MAX_PER_FLUSH)
      .map((r) => r.mintAddress);
    if (ask.length === 0) return 0;
    const api =
      client ??
      new TokenSageClient({
        baseUrl: env.TOKENSAGE_API_URL,
        apiKey: env.TOKENSAGE_API_KEY,
        timeoutMs: env.TOKENSAGE_TIMEOUT_MS,
      });
    let stored = 0;
    for (let i = 0; i < ask.length; i += TOKENSAGE_BATCH_MAX) {
      const chunk = ask.slice(i, i + TOKENSAGE_BATCH_MAX);
      for (const m of chunk) askedAt.set(m, now);
      stats.asked += chunk.length;
      const items = await api.now(chunk);
      for (const item of items) {
        if (!chunk.includes(item.ca)) continue;
        const fields = nowFieldsFromItem(item, item.ca);
        if (fields === null) continue;
        const prior = rows.find((r) => r.mintAddress === item.ca)?.nowAt ?? null;
        // A pending item carries the previous refresh: stored only when it is newer than ours.
        if (prior !== null && fields.nowAt !== null && fields.nowAt.getTime() <= prior.getTime()) continue;
        await prisma.tokenNarrative.update({
          where: { mintAddress: item.ca },
          data: {
            ...fields,
            nowRead: {
              trend: item.trend ?? null,
              story_heat: item.story_heat ?? null,
            } as Prisma.InputJsonValue,
          },
        });
        forgetNarrativeRead(item.ca);
        stored += 1;
      }
    }
    stats.stored += stored;
    return stored;
  } catch (err) {
    stats.errors += 1;
    logger.warn("TokenSage refresh failed", { error: String(err) });
    return 0;
  } finally {
    flushing = false;
  }
}
