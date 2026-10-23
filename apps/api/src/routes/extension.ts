import type { FastifyInstance, FastifyRequest } from "fastify";
import { adminWalletSet, prisma, resolveAccess, resolveFeedCalls, type Env } from "@trenchscanner/core";
import { clientIp, ipRateLimitKey } from "../clientIp.js";
import { contestState, resolveFeedModels, SAVED_FEED_SELECT, toSavedFeed } from "../contest.js";
import {
  extensionKeyDeniedMessage,
  extensionKeyFromHeader,
  extensionKeyMatches,
  extensionRateLimitBucket,
  hashExtensionKey,
  isExtensionKeyShape,
} from "../extensionKey.js";
import { recentOverlay } from "../extensionLookup.js";
import { modelAlertKeyAccess } from "../modelAlertKey.js";
import { overlaySettingsSchema, parseOverlaySettings } from "../overlaySettings.js";

/**
 * The browser extension's API (/ext/v1). The extension is a side panel with no access to any
 * trading site, so nothing here takes addresses from a page: it lists the reader's own alerts. Every route takes an extension key as
 * `Authorization: Bearer tsx_...` and nothing else: no cookie is read here, which is why
 * server.ts lets these routes through its Origin check (an extension's requests carry a
 * chrome-extension:// origin, and a page elsewhere cannot make a browser attach this header).
 *
 * The key reads the owner's alerts, token stats and overlay settings, and saves the overlay
 * settings. Paid access only, the Model Alert rule (user decision 2026-10-23).
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

/** Feed reads a key may make a minute: an open panel polls every 15 s, plus refreshes. */
const FEED_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
const SETTINGS_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

export interface ExtensionClient {
  keyId: string;
  userId: string;
  walletAddress: string;
}

interface CachedAuth {
  at: number;
  client: ExtensionClient;
}

const authCache = new Map<string, CachedAuth>();
const authFailures = new Map<string, number[]>();
const lastUsedWritten = new Map<string, number>();

/** Drops a key's cached check, so a revoke on this process takes effect on the next request. */
export function forgetExtensionKey(keyId: string): void {
  for (const [hash, entry] of authCache) if (entry.client.keyId === keyId) authCache.delete(hash);
}

export function resetExtensionAuthState(): void {
  authCache.clear();
  authFailures.clear();
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

export async function registerExtensionRoutes(app: FastifyInstance, opts: { env: Env }) {
  const admins = adminWalletSet(opts.env);
  const bucket = (request: FastifyRequest) =>
    extensionRateLimitBucket(request.headers.authorization, ipRateLimitKey(request));

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
    // A real key is never refused for its address's failures: the cap only answers wrong ones.
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
    if (!modelAlertKeyAccess(access)) {
      authCache.delete(hash);
      return reply.code(403).send({ error: extensionKeyDeniedMessage(access.reason) });
    }
    const client = { keyId: row.id, userId: row.user.id, walletAddress: row.user.walletAddress };
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
      const { userId, walletAddress } = request.extensionClient!;
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { overlaySettings: true } });
      return {
        wallet: `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`,
        settings: parseOverlaySettings(user?.overlaySettings ?? null),
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
      const { userId } = request.extensionClient!;
      const user = await prisma.user.findUnique({ where: { id: userId }, select: SAVED_FEED_SELECT });
      const state = await contestState(opts.env);
      const saved = user ? toSavedFeed(user) : null;
      const calls = resolveFeedCalls(
        state,
        saved ? resolveFeedModels(state, saved).models : [...state.defaultModels],
        false,
      );
      return { tokens: await recentOverlay(userId, calls) };
    },
  );
}
