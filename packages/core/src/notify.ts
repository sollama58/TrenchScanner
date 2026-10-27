import { prisma } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("notify");

/**
 * In-process listeners told that an alert row (a Match or a CuratedAlert) has just committed. The
 * scanner writes the alerts and runs the Telegram dispatch in the same process, so this is how a
 * new alert wakes the dispatch at once instead of waiting out its poll interval. Called after the
 * commit, like the NOTIFYs below; a listener that throws is ignored.
 */
const alertListeners = new Set<() => void>();

/** Registers a listener for alerts written by this process. Returns the unsubscribe. */
export function onAlertWritten(listener: () => void): () => void {
  alertListeners.add(listener);
  return () => alertListeners.delete(listener);
}

function announceAlertWritten(): void {
  for (const listener of alertListeners) {
    try {
      listener();
    } catch (err) {
      logger.warn("alert listener failed", { error: String(err) });
    }
  }
}

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
/**
 * Channel for curated alerts - separate from MATCH_CHANNEL because the fan-out rule is opposite:
 * a match belongs to one user and must never reach anyone else's stream, while a curated alert
 * is broadcast to every connected subscriber.
 */
export const CURATED_CHANNEL = "trenchscanner_curated";

export interface CuratedAlertNotification {
  alertId: string;
  /** The contestant whose ledger the call is on (CuratedAlert.model). */
  model?: string;
}

/** Same contract and caveats as notifyMatchCreated, for the broadcast curated feed. */
export async function notifyCuratedAlert(notification: CuratedAlertNotification): Promise<void> {
  announceAlertWritten();
  try {
    const payload = JSON.stringify(notification);
    await prisma.$executeRaw`SELECT pg_notify(${CURATED_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn("failed to publish curated alert notification", { error: String(err) });
  }
}

export async function notifyMatchCreated(notification: MatchNotification): Promise<void> {
  announceAlertWritten();
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

/**
 * notifyMatchCreated for many matches in one statement. A token that catches the filters of a
 * few hundred users would otherwise send a few hundred separate round trips at once, each
 * wanting its own pool connection while the scan's fan-out already holds most of them. Postgres
 * still delivers one notification per row, so listeners see exactly what single calls produced.
 */
export async function notifyMatchesCreated(notifications: readonly MatchNotification[]): Promise<void> {
  if (notifications.length === 0) return;
  announceAlertWritten();
  try {
    const payloads = notifications.map((n) => JSON.stringify(n));
    await prisma.$executeRaw`SELECT pg_notify(${MATCH_CHANNEL}, p) FROM unnest(${payloads}::text[]) AS p`;
  } catch (err) {
    logger.warn("failed to publish match notifications", { error: String(err), count: notifications.length });
  }
}

/**
 * Channel the scanner announces a newly written holder reading on, for coins whose bubble map
 * someone has open (user decision 2026-10-24): the API wakes those token views' held asks so they
 * read the new list at once instead of on their next 15-second poll. Same contract as the others:
 * only the mint, best effort, and the view's poll covers a missed one.
 */
export const HOLDERS_CHANNEL = "trenchscanner_holders";

export interface HoldersNotification {
  mint: string;
}

/** Announces a holder reading written for `mint`. Never throws. */
export async function notifyHolderReadingWritten(mint: string): Promise<void> {
  try {
    const payload = JSON.stringify({ mint } satisfies HoldersNotification);
    await prisma.$executeRaw`SELECT pg_notify(${HOLDERS_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn("failed to publish holder reading notification", { error: String(err) });
  }
}

/**
 * Channel the scanner announces newly written snapshots on, for the extension's live board pills
 * (user ask 2026-10-27): the API wakes the boards waiting on those coins, which read their new
 * numbers at once instead of on their next 30-second ask. Batched (SNAPSHOT_NOTICE_MS), since
 * the scan writes many snapshots a second; same contract as the others: mints only, best effort,
 * and the boards' own re-ask covers a missed one.
 */
export const SNAPSHOTS_CHANNEL = "trenchscanner_snapshots";

export interface SnapshotsNotification {
  mints: string[];
}

/** How long snapshot notices are gathered before one NOTIFY goes out. */
export const SNAPSHOT_NOTICE_MS = 2_000;
/** Mints per NOTIFY: a payload must stay under Postgres's 8000 bytes (44 characters a mint). */
const SNAPSHOT_NOTICE_MINTS = 150;
/** Mints gathered at most between flushes; past it the rest wait for the boards' own re-ask. */
const SNAPSHOT_NOTICE_MAX = 5_000;
const snapshotNotices = new Set<string>();
let snapshotTimer: NodeJS.Timeout | undefined;

/** Notes a snapshot written for `mint`; announced with the others within SNAPSHOT_NOTICE_MS. Never throws. */
export function noteSnapshotForBoards(mint: string): void {
  if (snapshotNotices.size >= SNAPSHOT_NOTICE_MAX) return;
  snapshotNotices.add(mint);
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => void flushSnapshotNotices(), SNAPSHOT_NOTICE_MS);
  snapshotTimer.unref?.();
}

/** Sends the gathered snapshot notices now. Exported for tests. */
export async function flushSnapshotNotices(): Promise<void> {
  clearTimeout(snapshotTimer);
  snapshotTimer = undefined;
  const mints = [...snapshotNotices];
  snapshotNotices.clear();
  if (mints.length === 0) return;
  const payloads: string[] = [];
  for (let i = 0; i < mints.length; i += SNAPSHOT_NOTICE_MINTS)
    payloads.push(
      JSON.stringify({ mints: mints.slice(i, i + SNAPSHOT_NOTICE_MINTS) } satisfies SnapshotsNotification),
    );
  try {
    await prisma.$executeRaw`SELECT pg_notify(${SNAPSHOTS_CHANNEL}, p) FROM unnest(${payloads}::text[]) AS p`;
  } catch (err) {
    logger.warn("failed to publish snapshot notifications", { error: String(err), count: mints.length });
  }
}
