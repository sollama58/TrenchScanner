import { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { adminWalletSet } from "../config/env.js";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { resolveAccess } from "../subscription/access.js";
import { loadFeedModelState, resolveFeedModels, type FeedModelState } from "../curation/feedModels.js";
import { TelegramApi, telegramConfigured } from "./api.js";
import { alertMessage, alertParts, digestMessage, type AlertCard, type AlertLinks } from "./format.js";

/**
 * The scanner worker's telegram-dispatch job: every few seconds, send each linked chat the
 * alerts its account got since the chat's cursor - the account's filter matches (Match rows)
 * and the calls of the models in its feed (CuratedAlert rows), exactly what the Live tab would
 * show that person. A chat is the unit: a person can have the bot in a private chat and in two
 * groups, each with its own switches and its own cursor.
 *
 * Reads rather than listens: Postgres NOTIFY (notify.ts) is not durable, and a cursor per chat
 * means a restart or a failed send picks up where it left off instead of losing the alert.
 */

const logger = createLogger("telegram-dispatch");

/**
 * Rows are read only up to this far behind now: a Match's matchedAt is stamped at insert and
 * the row commits a moment later, and a cursor that moved past the stamp in between would skip it.
 */
export const COMMIT_GRACE_MS = 5_000;
/**
 * A transaction still open in the database may yet commit a row stamped as early as its start
 * (matchedAt defaults to the transaction's own now()), so the horizon also stays behind the oldest
 * one open. Bounded: the alert writes give up after 15 s, and a long training query must not hold
 * every alert back.
 */
export const MAX_COMMIT_WAIT_MS = 20_000;
/** An alert older than this when the job gets to it is not news; the cursor steps over it. */
export const MAX_ALERT_AGE_MS = 15 * 60_000;
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
}

/** When the oldest other transaction open in this database began, or null if none is (or unknown). */
async function oldestOpenTransaction(): Promise<Date | null> {
  try {
    const [row] = await prisma.$queryRaw<{ oldest: Date | null }[]>`
      SELECT min(xact_start) AS oldest FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`;
    return row?.oldest ?? null;
  } catch {
    return null;
  }
}

/** The most imageless tokens looked up in one pass: one DexScreener batch. */
const IMAGE_LOOKUP_MAX = 30;

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
  if (missing.size === 0) return;
  let found: Map<string, string>;
  try {
    found = await lookup([...missing.keys()].slice(0, IMAGE_LOOKUP_MAX));
  } catch (err) {
    logger.warn("token artwork lookup failed", { error: String(err) });
    return;
  }
  for (const [mint, url] of found) {
    if (!/^https:\/\/\S+$/.test(url)) continue;
    for (const token of missing.get(mint) ?? []) token.imageUrl = url;
    await prisma.token.updateMany({ where: { mintAddress: mint, imageUrl: null }, data: { imageUrl: url } });
  }
}

export interface DispatchSummary {
  chats: number;
  sent: number;
  digests: number;
  failed: number;
  skipped: number;
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
      sentThrough: true,
      lastSentAt: true,
      failures: true,
      user: {
        select: {
          id: true,
          walletAddress: true,
          curatedModel: true,
          feedModels: true,
          showModelAlerts: true,
          followBestModel: true,
        },
      },
    },
  });
}

