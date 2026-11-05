import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createLogger, type Env } from "@trenchscanner/core";

const logger = createLogger("stats-access");

/** A token shorter than this switches the endpoint off rather than guarding it weakly. */
export const STATS_TOKEN_MIN_LENGTH = 32;

/**
 * Who a /stats bearer belongs to (security review 2026-11-05, before the first outside user):
 * - the operator (STATS_API_TOKEN): scripts and cloud sessions, which read everything under /stats
 *   including /stats/ops - worker errors, the AI reviewer, FDSA, KOL wallets, the wallet and tape
 *   exports. Never handed to anyone outside;
 * - a partner (an STATS_PARTNER_TOKENS entry): an outside user, who reads PARTNER_READS only and
 *   sets its own alert webhook (routes/statsWebhook.ts). Everything else answers it 404, as if
 *   the route didn't exist.
 */
export type StatsCaller = { kind: "operator" } | { kind: "partner"; name: string };

/**
 * What a partner may read: the results (hit rates, the model board), prices (minute candles,
 * trimmed to the bars) and the calls themselves (the alerts and paths exports). Not the outcomes
 * export (every model input on every row: the training data), not ai-reviews, shadow, screen,
 * narratives, wallets, wallet-activity, tape, top-models or the send logs, and nothing operational.
 */
export const PARTNER_READS = [
  "/stats/hit-rates",
  "/stats/models",
  "/stats/candles/:mint",
  "/stats/export",
] as const;
export const PARTNER_EXPORT_DATASETS: readonly string[] = ["alerts", "paths"];

const PARTNER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The bearer value of an Authorization header, or null. */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Constant-time: both sides are hashed first, so neither length nor content leaks by timing. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const value = bearerOf(header);
  if (value === null || !token) return false;
  return timingSafeEqual(digest(value), digest(token));
}

/**
 * STATS_PARTNER_TOKENS as name -> token. Entries are "name:token", separated by commas or new
 * lines. A malformed entry, a short token, a duplicate name or token, or one equal to the operator
 * token is skipped with a warning that names the entry, never the token.
 */
export function parsePartnerTokens(raw: string, operatorToken: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const entries = raw
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const [i, entry] of entries.entries()) {
    const at = entry.indexOf(":");
    const name = at > 0 ? entry.slice(0, at).trim() : "";
    const token = at > 0 ? entry.slice(at + 1).trim() : "";
    const label = PARTNER_NAME.test(name) ? `"${name}"` : `#${i + 1}`;
    let problem: string | null = null;
    if (!PARTNER_NAME.test(name)) problem = "needs a name (letters, digits, - and _) before a colon";
    else if (token.length < STATS_TOKEN_MIN_LENGTH)
      problem = `token is shorter than ${STATS_TOKEN_MIN_LENGTH} characters`;
    else if (token === operatorToken) problem = "token is the operator's STATS_API_TOKEN";
    else if (out.has(name)) problem = "name is listed twice";
    else if (seen.has(token)) problem = "token is listed twice";
    if (problem) {
      logger.warn(`STATS_PARTNER_TOKENS entry ${label} skipped: ${problem}`);
      continue;
    }
    out.set(name, token);
    seen.add(token);
  }
  return out;
}

export interface StatsAuth {
  /** Whether anyone at all may call (else every /stats route is a 404). */
  enabled: boolean;
  operatorEnabled: boolean;
  partners: ReadonlyMap<string, string>;
  identify(header: string | undefined): StatsCaller | null;
}

const authCache = new WeakMap<Env, StatsAuth>();

/** The callers an env admits. Memoised per env object, so the warnings above log once. */
export function statsAuth(env: Env): StatsAuth {
  const cached = authCache.get(env);
  if (cached) return cached;
  const operator = env.STATS_API_TOKEN;
  const operatorEnabled = operator.length >= STATS_TOKEN_MIN_LENGTH;
  const partners = parsePartnerTokens(env.STATS_PARTNER_TOKENS, operator);
  const auth: StatsAuth = {
    enabled: operatorEnabled || partners.size > 0,
    operatorEnabled,
    partners,
    identify(header) {
      const value = bearerOf(header);
      if (value === null) return null;
      const got = digest(value);
      // Every candidate is compared, so the time taken says nothing about which one matched.
      let caller: StatsCaller | null = null;
      if (operatorEnabled && timingSafeEqual(got, digest(operator))) caller = { kind: "operator" };
      for (const [name, token] of partners) {
        if (timingSafeEqual(got, digest(token)) && caller === null) caller = { kind: "partner", name };
      }
      return caller;
    },
  };
  authCache.set(env, auth);
  return auth;
}

declare module "fastify" {
  interface FastifyRequest {
    statsCaller?: StatsCaller;
  }
}

/**
 * A /stats preHandler. Off (no token configured) is a 404; a wrong or missing bearer a 401; a
 * partner on a route it may not read a 404, the same answer as a route that doesn't exist.
 * The caller is left on request.statsCaller for routes that answer partners differently.
 */
export function statsGuard(env: Env, opts: { partner: boolean }) {
  const auth = statsAuth(env);
  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    if (!auth.enabled) return reply.code(404).send({ error: "not_found" });
    const caller = auth.identify(request.headers.authorization);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    if (caller.kind === "partner" && !opts.partner) return reply.code(404).send({ error: "not_found" });
    request.statsCaller = caller;
  };
}
