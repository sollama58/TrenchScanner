import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { createLogger } from "./logger.js";
import { coinGeckoBudget } from "./datasources/coingeckoBudget.js";

const logger = createLogger("api-usage");

/**
 * Every outside API call this process makes, counted for the admin panel's API usage section:
 * per provider, per endpoint (the JSON-RPC method for an RPC host), and per feature (the
 * scheduled job, and the scan's stage), in 5-minute buckets. Counted at the one place every call
 * passes through, globalThis.fetch, so a call added anywhere later is counted without anyone
 * remembering to: fetchJson, the Anthropic SDK and the few bare fetch() calls all end there.
 *
 * Each process keeps its counts in memory and adds them into ApiUsage every FLUSH_MS, so the panel
 * trails live traffic by up to that long; the API, the scanner and the trainer add into the same
 * rows. Helius bills per RPC call, not per HTTP request (a batch of 80 is 80 calls), so "calls"
 * is the billable unit and "requests" the HTTP count; credits use HELIUS_CREDITS below.
 *
 * Helius websockets count themselves (HeliusAccountStream.metered: endpoint "websocket", credits
 * from the bytes received). Not counted: the PumpPortal websocket and the database.
 */

const BUCKET_MS = 5 * 60_000;
const FLUSH_MS = 60_000;
/** Rows older than this are deleted by the flusher, about once an hour. */
const RETENTION_MS = 8 * 86_400_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** Distinct endpoints kept per provider per flush; the rest are pooled as OTHER_ENDPOINT. */
const MAX_ENDPOINTS_PER_PROVIDER = 60;
const OTHER_ENDPOINT = "(other)";
/** Path segments at least this long are ids (mints, wallets, bot tokens), not route names. */
const LONG_SEGMENT = 24;

/**
 * Helius credits per call (helius.dev/docs/billing/credits, checked 2026-10-13). Standard RPC
 * methods cost DEFAULT_RPC_CREDITS; DAS and the heavier reads cost more. getTransactionsForAddress
 * is 10 a call (a page of up to 100 transactions), which is every way this code calls it.
 */
export const HELIUS_CREDITS: Record<string, number> = {
  getTransactionsForAddress: 10,
  getProgramAccounts: 10,
  // The paged version is a standard 1-credit call, a page at a time (the top-25 holder read).
  getProgramAccountsV2: 1,
  getAsset: 10,
  getAssetBatch: 10,
  getAssetsByOwner: 10,
  getAssetsByGroup: 10,
  getAssetsByCreator: 10,
  getAssetsByAuthority: 10,
  searchAssets: 10,
  getAssetProof: 10,
  getSignaturesForAsset: 10,
  getTokenAccounts: 10,
  getValidityProof: 100,
};
const DEFAULT_RPC_CREDITS = 1;
/**
 * Helius's REST APIs bill 100 a request: api.helius.xyz/v0 (Enhanced Transactions and the like)
 * and the v1 Wallet API (identity and batch-identity, one request for up to 100 wallets).
 */
const HELIUS_REST_CREDITS = 100;
/**
 * Helius's identity lookup answers 404 for a wallet nobody has named, its usual answer. That is a
 * lookup done, not a failed call, so it is billed and not an error (inferred: Helius's credits page
 * bills every Wallet API request and names no exception). Counted as an error it read as 0 credits,
 * hiding most of the identity spend from the API usage panel.
 */
const HELIUS_IDENTITY_ENDPOINT = /^GET \/v1\/wallet\/:id\/identity$/;

/**
 * RugCheck's report for a mint it hasn't indexed: a 400 {"error":"not found"} (a 404 before
 * 2026-10-07). The client reads both as "no report yet" and caches it (rugcheck.ts), so they are
 * answers, not failures; counted as errors they buried the real failures in the panel.
 */
const RUGCHECK_REPORT_ENDPOINT = /^GET \/v1\/tokens\/:id\/report$/;

