import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  adminWalletSet,
  openLookup,
  prisma,
  resolveAccess,
  resolveFeedCalls,
  type Env,
  type FeedCalls,
} from "@trenchscanner/core";
import { clientIp, ipRateLimitKey } from "../clientIp.js";
import { contestState, resolveFeedModels, SAVED_FEED_SELECT, toSavedFeed } from "../contest.js";
import {
  extensionKeyAccess,
  extensionKeyDeniedMessage,
  extensionKeyFromHeader,
  extensionKeyMatches,
  extensionRateLimitBucket,
  hashExtensionKey,
  isExtensionKeyShape,
} from "../extensionKey.js";
import { isMintAddress, lookupOverlay, recentOverlay, type OverlayToken } from "../extensionLookup.js";
import {
  overlayBubbleMap,
  pickBubbleScan,
  type BubbleScan,
  type OverlayBubbleMap,
} from "../extensionBubble.js";
import { buddyAnswer, buddyCoins, type BuddyAnswer } from "../extensionBuddy.js";
import { freeLookupReason } from "../lookupGate.js";
import { overlaySettingsSchema, parseOverlaySettings } from "../overlaySettings.js";
import { cachedProStatus } from "../proMode.js";
import { releaseHolderStamps, type ViewStampBuffer } from "../viewStamps.js";
import { allowHolderWatch } from "./live.js";
import type { ProTrades } from "./proTrades.js";
import { readTokenReading } from "./tokens.js";

/**
 * The browser extension's API (/ext/v1). The extension is a side panel with no access to any
 * trading site, so nothing here takes addresses from a page: it lists the reader's own alerts. Every route takes an extension key as
 * `Authorization: Bearer tsx_...` and nothing else: no cookie is read here, which is why
 * server.ts lets these routes through its Origin check (an extension's requests carry a
 * chrome-extension:// origin, and a page elsewhere cannot make a browser attach this header).
 *
 * The key reads the owner's alerts, token stats and overlay settings, and saves the overlay
 * settings. Paid access only, the Model Alert rule (user decision 2026-10-23). Since 2026-10-24
 * it also reads a coin's latest bubble map and the owner's own trades (Trade Buddy). Nothing here
 * trades: a Pro trade is signed by the owner's wallet on TrenchScanner itself.
 */

/** How long a key's check is reused on this process. Revoking from Settings clears it here at once. */
const AUTH_CACHE_MS = 30_000;
const AUTH_CACHE_MAX = 5_000;
/** Failed key checks remembered per address, as on the Model Alert socket. */
const AUTH_FAILURE_WINDOW_MS = 60_000;
export const EXTENSION_AUTH_FAILURES_PER_MINUTE = 30;
const MAX_FAILURE_ADDRESSES = 10_000;
/** How often lastUsedAt is written for one key. */
const LAST_USED_EVERY_MS = 10 * 60_000;

/** Feed reads a key may make a minute: an open panel polls every 5 s, plus a second window. */
const FEED_RATE_LIMIT = { max: 90, timeWindow: "1 minute" };
/** One reader's feed is reused this long, so two open windows (or a burst of polls) cost one read. */
const FEED_CACHE_MS = 4_000;
const FEED_CACHE_MAX = 5_000;
const SETTINGS_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
/** Bubble map reads a minute: the panel re-reads each open map every 30 s, a handful at once. */
const BUBBLE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
/** One coin's map is reused this long for every reader (the site's own read is cached 15 s). */
const BUBBLE_CACHE_MS = 10_000;
const BUBBLE_CACHE_MAX = 2_000;
/** Trade Buddy reads a minute: the panel polls every 5 s (every 10 s before 0.3.1), plus a second window. */
const BUDDY_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** A Trade Buddy answer this fresh is served as is; an older one is served while a new one is read. */
const BUDDY_FRESH_MS = 3_000;
/** An answer this old is dropped rather than served: a reader back after a while waits for a fresh read. */
const BUDDY_KEEP_MS = 60_000;

export interface ExtensionClient {
  keyId: string;
  userId: string;
  walletAddress: string;
  /** The AI reviewer's verdicts are admin-only on the site, and so in the feed (audit CE-1). */
  aiReviews: boolean;
}

interface CachedAuth {
  at: number;
  client: ExtensionClient;
}

const authCache = new Map<string, CachedAuth>();
/** Each reader's last Trade Buddy answer, and the read running behind it (buddyFor). */
const buddyAnswers = new Map<
  string,
  { at: number; body: BuddyAnswer | null; reading: Promise<BuddyAnswer> | null }
