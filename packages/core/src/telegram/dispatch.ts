import type { Env } from "../config/env.js";
import { adminWalletSet } from "../config/env.js";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { resolveAccess } from "../subscription/access.js";
import { loadFeedModelState, resolveFeedModels, type FeedModelState } from "../curation/feedModels.js";
import { TelegramApi, telegramConfigured } from "./api.js";
import { alertMessage, digestMessage, type AlertCard, type AlertLinks } from "./format.js";

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
      sentThrough: true,
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

/** One pass. Returns what it did, for the heartbeat. */
export async function runTelegramDispatch(env: Env, deps: DispatchDeps = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { chats: 0, sent: 0, digests: 0, failed: 0, skipped: 0 };
  if (!telegramConfigured(env.TELEGRAM_BOT_TOKEN)) return summary;
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
  const horizon = new Date(startedAt - COMMIT_GRACE_MS);
  const oldest = new Date(startedAt - MAX_ALERT_AGE_MS);
  // A chat whose cursor fell behind the window (the worker was down) skips the stale backlog.
  for (const chat of chats) if (chat.sentThrough < oldest) chat.sentThrough = oldest;
  const since = new Date(Math.min(...chats.map((c) => c.sentThrough.getTime())));

  const matchUsers = [...new Set(chats.filter((c) => c.filterMatches).map((c) => c.user.id))];
  const wantsCalls = chats.some((c) => c.modelCalls && c.user.showModelAlerts);
  const [matches, calls, state] = await Promise.all([
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
    wantsCalls ? (deps.feedModelState ?? (() => loadFeedModelState(env)))() : Promise.resolve(null),
  ]);
  if (matches.length === 0 && calls.length === 0) {
    // Nothing new for anyone: move every cursor up so the next pass reads a short window.
    await prisma.telegramChat.updateMany({
      where: { id: { in: chats.map((c) => c.id) }, revokedAt: null },
      data: { sentThrough: horizon },
    });
    return summary;
  }

  const access = new Map<string, Promise<boolean>>();
  const accessOf = (wallet: string) => {
    let p = access.get(wallet);
    if (!p) {
      p = hasAccess(wallet).catch(() => false);
      access.set(wallet, p);
    }
    return p;
  };

  // Each chat's queue, then the sends interleaved across chats under the spacing rules.
  const queues: { chat: ChatRow; pending: Pending[]; nextAt: number }[] = [];
  for (const chat of chats) {
    if (!(await accessOf(chat.user.walletAddress))) {
      // No access, no real-time alerts (guests and lapsed subscriptions). The cursor still moves,
      // so access coming back doesn't deliver a backlog.
      summary.skipped += 1;
      await prisma.telegramChat.updateMany({
        where: { id: chat.id, revokedAt: null },
        data: { sentThrough: horizon },
      });
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
      theirs,
      horizon,
    );
    if (pending.length === 0) {
      await prisma.telegramChat.updateMany({
        where: { id: chat.id, revokedAt: null },
        data: { sentThrough: horizon },
      });
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

  let lastSendAt = 0;
  while (queues.some((q) => q.pending.length > 0)) {
    const t = now();
    if (t - startedAt > PASS_BUDGET_MS) break;
    const ready = queues.filter((q) => q.pending.length > 0 && q.nextAt <= t);
    if (ready.length === 0) {
      const next = Math.min(...queues.filter((q) => q.pending.length > 0).map((q) => q.nextAt));
      await sleep(Math.max(1, next - t));
      continue;
    }
    const gap = GLOBAL_GAP_MS - (t - lastSendAt);
    if (gap > 0) await sleep(gap);
    const q = ready[0]!;
    const item = q.pending[0]!;
    const message = isDigest(item.card)
      ? digestMessage(item.card.digest, links)
      : alertMessage(item.card, links, now());
    lastSendAt = now();
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
      continue;
    }
    summary.failed += 1;
    const what = `${result.code}: ${result.description}`.slice(0, 300);
    if (result.migrateToChatId !== undefined) {
      // The group became a supergroup with a new id; the same chat, so the row follows it.
      await prisma.telegramChat.updateMany({
        where: { id: q.chat.id },
        data: { chatId: BigInt(result.migrateToChatId), kind: "supergroup" },
      });
      q.chat.chatId = BigInt(result.migrateToChatId);
      q.nextAt = now() + spacing;
      continue;
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
      continue;
    }
    if (result.code === 429) {
      const wait = Math.min(MAX_RETRY_AFTER_MS, (result.retryAfter ?? 5) * 1_000);
      logger.warn("telegram rate limited", { chat: q.chat.id, wait });
      q.nextAt = now() + wait;
      // Every chat waits: a 429 is usually the global limit.
      for (const other of queues) other.nextAt = Math.max(other.nextAt, q.nextAt);
      continue;
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
      continue;
    }
    // Telegram unreachable or a 5xx: leave the cursor, try again next pass.
    const failures = q.chat.failures + 1;
    logger.warn("telegram send failed", { chat: q.chat.id, what, failures });
    await prisma.telegramChat.updateMany({
      where: { id: q.chat.id, revokedAt: null },
      data:
        failures >= MAX_FAILURES
          ? { lastError: what, failures, enabled: false }
          : { lastError: what, failures },
    });
    q.pending = [];
  }
  return summary;
}

type DigestCard = AlertCard & { digest: AlertCard[] };
function isDigest(card: AlertCard): card is DigestCard {
  return Array.isArray((card as DigestCard).digest);
}