/** Whether a response counts as answered (billed, not an error) for `lines`. */
export function answeredStatus(lines: readonly ApiCallLine[], status: number): boolean {
  if (status >= 200 && status < 300) return true;
  if (lines.length !== 1) return false;
  const { provider, endpoint } = lines[0]!;
  if (provider === "helius") return status === 404 && HELIUS_IDENTITY_ENDPOINT.test(endpoint);
  if (provider === "rugcheck")
    return (status === 400 || status === 404) && RUGCHECK_REPORT_ENDPOINT.test(endpoint);
  // CoinGecko's paid on-chain API bills a pool it doesn't know (404) like any answer, and the day's
  // budget (coingeckoBudget.ts) is read back from the credits counted here: uncounted, a run of
  // unknown pools spent the plan unseen (API audit 2026-10-23).
  if (provider === "coingecko") return status === 404 && lines[0]!.credits > 0;
  return false;
}
/**
 * Jupiter's credits per call on a paid plan (developers.jup.ag/docs/portal/plans, checked
 * 2026-10-15), by route; any other route costs 1. The free plan has no credit cap, but the count
 * still shows what a paid plan would bill.
 */
export const JUPITER_CREDITS: Record<string, number> = {
  "/tokens/v2/search": 10,
  "/tokens/v2/tag": 50,
  "/tokens/v2/recent": 1,
  "/price/v3": 1,
};
const DEFAULT_JUPITER_CREDITS = 1;
/** Swap execution is free on every plan. */
const JUPITER_FREE_ROUTE = /\/execute$/;

export function jupiterCredits(pathname: string): number {
  if (JUPITER_FREE_ROUTE.test(pathname)) return 0;
  const exact = JUPITER_CREDITS[pathname.replace(/\/+$/, "")];
  if (exact !== undefined) return exact;
  // The token category lists (/tokens/v2/{category}/{interval}) cost 5.
  if (/^\/tokens\/v2\/[^/]+\/[^/]+$/.test(pathname)) return 5;
  return DEFAULT_JUPITER_CREDITS;
}

/** CoinGecko's paid API bills one credit a call; the free GeckoTerminal API has no credits. */
const COINGECKO_PRO_CREDITS = 1;

/** Host suffix to provider name. The first match wins, so specific hosts go first. */
const PROVIDERS: [suffix: string, provider: string][] = [
  ["helius-rpc.com", "helius"],
  ["helius.xyz", "helius"],
  ["api.dexscreener.com", "dexscreener"],
  ["api.geckoterminal.com", "geckoterminal"],
  ["pro-api.coingecko.com", "coingecko"],
  ["api.coingecko.com", "coingecko"],
  ["jup.ag", "jupiter"],
  ["pump.fun", "pumpfun"],
  ["rugcheck.xyz", "rugcheck"],
  ["solanatracker.io", "solanatracker"],
  ["api.telegram.org", "telegram"],
  ["api.anthropic.com", "anthropic"],
  ["solana-rpc.publicnode.com", "solana-public-rpc"],
  ["api.mainnet-beta.solana.com", "solana-public-rpc"],
];

/** Extra host to provider names from the environment (TokenSage's own host, a custom RPC). */
const extraHosts = new Map<string, string>();

/** Names `host` (a URL or bare host) as `provider` in this process's counts. */
export function nameApiHost(hostOrUrl: string, provider: string): void {
  let host = hostOrUrl.trim().toLowerCase();
  if (!host) return;
  try {
    if (host.includes("/")) host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return;
  }
  extraHosts.set(host, provider);
}

export function providerOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const named = extraHosts.get(h);
  if (named) return named;
  for (const [suffix, provider] of PROVIDERS) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return provider;
  }
  return h || "unknown";
}

/** A path with its ids taken out, so one route is one row: /coins/<mint> -> /coins/:id. */
export function normalizePath(pathname: string): string {
  const parts = pathname.split("/").map((seg) => {
    if (seg === "") return seg;
    if (seg.length >= LONG_SEGMENT || /^\d+$/.test(seg) || seg.includes(",") || seg.includes(":")) {
      return ":id";
    }
    return seg;
  });
  const path = parts.join("/") || "/";
  return path.length > 120 ? `${path.slice(0, 117)}...` : path;
}

/** The JSON-RPC methods in a request body, in order: one per call, so a batch counts each. */
export function rpcMethods(body: unknown): string[] | null {
  if (typeof body !== "string" || !body.includes('"jsonrpc"')) return null;
  const out: string[] = [];
  for (const m of body.matchAll(/"method"\s*:\s*"([A-Za-z0-9_]{1,64})"/g)) out.push(m[1]!);
  return out.length > 0 ? out : null;
}