/** Something to tell a chat about: one token, everything raised on it since the cursor. */
interface Pending {
  card: AlertCard;
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
    tokenId: string;
    matchedAt: Date;
    score: number;
    filter: { name: string };
    token: AlertCard["token"];
    snapshot: AlertCard["snapshot"];
  }[],
  calls: {
    tokenId: string;
    createdAt: Date;
    modelName: string | null;
    model: string | null;
    confidence: number;
    tier: string | null;
    calibratedPct: number | null;
    reasons: string[];
    narrativeVerdict: string | null;
    token: AlertCard["token"];
    snapshot: AlertCard["snapshot"];
  }[],
  horizon: Date,
): Pending[] {
  const byToken = new Map<string, Pending>();
  const take = (tokenId: string, at: Date, token: AlertCard["token"], snapshot: AlertCard["snapshot"]) => {
    let p = byToken.get(tokenId);
    if (!p) {
      p = { card: { token, snapshot, filters: [], calls: [], raisedAt: at }, through: at };
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
      const p = take(m.tokenId, m.matchedAt, m.token, m.snapshot);
      if (!p.card.filters.some((f) => f.name === m.filter.name)) {
        p.card.filters.push({ name: m.filter.name, score: m.score });
      }
    }
  }
  if (chat.modelCalls) {
    for (const c of calls) {
      if (!inWindow(c.createdAt)) continue;
      const p = take(c.tokenId, c.createdAt, c.token, c.snapshot);
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
const SNAPSHOT_SELECT = { marketCapUsd: true, holderCount: true, volume1hUsd: true } as const;

/** Held for the length of a pass, so only one process is ever sending. */
export const TELEGRAM_DISPATCH_LOCK = "telegram-dispatch";
/** Past the pass budget plus one slow send (artwork fetch, photo, the text retry). */
const PASS_TRANSACTION_TIMEOUT_MS = 120_000;

/** One pass. Returns what it did, for the heartbeat. */
export async function runTelegramDispatch(env: Env, deps: DispatchDeps = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { chats: 0, sent: 0, digests: 0, failed: 0, skipped: 0 };
  if (!telegramConfigured(env.TELEGRAM_BOT_TOKEN)) return summary;
  // A deploy runs the old scanner and the new one side by side, and two passes reading the same
  // cursors would send every alert twice. The lock is transaction-scoped, so it is held for the
  // pass and released however the pass ends; a process that doesn't get it skips this pass.
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${TELEGRAM_DISPATCH_LOCK})) AS locked`;
      if (!lock?.locked) return summary;
      return dispatchPass(env, deps, summary);
    },
    { maxWait: 10_000, timeout: PASS_TRANSACTION_TIMEOUT_MS },
  );
}

async function dispatchPass(
  env: Env,
  deps: DispatchDeps,
  summary: DispatchSummary,
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
  const openSince = await (deps.oldestOpenTransaction ?? oldestOpenTransaction)();
  const horizon = new Date(
    Math.max(
      startedAt - MAX_COMMIT_WAIT_MS,
      Math.min(startedAt - COMMIT_GRACE_MS, openSince ? openSince.getTime() - 1 : Infinity),
    ),
  );
  const oldest = new Date(startedAt - MAX_ALERT_AGE_MS);
  // A chat whose cursor fell behind the window (the worker was down) skips the stale backlog.
  for (const chat of chats) if (chat.sentThrough < oldest) chat.sentThrough = oldest;
  const since = new Date(Math.min(...chats.map((c) => c.sentThrough.getTime())));

  const matchUsers = [...new Set(chats.filter((c) => c.filterMatches).map((c) => c.user.id))];
  const wantsCalls = chats.some((c) => c.modelCalls && c.user.showModelAlerts);
  const [matches, calls] = await Promise.all([
    matchUsers.length === 0
      ? []
      : prisma.match.findMany({
          where: { userId: { in: matchUsers }, matchedAt: { gt: since, lte: horizon } },
          orderBy: { matchedAt: "asc" },
          select: {
            userId: true,
            tokenId: true,
            matchedAt: true,
            score: true,
            filter: { select: { name: true } },
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
            tokenId: true,
            createdAt: true,
            model: true,
            modelName: true,
            confidence: true,
            tier: true,
            calibratedPct: true,
            reasons: true,
            narrativeVerdict: true,
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

  const access = new Map<string, Promise<boolean>>();
  const accessOf = (wallet: string) => {
    let p = access.get(wallet);
    if (!p) {
      p = hasAccess(wallet).catch(() => false);
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

  // Chats with nothing to send this pass only need their cursor moved; one write for all of them.
  const caughtUp: string[] = [];
  // Each chat's queue, then the sends interleaved across chats under the spacing rules.
  const queues: { chat: ChatRow; pending: Pending[]; nextAt: number }[] = [];
  for (const chat of chats) {
    if (!(await accessOf(chat.user.walletAddress))) {
      // No access, no real-time alerts (guests and lapsed subscriptions). The cursor still moves,
      // so access coming back doesn't deliver a backlog.
      summary.skipped += 1;
      caughtUp.push(chat.id);
      continue;
    }
    const mine = matches.filter((m) => m.userId === chat.user.id);
    let theirs: typeof calls = [];
    if (chat.modelCalls && chat.user.showModelAlerts && state) {
      const models = new Set(
        resolveFeedModels(state, {
          model: chat.user.curatedModel,
          models: chat.user.feedModels,
          followBest: chat.user.followBestModel,
        }).models,
      );
      theirs = calls.filter((c) => c.model !== null && models.has(c.model));
    }
    const pending = buildPending(
      { ...chat, modelCalls: chat.modelCalls && chat.user.showModelAlerts },
      mine,
      // The Narrative seat's note stays off the message while NARRATIVE_NOTES_SHOWN is off.
      env.NARRATIVE_NOTES_SHOWN ? theirs : theirs.map((c) => ({ ...c, narrativeVerdict: null })),
      horizon,
    );
    if (pending.length === 0) {
      caughtUp.push(chat.id);
      continue;
    }
    if (pending.length > DIGEST_THRESHOLD) {
      const through = pending[pending.length - 1]!.through;
      queues.push({
        chat,
        pending: [
          { card: { ...pending[0]!.card, digest: pending.map((p) => p.card) } as DigestCard, through },
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

  await backfillImages(queues, deps.lookupImages);

  // Up to MAX_IN_FLIGHT sends are out at once, one per chat at most (so each chat still gets its
  // messages in order), launched no closer together than GLOBAL_GAP_MS. One at a time, each send
  // cost the gap plus Telegram's round trip plus a cursor write - a few messages a second - so a
  // call followed by a few hundred chats ran over several passes and the last chats heard about
  // it minutes late. Overlapping the round trips is what lets the global gap be the limit.
  type Queue = (typeof queues)[number];
  const failed: { chat: ChatRow; what: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  const busy = new Set<Queue>();
  let lastSendAt = 0;
  const send = async (q: Queue) => {
    const item = q.pending[0]!;
    const parts = alertParts(q.chat.hidden);
    const message = isDigest(item.card)
      ? digestMessage(item.card.digest, links, parts)
      : alertMessage(item.card, links, now(), parts);
    const result = await api.sendAlert(q.chat.chatId, message);
    const spacing = q.chat.kind === "private" ? PRIVATE_GAP_MS : GROUP_GAP_MS;
    if (result.ok) {
      q.pending.shift();
      q.nextAt = now() + spacing;
      if (isDigest(item.card)) summary.digests += 1;
      else summary.sent += 1;
      await prisma.telegramChat.updateMany({
        where: { id: q.chat.id, revokedAt: null },
        data: { sentThrough: item.through, lastSentAt: new Date(), lastError: null, failures: 0 },
      });
      return;
    }
    summary.failed += 1;
    const what = `${result.code}: ${result.description}`.slice(0, 300);
    if (result.migrateToChatId !== undefined) {
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
      logger.warn("telegram rate limited", { chat: q.chat.id, wait });
      q.nextAt = now() + wait;
      // Every chat waits: a 429 is usually the global limit.
      for (const other of queues) other.nextAt = Math.max(other.nextAt, q.nextAt);
      return;
    }
    if (result.code === 400) {
      // The message itself was refused (a parse problem, a message too long): skipping it is
      // the only way forward, and the cursor moves past it so the next pass doesn't repeat it.
      logger.warn("telegram refused a message, skipping it", { chat: q.chat.id, what });
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
        // A failed bookkeeping write: the cursor stays where it was, so the next pass retries.
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

type DigestCard = AlertCard & { digest: AlertCard[] };
function isDigest(card: AlertCard): card is DigestCard {
  return Array.isArray((card as DigestCard).digest);
}
