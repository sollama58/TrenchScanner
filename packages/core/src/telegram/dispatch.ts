import { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { adminWalletSet } from "../config/env.js";
import { namePassLock, PASS_LOCK_APPLICATION_NAME, prisma, TRAINER_APPLICATION_NAME } from "../db.js";
import { createLogger } from "../logger.js";
import { resolveAccess } from "../subscription/access.js";
import {
  isFeedCall,
  loadFeedModelState,
  resolveFeedCalls,
  resolveTelegramModels,
  type FeedModelState,
} from "../curation/feedModels.js";
import {
  loadNarrativeNoteReadiness,
  narrativeNoteChoice,
  showsNarrativeNote,
} from "../curation/narrativeNote.js";
import { newPhotoCache, TelegramApi, telegramConfigured } from "./api.js";
import {
  alertImage,
  alertMessage,
  alertParts,
  alertStyle,
  digestMessage,
  type AlertCard,
  type AlertLinks,
} from "./format.js";
import { refreshKeyboard, storedCard } from "./refresh.js";

/**
 * The scanner worker's telegram-dispatch job: every few seconds, send each linked chat the
 * alerts its account got since the chat's cursor - the account's filter matches (Match rows)
 * and the calls of the models in its feed (CuratedAlert rows), exactly what the Live tab would
 * show that person. A chat is the unit: a person can have the bot in a private chat and in two
 * groups, each with its own switches and its own cursor.
 *
 * Reads rather than listens: Postgres NOTIFY (notify.ts) is not durable, and a cursor per chat
 * means a restart or a failed send picks up where it left off instead of losing the alert. The
 * worker still wakes a pass as soon as an alert commits (onAlertWritten), so the poll interval is
 * the fallback, not the wait.
 */

const logger = createLogger("telegram-dispatch");

/**
 * Rows are read only up to this far behind now: a Match's matchedAt is stamped at insert and
 * the row commits a moment later, and a cursor that moved past the stamp in between would skip it.
 * The open-transaction bound below is what covers that wait (every alert is written inside a
 * transaction that began before its stamp); this only has to cover the clocks of the scanner and
 * the database disagreeing. It was 5 s, which every alert waited out before it could be sent.
 */
export const COMMIT_GRACE_MS = 1_000;
/**
 * A transaction still open in the database may yet commit a row stamped as early as its start
 * (matchedAt defaults to the transaction's own now()), so the horizon also stays behind the oldest
 * one open. Bounded: the alert writes give up after 15 s, and a long training query must not hold
 * every alert back.
 */
export const MAX_COMMIT_WAIT_MS = 20_000;
/** An alert older than this when the job gets to it is not news; the cursor steps over it. */
export const MAX_ALERT_AGE_MS = 15 * 60_000;
/**
 * A token a chat was alerted on is not sent to it again for this long. Past it, a fresh call or
 * match on the same coin (one that died and came back) is news again and goes out.
 */
export const REALERT_AFTER_MS = 24 * 3_600_000;
/** More than this many alerts for one chat in one pass become a single digest message. */
export const DIGEST_THRESHOLD = 4;
/** How long one pass may spend sending before it leaves the rest for the next one. */
const PASS_BUDGET_MS = 25_000;
/**
 * Telegram's limits: about one message a second to any one private chat, twenty a minute to a
 * group, and thirty a second across everything. Spaced a little wider than that.
 */
const PRIVATE_GAP_MS = 1_100;
const GROUP_GAP_MS = 3_100;
const GLOBAL_GAP_MS = 50;
/** Sends out at once; with GLOBAL_GAP_MS that is what keeps the pass near Telegram's own limit. */
const MAX_IN_FLIGHT = 8;
/** Access lookups run this many at a time, so a pass doesn't take the whole worker pool. */
const ACCESS_CHECK_BATCH = 8;
/** The most a 429 is honoured in one pass; a longer wait is left for the next pass. */
const MAX_RETRY_AFTER_MS = 20_000;
/** Consecutive failed passes before a chat is switched off rather than retried forever. */
const MAX_FAILURES = 100;

export interface DispatchDeps {
  api?: TelegramApi;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: who may receive alerts. Defaults to resolveAccess (the paywall). */
  hasAccess?: (walletAddress: string) => Promise<boolean>;
  feedModelState?: () => Promise<FeedModelState>;
  /**
   * Finds artwork for tokens that have none on file (DexScreener's, for a coin that didn't come
   * through Pump.fun), mint -> https URL. The worker passes its DexScreener client; without one,
   * such alerts go out as text.
   */
  lookupImages?: (mints: string[]) => Promise<Map<string, string>>;
  /** Test seam: when the oldest transaction open in the database began. */
  oldestOpenTransaction?: () => Promise<Date | null>;
  /** Test seam: whether the Narrative seat's note shows for users who haven't set the toggle. */
  narrativeNoteReady?: () => Promise<boolean>;
}

/**
 * When the oldest other transaction open in this database began, or null if none is (or unknown).
 * Run on the pass's own connection, so its own transaction doesn't count. The trainer's
 * connections don't either: it never writes an alert, and its training reads run for minutes,
 * which held every alert back by the full MAX_COMMIT_WAIT_MS while they did. Nor do Postgres's own
 * processes (autovacuum, WAL senders): only client connections write alerts. Nor the pass-lock
 * transactions (PASS_LOCK_APPLICATION_NAME: the trading engine's, and this one's on another
 * process): they hold an advisory lock and write nothing, and the engine's would otherwise hold
 * every alert back for the length of each trading pass. A client transaction that hasn't written
 * yet still counts, since a scan's row can carry its transaction's start.
 */
export async function oldestOpenTransaction(tx: Prisma.TransactionClient): Promise<Date | null> {
  try {
    const [row] = await tx.$queryRaw<{ oldest: Date | null }[]>`
      SELECT min(xact_start) AS oldest FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
        AND backend_type = 'client backend'
        AND COALESCE(application_name, '') NOT IN (${TRAINER_APPLICATION_NAME}, ${PASS_LOCK_APPLICATION_NAME})`;
    return row?.oldest ?? null;
  } catch {
    return null;
  }
}

/**
 * Artwork URL -> Telegram file_id, carried from pass to pass so a picture is uploaded once, not
 * once per chat and pass. Oldest dropped first past the cap.
 */
const knownPhotoIds = new Map<string, string>();
const KNOWN_PHOTO_IDS_MAX = 500;

/** The most imageless tokens looked up in one pass: one DexScreener batch. */
const IMAGE_LOOKUP_MAX = 30;

/**
 * Mint -> when to ask again, for mints the lookup found no artwork for. DexScreener has none for
 * almost every new coin, and a card can stay pending for several passes: without this each pass
 * asked again for the same mints (caching review 2026-10-08, #12). TokenSage's logo, when it
 * lands, reaches the Token row on its own (prefetch backfillTokenImage), so nothing is lost.
 */
const noArtworkUntil = new Map<string, number>();
const NO_ARTWORK_RETRY_MS = 30 * 60_000;
const NO_ARTWORK_MAX = 2_000;

/** For tests. */
export function resetArtworkMisses(): void {
  noArtworkUntil.clear();
}

/**
 * Fills in the picture for pending cards whose token has none, and remembers what it found on
 * the Token row so the dashboard and the next alert have it too. Best effort and bounded.
 */
async function backfillImages(queues: { pending: Pending[] }[], lookup: DispatchDeps["lookupImages"]) {
  if (!lookup) return;
  const missing = new Map<string, AlertCard["token"][]>();
  for (const q of queues) {
    for (const p of q.pending) {
      const cards = isDigest(p.card) ? p.card.digest : [p.card];
      for (const card of cards) {
        if (card.token.imageUrl) continue;
        const list = missing.get(card.token.mintAddress) ?? [];
        list.push(card.token);
        missing.set(card.token.mintAddress, list);
      }
    }
  }
  const now = Date.now();
  for (const [mint, until] of noArtworkUntil) if (until <= now) noArtworkUntil.delete(mint);
  const asked = [...missing.keys()].filter((mint) => !noArtworkUntil.has(mint)).slice(0, IMAGE_LOOKUP_MAX);
  if (asked.length === 0) return;
  let found: Map<string, string>;
  try {
    found = await lookup(asked);
  } catch (err) {
    logger.warn("token artwork lookup failed", { error: String(err) });
    return;
  }
  for (const mint of asked) {
    const url = found.get(mint);
    if (!url || !/^https:\/\/\S+$/.test(url)) {
      if (noArtworkUntil.size < NO_ARTWORK_MAX) noArtworkUntil.set(mint, now + NO_ARTWORK_RETRY_MS);
      continue;
    }
    for (const token of missing.get(mint) ?? []) token.imageUrl = url;
    await prisma.token.updateMany({ where: { mintAddress: mint, imageUrl: null }, data: { imageUrl: url } });
  }
}

export interface DispatchSummary {
  chats: number;
  sent: number;
  digests: number;
  failed: number;
  /**
   * Of failed: sends Telegram refused for that one chat or message (the bot blocked or kicked, the
   * chat gone or moved, a message it wouldn't take). A broken chat, not a broken dispatcher, so
   * these never fail the pass on their own (dispatchFailure).
   */
  chatErrors: number;
  skipped: number;
  /** Chats left for the next pass because their account's access couldn't be read. */
  accessErrors: number;
  /**
   * Sends whose answer never came back (a timeout, a dropped connection, a Telegram 5xx). Telegram
   * may have delivered them, so they are not sent again.
   */
  unconfirmed: number;
  /** Sends skipped because their claim was already taken: the alert had gone out already. */
  duplicates: number;
  /**
   * How far the pass read (alerts stamped at or before this). The worker keeps a wake-up for an
   * alert written after it, so a pass the open-transaction bound held back is followed up soon.
   * Unset when the pass read nothing (no token, no chats, or another process holds the lock).
   */
  horizon?: Date;
}

type ChatRow = Awaited<ReturnType<typeof loadChats>>[number];

function loadChats() {
  return prisma.telegramChat.findMany({
    where: { revokedAt: null, enabled: true },
    select: {
      id: true,
      chatId: true,
      kind: true,
      filterMatches: true,
      modelCalls: true,
      hidden: true,
      layout: true,
      links: true,
      sentThrough: true,
      lastSentAt: true,
      failures: true,
      picksFallbackNoticedAt: true,
      user: {
        select: {
          id: true,
          walletAddress: true,
          curatedModel: true,
          feedModels: true,
          showModelAlerts: true,
          followBestModel: true,
          telegramSameAsFeed: true,
          telegramModels: true,
          telegramHighConvictionOnly: true,
          feedAppearance: true,
        },
      },
    },
  });
}

/**
 * Whether model calls can reach a chat: it takes them, and the account sends Telegram some. While
 * Telegram follows the Live Feed that needs the feed's model alerts on; Telegram's own picks
 * (curation/feedModels.ts resolveTelegramModels) and its high-conviction-only setting don't
 * depend on that switch.
 */
function takesCalls(chat: {
  modelCalls: boolean;
  user: { showModelAlerts: boolean; telegramSameAsFeed: boolean; telegramHighConvictionOnly: boolean };
}): boolean {
  return (
    chat.modelCalls &&
    (chat.user.telegramHighConvictionOnly || !chat.user.telegramSameAsFeed || chat.user.showModelAlerts)
  );
}

/** One token's send as TelegramAlertSent records it. */
export interface SentAlert {
  tokenId: string;
  curatedAlertId: string | null;
  matchId: string | null;
}

/**
 * A send's idempotency key (TelegramAlertSent.dedupeKey): the chat, the token, and the alert the
 * card carries for it. Two passes that read the same cursor build the same key, and a later alert
 * on the token (another model's call, a re-alert a day on) a new one.
 */
export function sendKey(chatRowId: string, send: SentAlert, through: Date): string {
  const alert = send.curatedAlertId
    ? `call:${send.curatedAlertId}`
    : send.matchId
      ? `match:${send.matchId}`
      : `at:${through.toISOString()}`;
  return `${chatRowId}:${send.tokenId}:${alert}`;
}

/**
 * Whether a failed send may still have reached the chat: Telegram never answered (a timeout, a
 * connection dropped mid-request) or answered with a server error after taking it. Resending
 * those is what put the same alert in a chat over and over, so they are not resent.
 */
export function mayHaveDelivered(result: { code: number; undelivered?: true }): boolean {
  return (result.code === 0 && !result.undelivered) || result.code >= 500;
}

/** Something to tell a chat about: one token, everything raised on it since the cursor. */
interface Pending {
  card: AlertCard;
  /** The tokens it is about: one, or a digest's several. */
  tokenIds: string[];
  /**
   * Per token, the alert the card carries that a board grades it by: its earliest call from the
   * chat's models (whose figures the card leads with), else its earliest filter match.
   */
  sends: SentAlert[];
  /** The cursor moves here once this is sent. */
  through: Date;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function dashboardUrl(env: Env): string {
  if (env.TELEGRAM_DASHBOARD_URL) return env.TELEGRAM_DASHBOARD_URL.replace(/\/$/, "");
  const host = env.PUBLIC_APP_DOMAIN.split(",")[0]?.trim();
  if (!host) return "";
  return host.startsWith("localhost") ? `http://${host}` : `https://${host}`;
}

/**
 * Groups a chat's new matches and calls by token, newest last, so a coin two models called and
 * the person's filter caught is one message, not three.
 */
export function buildPending(
  chat: { filterMatches: boolean; modelCalls: boolean; sentThrough: Date },
  matches: {
    id?: string;
    tokenId: string;
    matchedAt: Date;
    score: number;
    filter: { name: string };
    alertMcapUsd?: number | null;
    token: AlertCard["token"];
    snapshot: AlertCard["snapshot"];
  }[],
  calls: {
    id?: string;
    tokenId: string;
    createdAt: Date;
    modelName: string | null;
    model: string | null;
    confidence: number;
    tier: string | null;
    calibratedPct: number | null;
    reasons: string[];
    narrativeVerdict: string | null;
    liveMcapUsd?: number | null;
    anchorMcapUsd?: number;
    token: AlertCard["token"];
    snapshot: AlertCard["snapshot"];
  }[],
  horizon: Date,
): Pending[] {
  const byToken = new Map<string, Pending>();
  const take = (tokenId: string, at: Date, token: AlertCard["token"], snapshot: AlertCard["snapshot"]) => {
    let p = byToken.get(tokenId);
    if (!p) {
      p = {
        card: { token, snapshot, filters: [], calls: [], raisedAt: at },
        tokenIds: [tokenId],
        sends: [{ tokenId, curatedAlertId: null, matchId: null }],
        through: at,
      };
      byToken.set(tokenId, p);
    }
    if (at > p.through) {
      p.through = at;
      p.card.raisedAt = at;
    }
    if (!p.card.snapshot && snapshot) p.card.snapshot = snapshot;
    return p;
  };
  const inWindow = (at: Date) => at > chat.sentThrough && at <= horizon;
  if (chat.filterMatches) {
    for (const m of matches) {
      if (!inWindow(m.matchedAt)) continue;
      // The price the alert was priced at when the scan had a fresh quote (Match.alertMcapUsd),
      // over the snapshot's DexScreener figure, 45-60 s behind.
      const snapshot =
        m.snapshot && m.alertMcapUsd != null && m.alertMcapUsd > 0
          ? { ...m.snapshot, marketCapUsd: m.alertMcapUsd }
          : m.snapshot;
      const p = take(m.tokenId, m.matchedAt, m.token, snapshot);
      // Read oldest first, so the first one kept is the earliest.
      if (m.id && p.sends[0]!.matchId === null) p.sends[0]!.matchId = m.id;
      if (!p.card.filters.some((f) => f.name === m.filter.name)) {
        p.card.filters.push({ name: m.filter.name, score: m.score });
      }
    }
  }
  if (chat.modelCalls) {
    // Per coin, which of a call's figures its card's market cap was set from.
    const callMcapSet = new Map<string, "anchor">();
    for (const c of calls) {
      if (!inWindow(c.createdAt)) continue;
      const p = take(c.tokenId, c.createdAt, c.token, c.snapshot);
      if (c.id && p.sends[0]!.curatedAlertId === null) p.sends[0]!.curatedAlertId = c.id;
      // The call's stored anchor, over the scan snapshot's (a filter match's included): that
      // one is DexScreener's, 45-60s behind the market. liveMcapUsd is a later print and must
      // not replace the anchor the card and the grades use.
      const set = callMcapSet.get(c.tokenId);
      if (p.card.snapshot && set !== "anchor" && c.anchorMcapUsd !== undefined && c.anchorMcapUsd > 0) {
        p.card.snapshot = { ...p.card.snapshot, marketCapUsd: c.anchorMcapUsd };
        callMcapSet.set(c.tokenId, "anchor");
      }
      const modelName = c.modelName ?? c.model ?? "A model";
      if (!p.card.calls.some((k) => k.modelName === modelName)) {
        p.card.calls.push({
          modelName,
          confidence: c.confidence,
          tier: c.tier,
          calibratedPct: c.calibratedPct,
          reasons: c.reasons,
          narrativeVerdict: c.narrativeVerdict,
        });
      }
    }
  }
  return [...byToken.values()].sort((a, b) => a.through.getTime() - b.through.getTime());
}

const TOKEN_SELECT = {
  mintAddress: true,
  symbol: true,
  name: true,
  firstSeenAt: true,
  imageUrl: true,
} as const;
const SNAPSHOT_SELECT = {
  marketCapUsd: true,
  holderCount: true,
  holderCountAt: true,
  volume1hUsd: true,
} as const;

/** Held for the length of a pass, so only one process is ever sending. */
export const TELEGRAM_DISPATCH_LOCK = "telegram-dispatch";
/** Past the pass budget plus one slow send (artwork fetch, photo, the text retry). */
const PASS_TRANSACTION_TIMEOUT_MS = 120_000;

/** One pass. Returns what it did, for the heartbeat. */
/**
 * Why a pass failed although it ran to the end, or null: it had alerts to send and every send
 * failed (Telegram unreachable, a revoked bot token). Such a pass returned normally and recorded a
 * success, so /health/worker and pipeline-watch read a dispatcher delivering nothing as healthy
 * until the chats' cursors fell 15 minutes behind.
 */
export function dispatchFailure(summary: DispatchSummary): string | null {
  // A subscriber who blocked the bot fails only their own chat: with no other alert in the pass,
  // counting it would report the whole dispatcher down.
  if (summary.failed - summary.chatErrors <= 0 || summary.sent + summary.digests > 0) return null;
  return `every Telegram send failed (${summary.failed} of ${summary.failed} this pass)`;
}

export async function runTelegramDispatch(env: Env, deps: DispatchDeps = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    chats: 0,
    sent: 0,
    digests: 0,
    failed: 0,
    chatErrors: 0,
    skipped: 0,
    accessErrors: 0,
    unconfirmed: 0,
    duplicates: 0,
  };
  if (!telegramConfigured(env.TELEGRAM_BOT_TOKEN)) return summary;
  // A deploy runs the old scanner and the new one side by side, and two passes reading the same
  // cursors would send every alert twice. The lock is transaction-scoped, so it is held for the
  // pass and released however the pass ends; a process that doesn't get it skips this pass.
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${TELEGRAM_DISPATCH_LOCK})) AS locked`;
      if (!lock?.locked) return summary;
      await namePassLock(tx);
      return dispatchPass(env, deps, summary, tx);
    },
    { maxWait: 10_000, timeout: PASS_TRANSACTION_TIMEOUT_MS },
  );
}

async function dispatchPass(
  env: Env,
  deps: DispatchDeps,
  summary: DispatchSummary,
  tx: Prisma.TransactionClient,
): Promise<DispatchSummary> {
  const api = deps.api ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const admins = adminWalletSet(env);
  const hasAccess =
    deps.hasAccess ?? (async (wallet: string) => (await resolveAccess(wallet, admins)).hasAccess);
  const links: AlertLinks = { dashboardUrl: dashboardUrl(env) };

  const chats = await loadChats();
  summary.chats = chats.length;
  if (chats.length === 0) return summary;

  const startedAt = now();
  const openSince = await (deps.oldestOpenTransaction ?? (() => oldestOpenTransaction(tx)))();
  const horizon = new Date(
    Math.max(
      startedAt - MAX_COMMIT_WAIT_MS,
      Math.min(startedAt - COMMIT_GRACE_MS, openSince ? openSince.getTime() - 1 : Infinity),
    ),
  );
  summary.horizon = horizon;
  const oldest = new Date(startedAt - MAX_ALERT_AGE_MS);
  // A chat whose cursor fell behind the window (the worker was down) skips the stale backlog.
  for (const chat of chats) if (chat.sentThrough < oldest) chat.sentThrough = oldest;
  const since = new Date(Math.min(...chats.map((c) => c.sentThrough.getTime())));

  const matchUsers = [...new Set(chats.filter((c) => c.filterMatches).map((c) => c.user.id))];
  const wantsCalls = chats.some(takesCalls);
  const [matches, calls] = await Promise.all([
    matchUsers.length === 0
      ? []
      : prisma.match.findMany({
          where: { userId: { in: matchUsers }, matchedAt: { gt: since, lte: horizon } },
          orderBy: { matchedAt: "asc" },
          select: {
            id: true,
            userId: true,
            tokenId: true,
            matchedAt: true,
            score: true,
            filter: { select: { name: true } },
            alertMcapUsd: true,
            token: { select: TOKEN_SELECT },
            snapshot: { select: SNAPSHOT_SELECT },
          },
        }),
    !wantsCalls
      ? []
      : prisma.curatedAlert.findMany({
          where: { createdAt: { gt: since, lte: horizon } },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            tokenId: true,
            createdAt: true,
            model: true,
            modelName: true,
            confidence: true,
            tier: true,
            calibratedPct: true,
            reasons: true,
            narrativeVerdict: true,
            liveMcapUsd: true,
            anchorMcapUsd: true,
            token: { select: TOKEN_SELECT },
            snapshot: { select: SNAPSHOT_SELECT },
          },
        }),
  ]);
  if (matches.length === 0 && calls.length === 0) {
    // Nothing new for anyone: move every cursor up so the next pass reads a short window. Only
    // ever up: a chat linked a moment ago starts at now, past this horizon.
    await prisma.telegramChat.updateMany({
      where: { id: { in: chats.map((c) => c.id) }, revokedAt: null, sentThrough: { lt: horizon } },
      data: { sentThrough: horizon },
    });
    return summary;
  }
  // The roster and default only decide which calls go to whom, so they are read only when there
  // are calls to route: most passes are empty, and this runs every few seconds.
  const state = calls.length > 0 ? await (deps.feedModelState ?? (() => loadFeedModelState(env)))() : null;
  // The Narrative seat's note shows per the user's Customize toggle, else once the seat has proven
  // itself (curation/narrativeNote.ts). Read only when a call carries a note; a failed read keeps
  // the note off rather than holding the alerts.
  const noteReady = calls.some((c) => c.narrativeVerdict !== null)
    ? await (deps.narrativeNoteReady ?? (async () => (await loadNarrativeNoteReadiness()).ready))().catch(
        () => false,
      )
    : false;

  // One alert per token per chat for REALERT_AFTER_MS: a token a chat already heard about (a model
  // called it, or its filter caught it, in an earlier pass) is not sent again when another model
  // calls it later. Each pass groups what it reads by token, but models call a coin minutes apart,
  // so without this the second model's call went out as a second alert for the same coin.
  // Sent long enough ago to be news again: a re-alert, which is a row (a send) of its own.
  const realertBefore = new Date(startedAt - REALERT_AFTER_MS);
  const alreadySent = new Set<string>();
  for (const r of await prisma.telegramAlertSent.findMany({
    where: {
      chatId: { in: chats.map((c) => c.id) },
      tokenId: { in: [...new Set([...matches, ...calls].map((a) => a.tokenId))] },
      sentAt: { gt: realertBefore },
    },
    select: { chatId: true, tokenId: true },
  })) {
    alreadySent.add(`${r.chatId}:${r.tokenId}`);
  }

  // A failed lookup is "unknown", not "no access": moving that chat's cursor would drop this
  // pass's alerts for good on a database blip, so it is left for the next pass instead.
  const access = new Map<string, Promise<boolean | "error">>();
  const accessOf = (wallet: string) => {
    let p = access.get(wallet);
    if (!p) {
      p = hasAccess(wallet).catch((err: unknown) => {
        logger.warn("telegram access lookup failed, leaving the chat for the next pass", {
          error: String(err),
        });
        return "error" as const;
      });
      access.set(wallet, p);
    }
    return p;
  };

  // Every account's access up front, a few at a time, rather than one round trip per chat in
  // turn - with hundreds of linked chats that serial walk alone took seconds of every pass.
  const wallets = [...new Set(chats.map((c) => c.user.walletAddress))];
  for (let i = 0; i < wallets.length; i += ACCESS_CHECK_BATCH) {
    await Promise.all(wallets.slice(i, i + ACCESS_CHECK_BATCH).map(accessOf));
  }

  /** Chats whose Telegram picks just fell back to the top models, or came back. */
  const picksNotices: { chat: ChatRow; fellBack: boolean }[] = [];
  // Chats with nothing to send this pass only need their cursor moved; one write for all of them.
  const caughtUp: string[] = [];
  // Each chat's queue, then the sends interleaved across chats under the spacing rules.
  const queues: { chat: ChatRow; pending: Pending[]; nextAt: number }[] = [];
  for (const chat of chats) {
    const allowed = await accessOf(chat.user.walletAddress);
    if (allowed === "error") {
      summary.accessErrors += 1;
      continue;
    }
    if (!allowed) {
      // No access, no real-time alerts (guests and lapsed subscriptions). The cursor still moves,
      // so access coming back doesn't deliver a backlog.
      summary.skipped += 1;
      caughtUp.push(chat.id);
      continue;
    }
    const mine = matches.filter((m) => m.userId === chat.user.id);
    const callsOn = takesCalls(chat);
    let theirs: typeof calls = [];
    if (callsOn && state) {
      const resolved = resolveTelegramModels(
        state,
        {
          model: chat.user.curatedModel,
          models: chat.user.feedModels,
          followBest: chat.user.followBestModel,
          showModelAlerts: chat.user.showModelAlerts,
        },
        { sameAsFeed: chat.user.telegramSameAsFeed, models: chat.user.telegramModels },
      );
      // "High-conviction only": the tier's calls from any model on the roster, instead of the picks.
      const feedCalls = resolveFeedCalls(state, resolved.models, chat.user.telegramHighConvictionOnly);
      theirs = calls.filter((c) => isFeedCall(feedCalls, c));
      // Its own picks, every one off the roster now: it gets the top models' calls instead, and
      // is told so once (and again if it happens again after a pick came back).
      const fellBack =
        !chat.user.telegramHighConvictionOnly &&
        !chat.user.telegramSameAsFeed &&
        chat.user.telegramModels.length > 0 &&
        resolved.followsDefault;
      if (fellBack !== (chat.picksFallbackNoticedAt !== null)) picksNotices.push({ chat, fellBack });
    }
    const pending = buildPending(
      { ...chat, modelCalls: callsOn },
      mine,
      showsNarrativeNote(narrativeNoteChoice(chat.user.feedAppearance), noteReady)
        ? theirs
        : theirs.map((c) => ({ ...c, narrativeVerdict: null })),
      horizon,
    ).filter((p) => !alreadySent.has(`${chat.id}:${p.tokenIds[0]}`));
    if (pending.length === 0) {
      caughtUp.push(chat.id);
      continue;
    }
    if (pending.length > DIGEST_THRESHOLD) {
      const through = pending[pending.length - 1]!.through;
      queues.push({
        chat,
        pending: [
          {
            card: { ...pending[0]!.card, digest: pending.map((p) => p.card) } as DigestCard,
            tokenIds: pending.flatMap((p) => p.tokenIds),
            sends: pending.flatMap((p) => p.sends),
            through,
          },
        ],
        nextAt: 0,
      });
    } else {
      queues.push({ chat, pending, nextAt: 0 });
    }
  }

  if (caughtUp.length > 0) {
    await prisma.telegramChat.updateMany({
      where: { id: { in: caughtUp }, revokedAt: null, sentThrough: { lt: horizon } },
      data: { sentThrough: horizon },
    });
  }
  // Whoever was served longest ago goes first. In load order the same chats were always the last
  // of a big fan-out, and the ones a pass's budget left for the next pass.
  queues.sort((a, b) => (a.chat.lastSentAt?.getTime() ?? 0) - (b.chat.lastSentAt?.getTime() ?? 0));

  // Every picture this pass will send starts downloading now, alongside the artwork lookup below
  // and the first sends, rather than when its first chat's turn comes.
  const photos = newPhotoCache(knownPhotoIds);
  const warmAll = () => {
    for (const q of queues) {
      if (!alertParts(q.chat.hidden).image) continue;
      for (const p of q.pending) {
        const url = isDigest(p.card) ? null : alertImage(p.card.token);
        if (url && !photos.fileIds.has(url)) void api.fetchImageOnce(url, photos);
      }
    }
  };
  warmAll();
  await backfillImages(queues, deps.lookupImages);
  warmAll();

  // Up to MAX_IN_FLIGHT sends are out at once, one per chat at most (so each chat still gets its
  // messages in order), launched no closer together than GLOBAL_GAP_MS. One at a time, each send
  // cost the gap plus Telegram's round trip plus a cursor write - a few messages a second - so a
  // call followed by a few hundred chats ran over several passes and the last chats heard about
  // it minutes late. Overlapping the round trips is what lets the global gap be the limit.
  type Queue = (typeof queues)[number];
  const failed: { chat: ChatRow; what: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  const busy = new Set<Queue>();
  /** Chats Telegram answered with a 429 in this pass. */
  const rateLimited = new Set<string>();
  let lastSendAt = 0;
  const send = async (q: Queue) => {
    let item = q.pending[0]!;
    const spacing = q.chat.kind === "private" ? PRIVATE_GAP_MS : GROUP_GAP_MS;
    // Claimed before it goes out, one row per token under its idempotency key: a key already
    // taken means the alert already went to this chat (a pass running twice, or one that resent
    // after a lost answer), and it isn't sent again. The row is also the send /alerts and
    // /trenchboard credit and grade (apps/api/src/telegramBoards.ts), a re-alert included.
    const keys = item.sends.map((a) => sendKey(q.chat.id, a, item.through));
    const claimedAt = new Date();
    // A single alert keeps its card on its row, which the Refresh button under it rebuilds from
    // (refresh.ts); a digest has no button.
    const single = !isDigest(item.card) && item.sends.length === 1;
    const claimed = new Set(
      (
        await prisma.telegramAlertSent.createManyAndReturn({
          data: item.sends.map((a, i) => ({
            chatId: q.chat.id,
            sentAt: claimedAt,
            ...a,
            dedupeKey: keys[i],
            ...(single ? { card: storedCard(item.card) } : {}),
          })),
          skipDuplicates: true,
          select: { dedupeKey: true },
        })
      ).map((r) => r.dedupeKey),
    );
    if (claimed.size < keys.length) {
      summary.duplicates += keys.length - claimed.size;
      logger.warn("telegram alert already sent to this chat, not repeating it", {
        chat: q.chat.id,
        tokens: item.tokenIds.filter((_, i) => !claimed.has(keys[i]!)),
      });
      const keep = keys.map((k) => claimed.has(k));
      if (claimed.size === 0) {
        q.pending.shift();
        await prisma.telegramChat.updateMany({
          where: { id: q.chat.id, revokedAt: null, sentThrough: { lt: item.through } },
          data: { sentThrough: item.through },
        });
        return;
      }
      // Only a digest carries more than one token: it goes out with the ones not yet sent.
      if (isDigest(item.card)) {
        const cards = item.card.digest.filter((_, i) => keep[i]);
        item = {
          ...item,
          card: { ...cards[0]!, digest: cards } as DigestCard,
          tokenIds: item.tokenIds.filter((_, i) => keep[i]),
          sends: item.sends.filter((_, i) => keep[i]),
        };
      }
    }
    const mine = keys.filter((k) => claimed.has(k));
    /** Gives the claims back when the message certainly didn't go out, so it can be sent later. */
    const release = () => prisma.telegramAlertSent.deleteMany({ where: { dedupeKey: { in: mine } } });

    const parts = alertParts(q.chat.hidden);
    const style = alertStyle(q.chat);
    const message = isDigest(item.card)
      ? digestMessage(item.card.digest, links, parts, style)
      : alertMessage(item.card, links, now(), parts, style);
    const keyboard = single ? refreshKeyboard(item.tokenIds[0]!, claimedAt) : null;
    const result = await api.sendAlert(q.chat.chatId, message, { photos, ...(keyboard ? { keyboard } : {}) });
    if (result.ok) {
      q.pending.shift();
      q.nextAt = now() + spacing;
      if (isDigest(item.card)) summary.digests += 1;
      else summary.sent += 1;
      // If this write fails, the next pass re-reads these and the claims above skip them.
      await prisma.telegramChat.updateMany({
        where: { id: q.chat.id, revokedAt: null },
        data: { sentThrough: item.through, lastSentAt: new Date(), lastError: null, failures: 0 },
      });
      return;
    }
    if (mayHaveDelivered(result)) {
      // The claims stay: the next pass reads this alert again and steps over it rather than
      // sending it a second (third, fourth...) time. Missing one alert beats a chat full of copies.
      summary.unconfirmed += 1;
      logger.warn("telegram send unconfirmed, it may have gone through; not resending", {
        chat: q.chat.id,
        what: `${result.code}: ${result.description}`.slice(0, 300),
      });
    } else {
      await release();
    }
    summary.failed += 1;
    const what = `${result.code}: ${result.description}`.slice(0, 300);
    if (result.migrateToChatId !== undefined) {
      summary.chatErrors += 1;
      // The group became a supergroup with a new id; the same chat, so the row follows it.
      const followed = await prisma.telegramChat
        .updateMany({
          where: { id: q.chat.id },
          data: { chatId: BigInt(result.migrateToChatId), kind: "supergroup" },
        })
        .then(
          () => true,
          (err: unknown) => {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
            throw err;
          },
        );
      if (!followed) {
        // The supergroup was linked again on its own, and that row is the chat now.
        logger.info("telegram group upgraded and linked again, retiring the old row", { chat: q.chat.id });
        await prisma.telegramChat.updateMany({
          where: { id: q.chat.id },
          data: { revokedAt: new Date(), lastError: what },
        });
        q.pending = [];
        return;
      }
      q.chat.chatId = BigInt(result.migrateToChatId);
      q.nextAt = now() + spacing;
      return;
    }
    if (
      result.code === 403 ||
      (result.code === 400 && /chat not found|group chat was deleted/i.test(result.description))
    ) {
      // Blocked, kicked, or the chat is gone: nothing will ever land here again.
      summary.chatErrors += 1;
      logger.info("telegram chat unreachable, unlinking", { chat: q.chat.id, what });
      await prisma.telegramChat.updateMany({
        where: { id: q.chat.id },
        data: { revokedAt: new Date(), lastError: what },
      });
      q.pending = [];
      return;
    }
    if (result.code === 429) {
      const wait = Math.min(MAX_RETRY_AFTER_MS, (result.retryAfter ?? 5) * 1_000);
      rateLimited.add(q.chat.id);
      logger.warn("telegram rate limited", { chat: q.chat.id, wait, chats: rateLimited.size });
      q.nextAt = now() + wait;
      // One chat limited is usually that chat's own limit (a group's twenty a minute, which its
      // commands and previews share), so only it waits. A second chat limited in the same pass
      // means the bot-wide limit, and then every chat waits.
      if (rateLimited.size >= 2) for (const other of queues) other.nextAt = Math.max(other.nextAt, q.nextAt);
      return;
    }
    if (result.code === 400) {
      // The message itself was refused (a parse problem, a message too long): skipping it is
      // the only way forward, and the cursor moves past it so the next pass doesn't repeat it.
      logger.warn("telegram refused a message, skipping it", { chat: q.chat.id, what });
      summary.chatErrors += 1;
      q.pending.shift();
      q.nextAt = now() + spacing;
      await prisma.telegramChat.updateMany({
        where: { id: q.chat.id, revokedAt: null },
        data: { sentThrough: item.through, lastError: what },
      });
      return;
    }
    // Telegram unreachable, a 5xx or a 401: leave the cursor, try again next pass.
    logger.warn("telegram send failed", { chat: q.chat.id, what });
    failed.push({ chat: q.chat, what });
    q.pending = [];
  };
  const launch = (q: Queue) => {
    busy.add(q);
    const p: Promise<void> = send(q)
      .catch((err: unknown) => {
        // A failed bookkeeping write: the cursor stays where it was, so the next pass retries what
        // wasn't claimed. A claimed alert stays claimed, so a send that did go out isn't repeated.
        logger.warn("telegram send bookkeeping failed", { chat: q.chat.id, error: String(err) });
        q.pending = [];
      })
      .finally(() => {
        busy.delete(q);
        inFlight.delete(p);
      });
    inFlight.add(p);
  };

  while (queues.some((q) => q.pending.length > 0) || inFlight.size > 0) {
    const t = now();
    const overBudget = t - startedAt > PASS_BUDGET_MS;
    const ready =
      overBudget || inFlight.size >= MAX_IN_FLIGHT
        ? []
        : queues.filter((q) => q.pending.length > 0 && q.nextAt <= t && !busy.has(q));
    if (ready.length === 0) {
      if (inFlight.size > 0) {
        // Whichever comes first: a send finishing, or the next chat coming off its spacing.
        const waiting = overBudget ? [] : queues.filter((q) => q.pending.length > 0 && !busy.has(q));
        const next = waiting.length === 0 ? null : Math.min(...waiting.map((q) => q.nextAt));
        await Promise.race([...inFlight, ...(next === null ? [] : [sleep(Math.max(1, next - t))])]);
        continue;
      }
      if (overBudget) break;
      const next = Math.min(...queues.filter((q) => q.pending.length > 0).map((q) => q.nextAt));
      await sleep(Math.max(1, next - t));
      continue;
    }
    const gap = GLOBAL_GAP_MS - (t - lastSendAt);
    if (gap > 0) await sleep(gap);
    lastSendAt = now();
    launch(ready[0]!);
  }
  // After the alerts, so the notice doesn't spend a group's send spacing ahead of them.
  for (const { chat, fellBack } of picksNotices) {
    if (fellBack) {
      const sent = await api.sendMessage(chat.chatId, PICKS_FALLBACK_TEXT).catch(() => null);
      if (!sent?.ok) continue; // Told on a later pass.
    }
    await prisma.telegramChat.updateMany({
      where: { id: chat.id },
      data: { picksFallbackNoticedAt: fellBack ? new Date() : null },
    });
  }
  // Keep the newest file_ids for the next passes (a token often comes back with another call).
  for (const url of [...knownPhotoIds.keys()].slice(
    0,
    Math.max(0, knownPhotoIds.size - KNOWN_PHOTO_IDS_MAX),
  )) {
    knownPhotoIds.delete(url);
  }
  // A failure counts against a chat only if Telegram took some other message in this pass: an
  // outage or a revoked token fails every chat at once, and switching them all off for it would
  // leave them paused once Telegram is back.
  const reachable = summary.sent + summary.digests > 0;
  for (const { chat, what } of failed) {
    const failures = reachable ? chat.failures + 1 : chat.failures;
    await prisma.telegramChat.updateMany({
      where: { id: chat.id, revokedAt: null },
      data:
        failures >= MAX_FAILURES
          ? { lastError: what, failures, enabled: false }
          : { lastError: what, failures },
    });
  }
  return summary;
}

/** Sent once when every model a chat's account picked for Telegram has left the roster. */
export const PICKS_FALLBACK_TEXT =
  "ℹ️ The models this account picked for Telegram are no longer running, so this chat now gets the " +
  "<b>top models'</b> alerts instead. Pick again under <b>Filters → Telegram alerts</b>.";

type DigestCard = AlertCard & { digest: AlertCard[] };
function isDigest(card: AlertCard): card is DigestCard {
  return Array.isArray((card as DigestCard).digest);
}