export function heliusCredits(method: string): number {
  return HELIUS_CREDITS[method] ?? DEFAULT_RPC_CREDITS;
}

export interface ApiCallLine {
  provider: string;
  endpoint: string;
  calls: number;
  credits: number;
}

/**
 * What one HTTP request is, for the counts: one line per JSON-RPC method in it (an RPC host), or
 * a single "METHOD /path" line. Credits are only known for Helius, Jupiter and CoinGecko's paid API.
 */
export function classifyApiRequest(url: string, httpMethod: string, body: unknown): ApiCallLine[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ provider: "unknown", endpoint: `${httpMethod} ?`, calls: 1, credits: 0 }];
  }
  const provider = providerOf(parsed.hostname);
  const methods = rpcMethods(body);
  if (methods) {
    // Helius Sender (sender.helius-rpc.com, regional ones like ewr-sender.helius-rpc.com) bills no
    // credits: the trade panel's resends every 2 s read as ~38 credits a trade (audit 2026-10-19).
    const billed = provider === "helius" && !/(^|[.-])sender\.helius-rpc\.com$/.test(parsed.hostname);
    const byMethod = new Map<string, number>();
    for (const m of methods) byMethod.set(m, (byMethod.get(m) ?? 0) + 1);
    return [...byMethod].map(([method, calls]) => ({
      provider,
      endpoint: method,
      calls,
      credits: billed ? calls * heliusCredits(method) : 0,
    }));
  }
  // Jupiter's keyless host (lite-api.jup.ag) has its own per-IP limit and bills nothing: named
  // apart, so the panel shows which host a 429 came from, and charged no credits.
  const keylessJupiter = provider === "jupiter" && parsed.hostname === "lite-api.jup.ag";
  const endpoint = `${httpMethod} ${normalizePath(parsed.pathname)}${keylessJupiter ? " (keyless)" : ""}`;
  const credits =
    provider === "helius"
      ? HELIUS_REST_CREDITS
      : provider === "jupiter"
        ? keylessJupiter
          ? 0
          : jupiterCredits(parsed.pathname)
        : parsed.hostname === "pro-api.coingecko.com"
          ? COINGECKO_PRO_CREDITS
          : 0;
  return [{ provider, endpoint, calls: 1, credits }];
}

// ---------- feature context ----------

interface FeatureContext {
  feature: string;
  /** Lines counted since the stage last closed, labelled with the stage when it does. */
  pending: Pending[] | null;
  /** Where the Helius credits of calls made here are also added up (tallyHeliusCredits). */
  tallies?: readonly CreditTally[];
}
interface Pending {
  at: number;
  line: ApiCallLine;
  outcome: Outcome;
}
interface Outcome {
  requests: number;
  ok: boolean;
  rateLimited: boolean;
  ms: number;
}

const featureStore = new AsyncLocalStorage<FeatureContext>();
let defaultFeature = "unattributed";

/**
 * Runs `fn` with every outside call inside it (awaited or not) counted under `feature` - the
 * scheduler wraps each job's run in its own name. Nested, the names join: "scan/wallets".
 */
export function withApiFeature<T>(feature: string, fn: () => T): T {
  const parent = featureStore.getStore();
  const name = parent ? `${parent.feature}/${feature}` : feature;
  return featureStore.run({ feature: name, pending: null, tallies: parent?.tallies }, fn);
}

/**
 * Runs `fn` with its outside calls counted under `feature` alone, whatever started it. For a
 * timer a request starts (the API's live-curve and live-trades loops, the wallet-name queue): it
 * outlives that request and serves every viewer, and under withApiFeature its reads were filed
 * under whichever route happened to start it (Helius audit 2026-10-22, H-8).
 */
export function withOwnApiFeature<T>(feature: string, fn: () => T): T {
  return featureStore.run({ feature, pending: null }, fn);
}

/** Helius credits added up by tallyHeliusCredits, read and reset by take(). */
export class CreditTally {
  private credits = 0;

  add(credits: number): void {
    this.credits += credits;
  }

  /** The credits since the last take. */
  take(): number {
    const out = this.credits;
    this.credits = 0;
    return out;
  }
}

