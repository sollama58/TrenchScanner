import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { createLogger } from "./logger.js";

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
 * Not counted: the PumpPortal websocket (one long-lived socket, not per-call) and the database.
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
/** Helius's REST APIs (api.helius.xyz/v0: Enhanced Transactions and the like) bill 100 a request. */
const HELIUS_REST_CREDITS = 100;
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
 * a single "METHOD /path" line. Credits are only known for Helius and CoinGecko's paid API.
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
    const byMethod = new Map<string, number>();
    for (const m of methods) byMethod.set(m, (byMethod.get(m) ?? 0) + 1);
    return [...byMethod].map(([method, calls]) => ({
      provider,
      endpoint: method,
      calls,
      credits: provider === "helius" ? calls * heliusCredits(method) : 0,
    }));
  }
  const endpoint = `${httpMethod} ${normalizePath(parsed.pathname)}`;
  const credits =
    provider === "helius"
      ? HELIUS_REST_CREDITS
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
  return featureStore.run({ feature: name, pending: null }, fn);
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
  const ctx: FeatureContext = { feature, pending: [] };
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
    c.credits += line.credits;
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
    const startedAt = Date.now();
    try {
      const res = await inner(input, init);
      if (lines) {
        apiUsageMeter.record(lines, {
          requests: 1,
          ok: res.ok,
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

let installed: { processName: string; timer: NodeJS.Timeout } | null = null;

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
  installed = { processName: opts.processName, timer };
  return () => stopApiUsageMeter();
}

async function stopApiUsageMeter(): Promise<void> {
  if (!installed) return;
  clearInterval(installed.timer);
  const { processName } = installed;
  installed = null;
  await flushApiUsage(processName).catch((err: unknown) =>
    logger.warn("api usage flush at shutdown failed", { error: String(err) }),
  );
}
