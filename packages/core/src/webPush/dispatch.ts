import type { Prisma } from "@prisma/client";
import webpush from "web-push";
import type { Env } from "../config/env.js";
import { adminWalletSet } from "../config/env.js";
import { namePassLock, prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { resolveAccess } from "../subscription/access.js";
import {
  isFeedCall,
  loadFeedModelState,
  resolveFeedCalls,
  resolveFeedModels,
  type FeedModelState,
} from "../curation/feedModels.js";
import {
  buildPending,
  COMMIT_GRACE_MS,
  dashboardUrl,
  MAX_ALERT_AGE_MS,
  MAX_COMMIT_WAIT_MS,
  oldestOpenTransaction,
  REALERT_AFTER_MS,
} from "../telegram/dispatch.js";
import type { AlertCard } from "../telegram/format.js";

/**
 * The scanner worker's web-push-dispatch job: every few seconds, push each subscribed browser or
 * installed app the alerts its account got since its cursor, so they arrive with TrenchScanner
 * closed or the phone locked. What is sent follows the account's alert settings (User.alertPrefs:
 * browser notifications on, and which of filter matches and model calls) and its Live Feed's
 * models - what the open dashboard would have notified for (AlertNotifier in apps/web).
 *
 * Built the same way as the Telegram dispatcher (telegram/dispatch.ts) and shares its read
 * horizon, so it reads rather than listens and a restart picks up where it left off.
 */

const logger = createLogger("web-push-dispatch");

/** More alerts than this for one subscription in one pass become one summary notification. */
export const MAX_NOTIFICATIONS = 3;
/** How long a push service holds a message for a phone that's offline: past it, not news. */
const PUSH_TTL_SECONDS = 15 * 60;
/** Sends out at once. */
const MAX_IN_FLIGHT = 16;
/** How long one pass may spend sending before it leaves the rest for the next one. */
const PASS_BUDGET_MS = 25_000;
/** Consecutive failed sends before a subscription is dropped rather than retried forever. */
const MAX_FAILURES = 50;
/** Held for the length of a pass, so only one process is ever sending. */
export const WEB_PUSH_DISPATCH_LOCK = "web-push-dispatch";
const PASS_TRANSACTION_TIMEOUT_MS = 120_000;

export function webPushConfigured(env: Pick<Env, "WEB_PUSH_PUBLIC_KEY" | "WEB_PUSH_PRIVATE_KEY">): boolean {
  return env.WEB_PUSH_PUBLIC_KEY.length > 0 && env.WEB_PUSH_PRIVATE_KEY.length > 0;
}

/** What one push carries; apps/web/public/sw.js shows it. */
export interface PushPayload {
  title: string;
  body: string;
  /** Tokens' artwork (https only); the app icon otherwise. */
  icon?: string;
  /** Replaces a notification with the same tag still on screen. */
  tag: string;
  /** Opened when the notification is tapped. */
  url: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A send's outcome: delivered, gone for good (unsubscribed or expired), or failed this once. */
export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };

export type PushSender = (target: PushTarget, payload: PushPayload) => Promise<SendResult>;

export function webPushSender(env: Env): PushSender {
  const vapidDetails = {
    subject: pushSubject(env),
    publicKey: env.WEB_PUSH_PUBLIC_KEY,
    privateKey: env.WEB_PUSH_PRIVATE_KEY,
  };
  return async (target, payload) => {
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), {
        vapidDetails,
        TTL: PUSH_TTL_SECONDS,
        urgency: "high",
        timeout: 10_000,
      });
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser unsubscribed or the subscription expired. 403 is a key mismatch,
      // which a resend can't fix either.
      const gone = status === 404 || status === 410 || status === 403;
      return { ok: false, gone, error: status ? `HTTP ${status}` : String(err).slice(0, 200) };
    }
  };
}

function pushSubject(env: Env): string {
  const set = env.WEB_PUSH_SUBJECT.trim();
  if (/^(mailto:|https:\/\/)/.test(set)) return set;
  const url = dashboardUrl(env);
  return url.startsWith("https://") ? url : "mailto:admin@trenchscanner.app";
}

/** Whether the endpoint a browser handed over is one we may POST to: https on a public host. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // No IP literals: every real push service (FCM, Mozilla, Apple, Windows) is a DNS name.
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  return host.includes(".");
}

/** The two alert settings the dispatcher reads, from User.alertPrefs (apps/api/src/alertPrefs.ts). */
export function pushPrefs(stored: unknown): { on: boolean; filterMatches: boolean; modelCalls: boolean } {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const notifyOn =
    typeof raw.notifyOn === "object" && raw.notifyOn !== null
      ? (raw.notifyOn as Record<string, unknown>)
      : {};
  return {
    on: raw.browserNotifications === true,
    filterMatches: notifyOn.filterMatches !== false,
    modelCalls: notifyOn.modelCalls !== false,
  };
}