/**
 * Runs `fn` with the Helius credits of every call inside it (awaited or not) also added to
 * `tally`, as the meter bills them (answered calls only). Counted under the same feature as
 * without it. For a stage's own credits on a job's heartbeat, where the scan's stages run side by
 * side and its per-method call counts can't tell them apart.
 */
export function tallyHeliusCredits<T>(tally: CreditTally, fn: () => T): T {
  const parent = featureStore.getStore();
  if (!parent) return featureStore.run({ feature: defaultFeature, pending: null, tallies: [tally] }, fn);
  // The parent's own fields stay its own (a stage's held lines, which withApiStages swaps out).
  const ctx = Object.create(parent, {
    tallies: { value: [...(parent.tallies ?? []), tally] },
  }) as FeatureContext;
  return featureStore.run(ctx, fn);
}

/**
 * Like withApiFeature, for a job that marks its stages as it finishes each (the scan's lap()):
 * calls are held until `stage(name)` names what they were for, then counted as "feature/name".
 * Anything after the last stage, or still running when the run ends, counts as plain `feature`.
 */
export async function withApiStages<T>(
  feature: string,
  fn: (stage: (name: string) => void) => Promise<T>,
): Promise<T> {
  const ctx: FeatureContext = { feature, pending: [], tallies: featureStore.getStore()?.tallies };
  const release = (label: string) => {
    const held = ctx.pending ?? [];
    ctx.pending = [];
    for (const p of held) apiUsageMeter.add(p.at, label, p.line, p.outcome);
  };
  const stage = (name: string) => release(`${feature}/${name}`);
  try {
    return await featureStore.run(ctx, () => fn(stage));
  } finally {
    release(feature);
    ctx.pending = null;
  }
}

/** The feature a call made here would be counted under. */
export function currentApiFeature(): string {
  return featureStore.getStore()?.feature ?? defaultFeature;
}

// ---------- the meter ----------

interface Counter {
  calls: number;
  requests: number;
  errors: number;
  rateLimited: number;
  credits: number;
  msTotal: number;
}

const key = (bucket: number, provider: string, endpoint: string, feature: string) =>
  JSON.stringify([bucket, provider, endpoint, feature]);

export class ApiUsageMeter {
  private rows = new Map<string, Counter>();

  /** Counts one HTTP request's lines (the request, its latency, on the first line only). */
  record(lines: ApiCallLine[], outcome: Outcome, at = Date.now()): void {
    const ctx = featureStore.getStore();
    if (ctx?.tallies && outcome.ok) {
      for (const line of lines) {
        if (line.provider !== "helius") continue;
        for (const tally of ctx.tallies) tally.add(line.credits);
      }
    }
    lines.forEach((line, i) => {
      const o = i === 0 ? outcome : { ...outcome, requests: 0, ms: 0 };
      if (ctx?.pending) ctx.pending.push({ at, line, outcome: o });
      else this.add(at, ctx?.feature ?? defaultFeature, line, o);
    });
  }

  add(at: number, feature: string, line: ApiCallLine, o: Outcome): void {
    const k = key(Math.floor(at / BUCKET_MS) * BUCKET_MS, line.provider, line.endpoint, feature);
    const c = this.rows.get(k) ?? {
      calls: 0,
      requests: 0,
      errors: 0,
      rateLimited: 0,
      credits: 0,
      msTotal: 0,
    };
    c.calls += line.calls;
    c.requests += o.requests;
    c.errors += o.ok ? 0 : line.calls;
    c.rateLimited += o.rateLimited ? line.calls : 0;
    // Only answered calls are billed: an error or a 429 charged its credits too, so the cost panel
    // over-read during exactly the incidents it should explain (audit 2026-10-14, L6-9). The
    // calls, errors and rate-limited columns still count every attempt.
    c.credits += o.ok ? line.credits : 0;
    c.msTotal += Math.round(o.ms);
    this.rows.set(k, c);
  }

  take(): { bucket: Date; provider: string; endpoint: string; feature: string; counter: Counter }[] {
    const rows = this.rows;
    this.rows = new Map();
    const out = [...rows].map(([k, counter]) => {
      const [bucket, provider, endpoint, feature] = JSON.parse(k) as [number, string, string, string];
      return { bucket: new Date(bucket), provider, endpoint, feature, counter };
    });
    // A provider answering at many distinct paths (a host nothing names) is pooled past the cap.
    const seen = new Map<string, Set<string>>();
    for (const r of out) {
      const set = seen.get(r.provider) ?? new Set<string>();
      if (!set.has(r.endpoint) && set.size >= MAX_ENDPOINTS_PER_PROVIDER) r.endpoint = OTHER_ENDPOINT;
      else set.add(r.endpoint);
      seen.set(r.provider, set);
    }
    return out;
  }