>();
const authFailures = new Map<string, number[]>();
const lastUsedWritten = new Map<string, number>();
const feedCache = new Map<string, { at: number; tokens: OverlayToken[] }>();
const bubbleCache = new Map<string, { at: number; map: OverlayBubbleMap | null }>();

/** Drops a key's cached check, so a revoke on this process takes effect on the next request. */
export function forgetExtensionKey(keyId: string): void {
  for (const [hash, entry] of authCache) if (entry.client.keyId === keyId) authCache.delete(hash);
}

/** Drops every cached check of one user's keys: their sign-out everywhere revoked them. */
export function forgetExtensionKeysOf(userId: string): void {
  for (const [hash, entry] of authCache) if (entry.client.userId === userId) authCache.delete(hash);
}

export function resetExtensionAuthState(): void {
  authCache.clear();
  authFailures.clear();
  feedCache.clear();
  bubbleCache.clear();
  lastUsedWritten.clear();
}

function recentFailures(address: string, now: number): number[] {
  const kept = (authFailures.get(address) ?? []).filter((t) => now - t < AUTH_FAILURE_WINDOW_MS);
  if (kept.length === 0) authFailures.delete(address);
  else authFailures.set(address, kept);
  return kept;
}

function recordFailure(address: string, now: number): void {
  if (!authFailures.has(address) && authFailures.size >= MAX_FAILURE_ADDRESSES) {
    const oldest = authFailures.keys().next().value;
    if (oldest !== undefined) authFailures.delete(oldest);
  }
  authFailures.set(address, [...recentFailures(address, now), now]);
}

declare module "fastify" {
  interface FastifyRequest {
    extensionClient?: ExtensionClient;
  }
}

/** A coin's map for the panel: its picked scan, newest scan and top 50, as the token view reads them. */
async function readOverlayBubble(mint: string): Promise<OverlayBubbleMap | null> {
  const [reading, wide] = await Promise.all([
    readTokenReading(mint),
    prisma.bubbleMapHolders.findUnique({
      where: { mintAddress: mint },
      select: { readAt: true, holders: true, clusters: true, sameTimeClusters: true },
    }),
  ]);
  if (!reading) return null;
  const scans = reading.snapshots as unknown as BubbleScan[];
  return overlayBubbleMap(mint, reading.symbol, pickBubbleScan(scans), scans[0] ?? null, wide);
}