function usd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function tokenName(token: AlertCard["token"]): string {
  return token.symbol ? `$${token.symbol}` : (token.name ?? `${token.mintAddress.slice(0, 4)}…`);
}

/** One alert's notification, worded like the open dashboard's (describe in apps/web/src/alerts.tsx). */
export function describeCard(card: AlertCard): { title: string; body: string } {
  const name = tokenName(card.token);
  const mcap = card.snapshot?.marketCapUsd ?? null;
  const at = mcap !== null && mcap > 0 ? ` at ${usd(mcap)} mcap` : "";
  const filter = card.filters[0]?.name;
  if (card.calls.length > 0) {
    const models = card.calls.map((c) => c.modelName).join(", ");
    const also = filter ? ` "${filter}" caught it too.` : "";
    return { title: `${name}: ${models} alert`, body: `${models} alerted on ${name}${at}.${also}` };
  }
  return {
    title: `${name}: filter match`,
    body: `${filter ? `"${filter}"` : "Your filter"} caught ${name}${at}.`,
  };
}

/** A pass's notifications for one subscription: one per alert, or one summary past MAX_NOTIFICATIONS. */
export function pushPayloads(cards: AlertCard[], url: string): PushPayload[] {
  if (cards.length > MAX_NOTIFICATIONS) {
    return [
      {
        title: `${cards.length} new alerts`,
        body: cards.map((c) => describeCard(c).title).join(" · "),
        tag: "ts-batch",
        url,
      },
    ];
  }
  return cards.map((card) => {
    const image = card.token.imageUrl;
    return {
      ...describeCard(card),
      ...(image && /^https:\/\/\S+$/.test(image) ? { icon: image } : {}),
      tag: `ts-alert-${card.token.mintAddress}`,
      url,
    };
  });
}

export interface WebPushDeps {
  send?: PushSender;
  now?: () => number;
  hasAccess?: (walletAddress: string) => Promise<boolean>;
  feedModelState?: () => Promise<FeedModelState>;
  oldestOpenTransaction?: () => Promise<Date | null>;
}

export interface WebPushSummary {
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  skipped: number;
  /** How far the pass read; unset when it read nothing. */
  horizon?: Date;
}