  putBack(rows: ReturnType<ApiUsageMeter["take"]>): void {
    for (const r of rows) {
      const k = key(r.bucket.getTime(), r.provider, r.endpoint, r.feature);
      const mine = this.rows.get(k);
      if (!mine) {
        this.rows.set(k, { ...r.counter });
        continue;
      }
      for (const f of Object.keys(mine) as (keyof Counter)[]) mine[f] += r.counter[f];
    }
  }

  get size(): number {
    return this.rows.size;
  }
}

export const apiUsageMeter = new ApiUsageMeter();

/** The URL, HTTP method and body of whatever fetch() was handed. */
function requestParts(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (typeof input === "string") return { url: input, method: init?.method ?? "GET", body: init?.body };
  if (input instanceof URL) return { url: input.toString(), method: init?.method ?? "GET", body: init?.body };
  return { url: input.url, method: init?.method ?? input.method ?? "GET", body: init?.body };
}

/**
 * How long every billed Helius call stands down once Helius says the plan's credits are used up
 * (a "max usage reached" answer; a plain 429 is a rate limit and passes). Without it every stage kept
 * firing every 30 s into the same refusal and the scan still reported success. After the pause
 * calls go through again: answered, Helius is back; refused, the pause starts over.
 *
 * Shared between processes through one SystemHeartbeat row (HELIUS_CREDITS_OUT_ROW), read every
 * SHARED_POLL_MS once the meter is installed: the API, the scanner and the trainer each found out
 * on their own, and a restart (pipeline-watch's own among them) forgot it and bought its first
 * reads again (audit 2026-10-22, H2).
 */
export const HELIUS_CREDITS_OUT_PAUSE_MS = 15 * 60_000;
const heliusOut = {
  since: 0,
  until: 0,
  /** When this process last set or adopted the stand-down; a clear older than this doesn't end it. */
  setAt: 0,
  /** The newest clear any process made (clearHeliusCreditsOut), as the shared row carries it. */
  clearedAt: 0,
  /** Set until the stand-down is over and its onHeliusCreditsRestored hooks have run. */
  pending: false,
};
const restoredHooks: (() => void)[] = [];

/** When this process last heard Helius's credits were out and until when it stands down; null if not now. */
export function heliusCreditsOut(now = Date.now()): { since: Date; until: Date } | null {
  return now < heliusOut.until
    ? { since: new Date(heliusOut.since), until: new Date(heliusOut.until) }
    : null;
}

/**
 * Runs `fn` once each time a stand-down ends: Helius answered a billed call again after the pause,
 * or someone cleared it. For the state a stand-down leaves behind that should not outlive it (the
 * worker's per-mint failure backoffs).
 */
export function onHeliusCreditsRestored(fn: () => void): void {
  restoredHooks.push(fn);
}

function releaseCreditsOut(): void {
  if (!heliusOut.pending) return;
  heliusOut.pending = false;
  logger.info("Helius credits back; stand-down over");
  for (const fn of restoredHooks) {
    try {
      fn();
    } catch (err) {
      logger.warn("credits-restored hook failed", { error: String(err) });
    }
  }
}

/**
 * Ends a stand-down (a test, or an admin who topped up the plan), in every process sharing it. Its
 * end stays readable through heliusCreditsOut(earlier) for the watchers' grace; `now` 0 forgets it
 * outright (tests).
 */
export function clearHeliusCreditsOut(now = Date.now()): void {
  heliusOut.until = Math.min(heliusOut.until, now);
  heliusOut.clearedAt = now;
  releaseCreditsOut();
  if (installed) void publishCreditsOut();
}

function latchCreditsOut(now: number) {
  if (now >= heliusOut.until) {
    if (heliusOut.until === 0 || now - heliusOut.until > HELIUS_CREDITS_OUT_PAUSE_MS) heliusOut.since = now;
    logger.error("Helius credits used up; standing down Helius calls", {
      minutes: HELIUS_CREDITS_OUT_PAUSE_MS / 60_000,
    });
  }
  heliusOut.until = now + HELIUS_CREDITS_OUT_PAUSE_MS;
  heliusOut.setAt = now;
  heliusOut.pending = true;
  if (installed) void publishCreditsOut();
}