export async function registerExtensionRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    /** The wallet's own trades (routes/proTrades.ts), for Trade Buddy; without it Trade Buddy is empty. */
    proTrades?: ProTrades;
    /** Token.holdersViewedAt, stamped while a map is open in the panel, as the site's token view does. */
    holderStamps?: ViewStampBuffer;
  },
) {
  const admins = adminWalletSet(opts.env);
  // A key's own bucket only once it has been proven (in authCache): rotating made-up keys would
  // otherwise get a fresh bucket per request and flush real keys' buckets (audit CE-2).
  const bucket = (request: FastifyRequest) => {
    const secret = extensionKeyFromHeader(request.headers.authorization);
    if (secret === null || !isExtensionKeyShape(secret)) return ipRateLimitKey(request);
    const cached = authCache.get(hashExtensionKey(secret, opts.env.JWT_SECRET));
    return cached && Date.now() - cached.at < AUTH_CACHE_MS
      ? extensionRateLimitBucket(request.headers.authorization, ipRateLimitKey(request))
      : ipRateLimitKey(request);
  };

  /** The reader's followed models, as their feed reads them. */
  async function feedCallsOf(userId: string): Promise<FeedCalls> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: SAVED_FEED_SELECT });
    const state = await contestState(opts.env);
    const saved = user ? toSavedFeed(user) : null;
    return resolveFeedCalls(
      state,
      saved ? resolveFeedModels(state, saved).models : [...state.defaultModels],
      false,
    );
  }

  app.addHook("preHandler", async (request, reply) => {
    const now = Date.now();
    const address = `ip:${clientIp(request)}`;
    const secret = extensionKeyFromHeader(request.headers.authorization);
    if (secret === null) return reply.code(401).send({ error: "missing_api_key" });
    if (!isExtensionKeyShape(secret)) {
      if (recentFailures(address, now).length >= EXTENSION_AUTH_FAILURES_PER_MINUTE) {
        return reply.code(429).send({ error: "too_many_attempts" });
      }
      recordFailure(address, now);
      return reply.code(401).send({ error: "invalid_api_key" });
    }

    const hash = hashExtensionKey(secret, opts.env.JWT_SECRET);
    const cached = authCache.get(hash);
    if (cached && now - cached.at < AUTH_CACHE_MS) {
      request.extensionClient = cached.client;
      return;
    }
    // An address past the failure cap is turned away before the key read, not after it, so junk
    // keys cost no DB read (audit CE-2). A key proven within AUTH_CACHE_MS (above) stays exempt;
    // an unproven one from that address waits out the minute like the junk.
    const row = await prisma.extensionKey.findUnique({
      where: { secretHash: hash },
      select: {
        id: true,
        secretHash: true,
        revokedAt: true,
        user: { select: { id: true, walletAddress: true } },
      },
    });
    const matches = extensionKeyMatches(secret, row?.secretHash ?? "0".repeat(64), opts.env.JWT_SECRET);
    // Unknown and revoked are the same answer.
    if (!row || !matches || row.revokedAt) {
      authCache.delete(hash);
      if (recentFailures(address, now).length >= EXTENSION_AUTH_FAILURES_PER_MINUTE) {
        return reply.code(429).send({ error: "too_many_attempts" });
      }
      recordFailure(address, now);
      return reply.code(401).send({ error: "invalid_api_key" });
    }
    const access = await resolveAccess(row.user.walletAddress, admins);
    if (!extensionKeyAccess(access)) {
      authCache.delete(hash);
      return reply.code(403).send({ error: extensionKeyDeniedMessage(access.reason) });
    }
    const client = {
      keyId: row.id,
      userId: row.user.id,
      walletAddress: row.user.walletAddress,
      aiReviews: access.reason === "admin",
    };
    if (!authCache.has(hash) && authCache.size >= AUTH_CACHE_MAX) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) authCache.delete(oldest);
    }
    authCache.set(hash, { at: now, client });
    request.extensionClient = client;

    if (now - (lastUsedWritten.get(row.id) ?? 0) >= LAST_USED_EVERY_MS) {
      lastUsedWritten.set(row.id, now);
      void prisma.extensionKey
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
        .catch(() => undefined);
    }
  });

  /** Who the key belongs to, shortened, and their overlay settings: the popup's first read. */
  app.get(
    "/me",
    { config: { rateLimit: { ...SETTINGS_RATE_LIMIT, keyGenerator: bucket } } },
    async (request) => {
      const { userId, walletAddress, aiReviews } = request.extensionClient!;
      const [user, pro] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { overlaySettings: true } }),
        cachedProStatus(opts.env, walletAddress).catch(() => null),
      ]);
      return {
        wallet: `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`,
        settings: parseOverlaySettings(user?.overlaySettings ?? null),
        aiReviews,
        pro: pro?.pro === true,
      };
    },
  );

  app.get(
    "/settings",
    { config: { rateLimit: { ...SETTINGS_RATE_LIMIT, keyGenerator: bucket } } },
    async (request) => {
      const user = await prisma.user.findUnique({
        where: { id: request.extensionClient!.userId },
        select: { overlaySettings: true },
      });
      return parseOverlaySettings(user?.overlaySettings ?? null);
    },
  );

  /** The whole settings object, replaced. The popup always holds all of it. */
  app.put(
    "/settings",
    { config: { rateLimit: { ...SETTINGS_RATE_LIMIT, keyGenerator: bucket } } },
    async (request, reply) => {
      const parsed = overlaySettingsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid settings" });
      await prisma.user.update({
        where: { id: request.extensionClient!.userId },
        data: { overlaySettings: parsed.data },
      });
      return parsed.data;
    },
  );

  /** The reader's latest alerts, newest first. Database only, as the lookup always was. */
  app.get(
    "/feed",
    { config: { rateLimit: { ...FEED_RATE_LIMIT, keyGenerator: bucket } } },
    async (request) => {
      const { userId, aiReviews } = request.extensionClient!;
      const now = Date.now();
      const hit = feedCache.get(userId);
      if (hit && now - hit.at < FEED_CACHE_MS) return { tokens: hit.tokens };
      const calls = await feedCallsOf(userId);
      const tokens = (await recentOverlay(userId, calls, now)).map((t) =>
        aiReviews ? t : { ...t, ai: null },
      );
      if (!feedCache.has(userId) && feedCache.size >= FEED_CACHE_MAX) {
        const oldest = feedCache.keys().next().value;
        if (oldest !== undefined) feedCache.delete(oldest);
      }
      feedCache.delete(userId);
      feedCache.set(userId, { at: now, tokens });
      return { tokens };
    },
  );

  /**
   * A coin's latest bubble map, with the site's category totals (extensionBubble.ts): the panel
   * draws it when an alert or a Trade Buddy coin is opened. The same coins the site's token view
   * opens free for this reader: one the scanner tracks, one they traded, or their open lookup.
   * Each read keeps the coin's map watched, as the site's view does, so the worker keeps its top
   * holders current while the panel shows them (one account's four newest maps, live.ts).
   */
  app.get(
    "/bubble/:mint",
    { config: { rateLimit: { ...BUBBLE_RATE_LIMIT, keyGenerator: bucket } } },
    async (request, reply) => {
      const { mint } = request.params as { mint: string };
      if (!isMintAddress(mint)) return reply.code(400).send({ error: "not a valid mint" });
      const { userId, walletAddress, aiReviews } = request.extensionClient!;
      const admin = aiReviews;
      const allowed =
        admin ||
        (await freeLookupReason(walletAddress, "token", mint)) !== null ||
        (await openLookup(walletAddress, "token", mint)) !== null;
      if (!allowed) return reply.code(404).send({ error: "not tracked" });
      const now = Date.now();
      const watch = allowHolderWatch(`ext:${userId}`, mint, now);
      if (watch.stamp) opts.holderStamps?.record([mint], now);
      void releaseHolderStamps(opts.holderStamps, watch.released);
      const hit = bubbleCache.get(mint);
      if (hit && now - hit.at < BUBBLE_CACHE_MS) return { map: hit.map };
      const map = await readOverlayBubble(mint);
      if (!bubbleCache.has(mint) && bubbleCache.size >= BUBBLE_CACHE_MAX) {
        const oldest = bubbleCache.keys().next().value;
        if (oldest !== undefined) bubbleCache.delete(oldest);
      }
      bubbleCache.delete(mint);
      bubbleCache.set(mint, { at: now, map });
      return { map };
    },
  );

  /** One Trade Buddy read: the pro status, the wallet's trades and the reader's models, side by side. */
  async function readBuddy(userId: string, walletAddress: string, aiReviews: boolean): Promise<BuddyAnswer> {
    const now = Date.now();
    const [status, view, calls] = await Promise.all([
      cachedProStatus(opts.env, walletAddress).catch(() => null),
      opts.proTrades ? opts.proTrades.look(walletAddress, "full-open") : null,
      feedCallsOf(userId),
    ]);
    const pro = status?.pro === true;
    if (!view) return { coins: [], solUsd: null, pro, readAt: new Date(now).toISOString(), chainAt: null };
    const mints = buddyCoins(view, now).map((c) => c.mint);
    const { tokens } = mints.length ? await lookupOverlay(userId, mints, calls, now) : { tokens: [] };
    return buddyAnswer(
      view,
      tokens.map((t) => (aiReviews ? t : { ...t, ai: null })),
      pro,
      now,
    );
  }

  /**
   * Trade Buddy's answer without the wait (user ask 2026-10-25): a read can take seconds (the chain
   * catch-up, trades read back from history, live prices), so once a reader has an answer, each poll
   * gets the last one at once and a fresher one is read behind it for the next. Only the first read,
   * or one after BUDDY_KEEP_MS without a poll, waits. A new trade shows one poll later than before.
   */
  async function buddyFor(userId: string, walletAddress: string, aiReviews: boolean): Promise<BuddyAnswer> {
    const key = `${userId}:${walletAddress}:${aiReviews}`;
    const now = Date.now();
    let entry = buddyAnswers.get(key);
    if (entry && !entry.reading && now - entry.at >= BUDDY_KEEP_MS) {
      buddyAnswers.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { at: 0, body: null, reading: null };
      buddyAnswers.set(key, entry);
      if (buddyAnswers.size > 5_000) buddyAnswers.delete(buddyAnswers.keys().next().value!);
    }
    const current = entry;
    if (!current.reading && now - current.at >= BUDDY_FRESH_MS) {
      current.reading = readBuddy(userId, walletAddress, aiReviews)
        .then((body) => {
          current.body = body;
          current.at = Date.now();
          return body;
        })
        .finally(() => {
          current.reading = null;
        });
      // A read behind a served answer that fails is tried again on the next poll.
      current.reading.catch(() => undefined);
    }
    return current.body ?? current.reading!;
  }

  /**
   * Trade Buddy: the coins the key's own wallet bought, from any venue, each with its PnL and token
   * card (extensionBuddy.ts). The wallet is followed while the panel reads this, as the site's
   * TRADES panel follows it, and its held coins are kept on the scan.
   */
  app.get(
    "/buddy",
    { config: { rateLimit: { ...BUDDY_RATE_LIMIT, keyGenerator: bucket } } },
    async (request): Promise<BuddyAnswer> => {
      const { userId, walletAddress, aiReviews } = request.extensionClient!;
      return buddyFor(userId, walletAddress, aiReviews);
    },
  );
}