/** One pass. Returns what it did, for the heartbeat. */
export async function runWebPushDispatch(env: Env, deps: WebPushDeps = {}): Promise<WebPushSummary> {
  const summary: WebPushSummary = { subscriptions: 0, sent: 0, failed: 0, removed: 0, skipped: 0 };
  if (!webPushConfigured(env) && !deps.send) return summary;
  // As in the Telegram dispatcher: two processes reading the same cursors would push twice.
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${WEB_PUSH_DISPATCH_LOCK})) AS locked`;
      if (!lock?.locked) return summary;
      await namePassLock(tx);
      return dispatchPass(env, deps, summary, tx);
    },
    { maxWait: 10_000, timeout: PASS_TRANSACTION_TIMEOUT_MS },
  );
}

function loadSubscriptions() {
  return prisma.webPushSubscription.findMany({
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      sentThrough: true,
      sentTokens: true,
      failures: true,
      user: {
        select: {
          id: true,
          walletAddress: true,
          alertPrefs: true,
          curatedModel: true,
          feedModels: true,
          showModelAlerts: true,
          followBestModel: true,
          feedBothOnly: true,
        },
      },
    },
  });
}

type SubRow = Awaited<ReturnType<typeof loadSubscriptions>>[number];

const TOKEN_SELECT = {
  mintAddress: true,
  symbol: true,
  name: true,
  firstSeenAt: true,
  imageUrl: true,
} as const;
const SNAPSHOT_SELECT = { marketCapUsd: true, holderCount: true, volume1hUsd: true } as const;

/** What a subscription takes: the alert settings, with model calls only while the feed shows them. */
function wants(sub: SubRow) {
  const prefs = pushPrefs(sub.user.alertPrefs);
  const bothOnly = sub.user.showModelAlerts && sub.user.feedBothOnly;
  return {
    on: prefs.on && (prefs.filterMatches || prefs.modelCalls),
    // "Only alerts both caught": every card is both, so it reads both and keeps those.
    filterMatches: bothOnly || prefs.filterMatches,
    modelCalls: sub.user.showModelAlerts && (bothOnly || prefs.modelCalls),
    bothOnly,
  };
}

async function dispatchPass(
  env: Env,
  deps: WebPushDeps,
  summary: WebPushSummary,
  tx: Prisma.TransactionClient,
): Promise<WebPushSummary> {
  const send = deps.send ?? webPushSender(env);
  const now = deps.now ?? Date.now;
  const admins = adminWalletSet(env);
  const hasAccess =
    deps.hasAccess ?? (async (wallet: string) => (await resolveAccess(wallet, admins)).hasAccess);
  const url = `${dashboardUrl(env)}/`;

  const subs = await loadSubscriptions();
  summary.subscriptions = subs.length;
  if (subs.length === 0) return summary;

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
  for (const sub of subs) if (sub.sentThrough < oldest) sub.sentThrough = oldest;

  const active = subs.filter((s) => wants(s).on);
  const caughtUp = subs.filter((s) => !wants(s).on).map((s) => s.id);
  const since = new Date(Math.min(...subs.map((s) => s.sentThrough.getTime())));
  const matchUsers = [...new Set(active.filter((s) => wants(s).filterMatches).map((s) => s.user.id))];
  const wantsCalls = active.some((s) => wants(s).modelCalls);
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
    await moveCursors(
      subs.map((s) => s.id),
      horizon,
    );
    return summary;
  }
  const state = calls.length > 0 ? await (deps.feedModelState ?? (() => loadFeedModelState(env)))() : null;

  const access = new Map<string, Promise<boolean | "error">>();
  const accessOf = (wallet: string) => {
    let p = access.get(wallet);
    if (!p) {
      p = hasAccess(wallet).catch((err: unknown) => {
        logger.warn("web push access lookup failed, leaving the subscription for the next pass", {
          error: String(err),
        });
        return "error" as const;
      });
      access.set(wallet, p);
    }
    return p;
  };

  const jobs: { sub: SubRow; payloads: PushPayload[]; sentTokens: Record<string, number> }[] = [];
  for (const sub of active) {
    const allowed = await accessOf(sub.user.walletAddress);
    if (allowed === "error") continue;
    if (!allowed) {
      // No access, no real-time alerts; the cursor still moves, so access coming back doesn't
      // deliver a backlog.
      summary.skipped += 1;
      caughtUp.push(sub.id);
      continue;
    }
    const w = wants(sub);
    let theirs: typeof calls = [];
    if (w.modelCalls && state) {
      const models = resolveFeedModels(state, {
        model: sub.user.curatedModel,
        models: sub.user.feedModels,
        followBest: sub.user.followBestModel,
      }).models;
      const feedCalls = resolveFeedCalls(state, models, false);
      theirs = calls.filter((c) => isFeedCall(feedCalls, c));
    }
    const sentTokens = recentTokens(sub.sentTokens, startedAt);
    const pending = buildPending(
      { filterMatches: w.filterMatches, modelCalls: w.modelCalls, sentThrough: sub.sentThrough },
      matches.filter((m) => m.userId === sub.user.id),
      theirs,
      horizon,
    )
      .filter((p) => !w.bothOnly || (p.card.filters.length > 0 && p.card.calls.length > 0))
      .filter((p) => !(p.tokenIds[0]! in sentTokens));
    if (pending.length === 0) {
      caughtUp.push(sub.id);
      continue;
    }
    for (const p of pending) sentTokens[p.tokenIds[0]!] = startedAt;
    jobs.push({
      sub,
      payloads: pushPayloads(
        pending.map((p) => p.card),
        url,
      ),
      sentTokens,
    });
  }
  await moveCursors(caughtUp, horizon);

  // Sends interleaved across subscriptions, a few at a time, inside the pass budget.
  const queue = [...jobs];
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      if (now() - startedAt > PASS_BUDGET_MS) return;
      await deliver(job.sub, job.payloads, job.sentTokens, horizon, send, summary);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, queue.length) }, worker));
  return summary;
}

/** The stored token -> sent-at map, less what is old enough to be news again. */
function recentTokens(stored: Prisma.JsonValue, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return out;
  for (const [tokenId, at] of Object.entries(stored)) {
    if (typeof at === "number" && at > now - REALERT_AFTER_MS) out[tokenId] = at;
  }
  return out;
}

async function deliver(
  sub: SubRow,
  payloads: PushPayload[],
  sentTokens: Record<string, number>,
  horizon: Date,
  send: PushSender,
  summary: WebPushSummary,
): Promise<void> {
  const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  let lastError: string | null = null;
  let delivered = false;
  for (const payload of payloads) {
    const result = await send(target, payload);
    if (result.ok) {
      delivered = true;
      summary.sent += 1;
      continue;
    }
    summary.failed += 1;
    lastError = result.error;
    if (result.gone || sub.failures + 1 >= MAX_FAILURES) {
      summary.removed += 1;
      await prisma.webPushSubscription.deleteMany({ where: { id: sub.id } });
      return;
    }
  }
  // The cursor moves either way: a push service that failed now won't be sent a stale alert later.
  await prisma.webPushSubscription.updateMany({
    where: { id: sub.id },
    data: {
      sentThrough: horizon,
      sentTokens: sentTokens as Prisma.InputJsonValue,
      ...(delivered ? { lastSentAt: new Date(), failures: 0, lastError: null } : {}),
      ...(lastError && !delivered ? { lastError, failures: { increment: 1 } } : {}),
    },
  });
}

async function moveCursors(ids: string[], horizon: Date): Promise<void> {
  if (ids.length === 0) return;
  // Only ever up: a subscription made a moment ago starts at now, past this horizon.
  await prisma.webPushSubscription.updateMany({
    where: { id: { in: ids }, sentThrough: { lt: horizon } },
    data: { sentThrough: horizon },
  });
}