/**
 * How long after Helius last answered a billed call with a 429 its failures still count as the
 * provider's own refusal rather than a key's (heliusRefusing).
 */
export const HELIUS_REFUSING_MS = 60_000;
let heliusLast429At = 0;

/**
 * Whether Helius is refusing calls across the board: credits out, or a 429 within the last
 * HELIUS_REFUSING_MS. A per-key backoff (the worker's FailureBackoff) should not count a failure
 * then as that key's: every key fails alike, and the strikes outlived the outage by up to 20
 * minutes (audit 2026-10-22, H1 and worker-core F1).
 */
export function heliusRefusing(now = Date.now()): boolean {
  return heliusCreditsOut(now) !== null || now - heliusLast429At < HELIUS_REFUSING_MS;
}

/** The SystemHeartbeat row the stand-down is shared through. Not a job: listings leave it out. */
export const HELIUS_CREDITS_OUT_ROW = "helius-credits-out";
/** How often a process reads the shared stand-down: the "about 30 s" a late process may still call. */
const SHARED_POLL_MS = 30_000;

interface SharedCreditsOut {
  since: number;
  until: number;
  setAt: number;
  clearedAt: number;
}

async function publishCreditsOut(): Promise<boolean> {
  const { since, until, setAt, clearedAt } = heliusOut;
  const meta: SharedCreditsOut = { since, until, setAt, clearedAt };
  const at = new Date(Math.max(setAt, clearedAt) || Date.now());
  try {
    await prisma.systemHeartbeat.upsert({
      where: { job: HELIUS_CREDITS_OUT_ROW },
      create: { job: HELIUS_CREDITS_OUT_ROW, lastRunAt: at, meta: { ...meta } },
      update: { lastRunAt: at, meta: { ...meta } },
    });
    return true;
  } catch (err) {
    logger.warn("shared Helius stand-down not written", { error: String(err) });
    return false;
  }
}

/**
 * An admin's "Helius topped up": ends the stand-down here and, through the shared row, in every
 * other process within SHARED_POLL_MS, rather than leaving each to sit out up to 15 minutes of a
 * plan that has credits again (audit 2026-10-22, helius-usage H-6). Whether the row was written.
 */
export async function endHeliusCreditsOutEverywhere(now = Date.now()): Promise<boolean> {
  heliusOut.until = Math.min(heliusOut.until, now);
  heliusOut.clearedAt = now;
  releaseCreditsOut();
  return publishCreditsOut();
}

/** The shared row's stand-down, or null without one (or one that doesn't read). */
export async function readSharedCreditsOut(): Promise<SharedCreditsOut | null> {
  const row = await prisma.systemHeartbeat.findUnique({
    where: { job: HELIUS_CREDITS_OUT_ROW },
    select: { meta: true },
  });
  const m = row?.meta as Record<string, unknown> | null | undefined;
  const n = (k: string) => (m && typeof m[k] === "number" ? (m[k] as number) : 0);
  return m ? { since: n("since"), until: n("until"), setAt: n("setAt"), clearedAt: n("clearedAt") } : null;
}

/**
 * Takes on what the other processes know: a stand-down set elsewhere that outlasts this process's,
 * or a clear made after this process last set its own. Exported for tests; the meter runs it every
 * SHARED_POLL_MS and once at start, so a restarted process keeps standing down.
 */
export async function syncHeliusCreditsOut(now = Date.now()): Promise<void> {
  const shared = await readSharedCreditsOut();
  if (!shared) return;
  if (shared.clearedAt > heliusOut.clearedAt) {
    heliusOut.clearedAt = shared.clearedAt;
    if (shared.clearedAt >= heliusOut.setAt && now < heliusOut.until) {
      heliusOut.until = Math.min(heliusOut.until, shared.clearedAt);
      releaseCreditsOut();
    }
  }
  if (shared.until > heliusOut.until && shared.until > now && shared.setAt > heliusOut.clearedAt) {
    if (now >= heliusOut.until) {
      heliusOut.since = shared.since;
      logger.error("Helius credits used up (heard from another process); standing down Helius calls");
    }
    heliusOut.until = shared.until;
    heliusOut.setAt = shared.setAt;
    heliusOut.pending = true;
  }
}

