import { prisma } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("notify");

/**
 * Postgres NOTIFY channel the worker announces new matches on and the API listens to.
 *
 * The two run as separate processes with nothing between them but the database, so this is the
 * cheapest possible signalling path: no broker, no extra service, no polling loop. Postgres
 * already has both of them connected.
 */
export const MATCH_CHANNEL = "trenchscanner_match";

export interface MatchNotification {
  userId: string;
  matchId: string;
}

/**
 * Announces that a match was created, so any API instance holding an open dashboard for that user
 * can push it immediately instead of waiting for the next poll.
 *
 * Deliberately carries only identifiers, not the match itself. NOTIFY payloads are capped at 8000
 * bytes, and more importantly the API already knows how to serialize a match for the dashboard -
 * duplicating that shape here would give it two definitions that could drift. The client refetches
 * on the nudge, which costs one round trip and keeps one source of truth.
 *
 * Fire-and-forget by design: NOTIFY is not durable, a listener that is disconnected at this instant
 * simply misses it, and the client's fallback poll covers that. So a failure here must never fail
 * the scan cycle that produced the match - the match row is already committed either way.
 */
export async function notifyMatchCreated(notification: MatchNotification): Promise<void> {
  try {
    const payload = JSON.stringify(notification);
    // Parameterised via Prisma's tagged template, so the payload can never be read as SQL. This is
    // pg_notify(...) rather than a literal NOTIFY statement precisely because NOTIFY takes an
    // identifier and a string literal, neither of which can be bound as a parameter.
    //
    // $executeRaw, not $queryRaw: pg_notify returns void, and $queryRaw tries to deserialize the
    // result set, which fails on a void column. The notification is still delivered either way -
    // the statement runs before deserialization - so the symptom is just a warning logged on every
    // single alert, which is exactly the kind of noise that trains people to ignore the log.
    await prisma.$executeRaw`SELECT pg_notify(${MATCH_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn("failed to publish match notification", { error: String(err) });
  }
}