/**
 * Whether a billed Helius answer says the plan's credits are used up. Helius sends it as an HTTP
 * 429 "max usage reached", but also with HTTP 200 as a JSON-RPC error (code -32429), and inside a
 * batch as one error per call (rpc.ts's isNotNowRpcError reads it that way): any of those counts.
 * A -32429 that says "rate limited" is the per-second limit, not the plan, and does not.
 */
export function saysCreditsOut(text: string): boolean {
  if (/max usage reached/i.test(text)) return true;
  for (const m of text.matchAll(/"error"\s*:\s*\{([^{}]*)/g)) {
    const inner = m[1]!;
    const code = Number(/"code"\s*:\s*(-?\d+)/.exec(inner)?.[1]);
    const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inner)?.[1] ?? "";
    if (/max usage|credits/i.test(message)) return true;
    if (code === -32429 && !/rate limit|too many/i.test(message)) return true;
  }
  return false;
}

/**
 * How much of an answered (2xx) body is read for saysCreditsOut. An out-of-credits answer is a few
 * hundred bytes, and a batch of them repeats the error from its first item, so this is enough
 * without reading a large page twice.
 */
const ANSWERED_BODY_PEEK_BYTES = 4096;

/** The start of a copy of `res`'s body, up to `max` bytes (all of it when max is Infinity). */
async function bodyText(res: Response, max = Infinity): Promise<string> {
  try {
    const copy = res.clone();
    if (max === Infinity || !copy.body) return await copy.text();
    const reader = copy.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < max) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).subarray(0, max).toString("utf8");
  } catch {
    return "";
  }
}

/** When a 429 body that didn't read as credits out was last logged: once a day is enough to check by. */
let unmatched429LoggedAt = 0;

/** Whether a billed Helius response says credits are out: a 429's body, or a JSON 2xx's first bytes. */
async function responseSaysCreditsOut(res: Response): Promise<boolean> {
  if (res.status === 429) {
    const text = await bodyText(res);
    const out = saysCreditsOut(text);
    // The matcher has only seen the documented shapes: a day's first other 429 is kept to check it by.
    if (!out && Date.now() - unmatched429LoggedAt > 86_400_000) {
      unmatched429LoggedAt = Date.now();
      logger.warn("Helius 429 not read as credits out", { body: text.slice(0, 300) });
    }
    return out;
  }
  if (res.ok && /json/i.test(res.headers.get("content-type") ?? "")) {
    return saysCreditsOut(await bodyText(res, ANSWERED_BODY_PEEK_BYTES));
  }
  return false;
}

/** What a billed Helius call gets while standing down: the same 429 Helius would send, unsent. */
function standingDown(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32429, message: "max usage reached (standing down)" },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

/** The fetch() wrapper: counts the request, then hands it on untouched. */
export function meteredFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    // Counting never gets in a request's way: anything it can't read goes uncounted.
    let lines: ApiCallLine[] | null;
    try {
      const { url, method, body } = requestParts(input, init);
      lines = classifyApiRequest(url, method.toUpperCase(), body);
    } catch {
      lines = null;
    }
    const billedHelius = !!lines?.some((l) => l.provider === "helius" && l.credits > 0);
    const startedAt = Date.now();
    if (billedHelius && startedAt < heliusOut.until) return standingDown();
    try {
      const res = await inner(input, init);
      if (billedHelius && res.status === 429) heliusLast429At = Date.now();
      const creditsOut = billedHelius && (await responseSaysCreditsOut(res));
      if (creditsOut) latchCreditsOut(Date.now());
      // Answered after a stand-down's pause: Helius is back, and what the stand-down left behind goes.
      else if (billedHelius && res.ok && heliusOut.pending && Date.now() >= heliusOut.until)
        releaseCreditsOut();
      if (lines) {
        apiUsageMeter.record(lines, {
          requests: 1,
          // A 200 carrying the out-of-credits error answered nothing and was not billed.
          ok: !creditsOut && answeredStatus(lines, res.status),
          rateLimited: res.status === 429,
          ms: Date.now() - startedAt,
        });
      }
      return res;
    } catch (err) {
      if (lines) {
        apiUsageMeter.record(lines, {
          requests: 1,
          ok: false,
          rateLimited: false,
          ms: Date.now() - startedAt,
        });
      }
      throw err;
    }
  };
}

/** Adds the counted calls into ApiUsage. On a database error they are kept for the next flush. */
export async function flushApiUsage(processName: string): Promise<number> {
  const rows = apiUsageMeter.take();
  if (rows.length === 0) return 0;
  let done = 0;
  try {
    while (done < rows.length) {
      const chunk = rows.slice(done, done + FLUSH_CHUNK);
      await insertRows(processName, chunk);
      done += chunk.length;
    }
    return rows.length;
  } catch (err) {
    // Only what didn't land: a chunk already written would otherwise be counted twice.
    apiUsageMeter.putBack(rows.slice(done));
    throw err;
  }
}

/** Rows per INSERT: 11 parameters each, well under Postgres's 32767-parameter limit. */
const FLUSH_CHUNK = 1000;

async function insertRows(processName: string, rows: ReturnType<ApiUsageMeter["take"]>): Promise<void> {
  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.bucket}, ${processName}, ${r.provider}, ${r.endpoint}, ${r.feature}, ${r.counter.calls}, ${r.counter.requests}, ${r.counter.errors}, ${r.counter.rateLimited}, ${r.counter.credits}, ${r.counter.msTotal})`,
  );
  await prisma.$executeRaw`
      INSERT INTO "ApiUsage" ("bucket", "process", "provider", "endpoint", "feature", "calls", "requests", "errors", "rateLimited", "credits", "msTotal")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("bucket", "process", "provider", "endpoint", "feature") DO UPDATE SET
        "calls" = "ApiUsage"."calls" + EXCLUDED."calls",
        "requests" = "ApiUsage"."requests" + EXCLUDED."requests",
        "errors" = "ApiUsage"."errors" + EXCLUDED."errors",
        "rateLimited" = "ApiUsage"."rateLimited" + EXCLUDED."rateLimited",
        "credits" = "ApiUsage"."credits" + EXCLUDED."credits",
        "msTotal" = "ApiUsage"."msTotal" + EXCLUDED."msTotal"`;
}

let installed: { processName: string; timer: NodeJS.Timeout; sharedTimer: NodeJS.Timeout } | null = null;

/**
 * Starts counting this process's outside calls: wraps globalThis.fetch and flushes every FLUSH_MS.
 * Call once, before anything builds an HTTP client. `feature` names calls made outside any job
 * (the API's request handlers, startup). Returns a stop() that flushes what is left, for shutdown.
 */
export function installApiUsageMeter(opts: { processName: string; feature?: string }): () => Promise<void> {
  if (installed) return () => stopApiUsageMeter();
  defaultFeature = opts.feature ?? opts.processName;
  globalThis.fetch = meteredFetch(globalThis.fetch.bind(globalThis));
  let lastPrune = 0;
  const timer = setInterval(() => {
    void (async () => {
      try {
        await flushApiUsage(opts.processName);
        // Right after this process's own counts land: the day's CoinGecko spend across processes.
        await coinGeckoBudget.sync();
        if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = Date.now();
          await prisma.$executeRaw`DELETE FROM "ApiUsage" WHERE "bucket" < ${new Date(Date.now() - RETENTION_MS)}`;
        }
      } catch (err) {
        logger.warn("api usage flush failed", { error: String(err), held: apiUsageMeter.size });
      }
    })();
  }, FLUSH_MS);
  timer.unref?.();
  const sync = () =>
    void syncHeliusCreditsOut().catch((err: unknown) =>
      logger.warn("shared Helius stand-down not read", { error: String(err) }),
    );
  const sharedTimer = setInterval(sync, SHARED_POLL_MS);
  sharedTimer.unref?.();
  installed = { processName: opts.processName, timer, sharedTimer };
  sync();
  return () => stopApiUsageMeter();
}

async function stopApiUsageMeter(): Promise<void> {
  if (!installed) return;
  clearInterval(installed.timer);
  clearInterval(installed.sharedTimer);
  const { processName } = installed;
  installed = null;
  await flushApiUsage(processName).catch((err: unknown) =>
    logger.warn("api usage flush at shutdown failed", { error: String(err) }),
  );
}
