import {
  buildManualTrade,
  createLogger,
  DEFAULT_HELIUS_SENDER_URL,
  JupiterSwapClient,
  prisma,
  solToLamports,
  TradeRejected,
  TradingRpc,
  type Env,
} from "@trenchscanner/core";
import { JobFailure, type JobRunMeta } from "../scheduler.js";

const logger = createLogger("trade-canary");

/**
 * The trade canary (trading robustness audit 2026-10-19, #6): every 5 minutes, the Pro trade
 * path end to end short of a signature. Nothing else watched it: a build failure, a Sender outage
 * or a dead RPC only reached the logs, and the first to hear was a trader whose click failed.
 *
 * Each run builds a Pro trade with buildManualTrade - the API's own code, through the guard and
 * its simulation - for the preflight's probe wallet (never signed, never sent: the wallet is only
 * simulated against) on SOL->USDC, a liquid graduated Pump.fun coin and a coin still on its curve,
 * picked from what the scanner saw recently; pings Helius Sender; and asks the primary and the
 * backup trading RPC for a block height. A failed probe fails the run, and the run's meta counts
 * the failed runs in a row (consecutiveFailures): pipeline-watch reads it and tells the admin
 * wallets' Telegram after two, and once when it clears (findCanaryProblems), so one slow Jupiter
 * answer is not a page. The latest result is this job's row on /health/worker.
 *
 * Cheap on purpose: one run every 5 minutes, each probe cut off at PROBE_TIMEOUT_MS. A run costs
 * about thirty Helius credits (mint, curve and lookup-table reads, fee estimate, blockhash, three
 * simulations, two block heights) and six Jupiter calls. TRADE_CANARY_ENABLED=false switches it off.
 */

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/**
 * A long-lived, well-funded system wallet used only as the subject of simulations (never signs).
 * The trading preflight's default probe too (tradingPreflight.ts).
 */
export const DEFAULT_PROBE_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** How often the canary runs (and what pipeline-watch judges its silence by). */
export const TRADE_CANARY_INTERVAL_MINUTES = 5;
/** Each probe's limit: past it the probe failed, whatever it was waiting on. */
export const PROBE_TIMEOUT_MS = 20_000;
/** The buy each build probes: the smallest Pro trade the API takes (MIN_TRADE_LAMPORTS). */
const PROBE_LAMPORTS = solToLamports(0.01);
const PROBE_SLIPPAGE_BPS = 1_500;
/** Coins tried per kind: a coin can graduate or die between the scan's reading and the build. */
const CANDIDATES = 3;
/** A graduated coin this big (USD) has a pool deep enough for any probe. */
const GRADUATED_MIN_MCAP_USD = 150_000;
/** A Pump.fun coin under this (USD) is still on its curve (it graduates at about $70k-90k). */
const CURVE_MAX_MCAP_USD = 40_000;

export type ProbeKey = "sol-usdc" | "graduated" | "curve" | "sender" | "rpc" | "backup-rpc";

export interface ProbeResult {
  key: ProbeKey;
  /** Degraded: it answered, but not fully (Sender rate-limiting its ping). Not a failure. */
  status: "ok" | "degraded" | "failed" | "skipped";
  ms: number;
  /** Why it failed, was degraded or was skipped; for a build, the coin it built on. */
  detail?: string;
}

/** What a run talks to. Injected in tests; built from the env otherwise (canaryClients). */
export interface CanaryClients {
  /** buildManualTrade for the probe wallet: resolves when the build passed the guard. */
  build: (mint: string) => Promise<unknown>;
  /** "limited" when Sender answered the ping with a 429; throws when it did not answer. */
  senderPing: () => Promise<"up" | "limited">;
  blockHeight: () => Promise<number | null>;
  /** Null when TRADING_BACKUP_RPC_URL is not set: the probe is skipped. */
  backupBlockHeight: (() => Promise<number | null>) | null;
}

export interface CanaryMints {
  /** Graduated Pump.fun coins, most liquid first, then the configured fallback. */
  graduated: string[];
  /** Coins still on their curve, most recently traded first. */
  curve: string[];
}

export function canaryClients(env: Env): CanaryClients {
  // The API's own clients for Pro trades (routes/proTrade.ts), so the canary fails where a trade would.
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const jupiter = new JupiterSwapClient({
    apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined,
    backupApiKey: env.JUPITER_API_KEY || undefined,
  });
  // Without the backup, so a dead primary isn't hidden by the fallback.
  const primary = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  const backup = env.TRADING_BACKUP_RPC_URL ? new TradingRpc({ rpcUrl: env.TRADING_BACKUP_RPC_URL }) : null;
  return {
    build: (mint) =>
      buildManualTrade(
        { rpc, jupiter },
        {
          wallet: DEFAULT_PROBE_WALLET,
          mint,
          side: "buy",
          amount: PROBE_LAMPORTS,
          slippageBps: PROBE_SLIPPAGE_BPS,
          speed: "eco",
        },
      ),
    senderPing: async () => {
      // Sender's warm-up endpoint: free, no key, at the host's root.
      const url = new URL("/ping", env.HELIUS_SENDER_URL || DEFAULT_HELIUS_SENDER_URL);
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      // A 429 is Sender answering: it rate-limits the keyless ping while keyed sends still go out.
      if (res.status === 429) return "limited";
      if (!res.ok) throw new Error(`Sender /ping answered ${res.status}`);
      return "up";
    },
    blockHeight: () => primary.getBlockHeight(),
    backupBlockHeight: backup ? () => backup.getBlockHeight() : null,
  };
}

/**
 * The coins to build on, from what the scan recorded in the last hours. Both reads range over an
 * index (firstInBandAt, firstSeenAt) and keep a handful of rows. Only Pump.fun mints (…pump), not
 * the coins the screen stopped watching (Mayhem Mode).
 */
export async function pickCanaryMints(
  env: Pick<Env, "TRADE_CANARY_PUMP_MINT">,
  now: number,
): Promise<CanaryMints> {
  const MIN = 60_000;
  const [big, young] = await Promise.all([
    prisma.token.findMany({
      where: {
        firstInBandAt: { gte: new Date(now - 24 * 60 * MIN) },
        mintAddress: { endsWith: "pump" },
        ignoredAt: null,
        lastLiveAt: { gte: new Date(now - 30 * MIN) },
        lastMcapUsd: { gte: GRADUATED_MIN_MCAP_USD },
      },
      orderBy: { lastMcapUsd: "desc" },
      take: CANDIDATES,
      select: { mintAddress: true },
    }),
    prisma.token.findMany({
      where: {
        firstSeenAt: { gte: new Date(now - 3 * 60 * MIN) },
        mintAddress: { endsWith: "pump" },
        ignoredAt: null,
        lastLiveAt: { gte: new Date(now - 10 * MIN) },
        lastMcapUsd: { lt: CURVE_MAX_MCAP_USD },
      },
      orderBy: { lastLiveAt: "desc" },
      take: CANDIDATES,
      select: { mintAddress: true },
    }),
  ]);
  const graduated = big.map((t) => t.mintAddress);
  const configured = env.TRADE_CANARY_PUMP_MINT.trim();
  if (configured && !graduated.includes(configured)) graduated.push(configured);
  return { graduated: graduated.slice(0, CANDIDATES), curve: young.map((t) => t.mintAddress) };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

const errText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

async function timed(
  key: ProbeKey,
  timeoutMs: number,
  fn: () => Promise<string | undefined>,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const detail = await withTimeout(fn(), timeoutMs);
    return { key, status: "ok", ms: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (err) {
    return { key, status: "failed", ms: Date.now() - started, detail: errText(err) };
  }
}

/**
 * A build on the first coin that takes one. A TradeRejected is the coin's own answer (it
 * graduated, or died, since the scan saw it), so the next coin is tried; every coin refused is a
 * failure all the same - a curve reader that broke refuses every coin the same way.
 */
async function buildProbe(
  key: ProbeKey,
  mints: string[],
  clients: CanaryClients,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (mints.length === 0) return { key, status: "skipped", ms: 0, detail: "no coin to try" };
  const started = Date.now();
  const refusals: string[] = [];
  for (const mint of mints) {
    try {
      await withTimeout(clients.build(mint), timeoutMs);
      return { key, status: "ok", ms: Date.now() - started, detail: mint };
    } catch (err) {
      if (!(err instanceof TradeRejected))
        return {
          key,
          status: "failed",
          ms: Date.now() - started,
          detail: `${mint.slice(0, 6)}…: ${errText(err)}`,
        };
      refusals.push(`${mint.slice(0, 6)}…: ${errText(err)}`);
    }
  }
  return { key, status: "failed", ms: Date.now() - started, detail: refusals.join("; ") };
}

/** Sender's ping. A rate-limited answer is degraded, so it neither fails the run nor pages. */
async function senderProbe(clients: CanaryClients, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const answer = await withTimeout(clients.senderPing(), timeoutMs);
    if (answer === "limited")
      return {
        key: "sender",
        status: "degraded",
        ms: Date.now() - started,
        detail: "Sender /ping answered 429",
      };
    return { key: "sender", status: "ok", ms: Date.now() - started };
  } catch (err) {
    return { key: "sender", status: "failed", ms: Date.now() - started, detail: errText(err) };
  }
}

/** Every probe of one run. The builds go one after another (Jupiter's rate limit); the rest alongside. */
export async function runCanaryProbes(
  clients: CanaryClients,
  mints: CanaryMints,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  const side = Promise.all([
    senderProbe(clients, timeoutMs),
    timed("rpc", timeoutMs, async () => {
      const h = await clients.blockHeight();
      if (!h) throw new Error("no answer to getBlockHeight");
      return String(h);
    }),
    clients.backupBlockHeight
      ? timed("backup-rpc", timeoutMs, async () => {
          const h = await clients.backupBlockHeight!();
          if (!h) throw new Error("no answer to getBlockHeight");
          return String(h);
        })
      : Promise.resolve<ProbeResult>({
          key: "backup-rpc",
          status: "skipped",
          ms: 0,
          detail: "TRADING_BACKUP_RPC_URL not set",
        }),
  ]);
  const builds: ProbeResult[] = [];
  builds.push(await buildProbe("sol-usdc", [USDC_MINT], clients, timeoutMs));
  builds.push(await buildProbe("graduated", mints.graduated, clients, timeoutMs));
  builds.push(await buildProbe("curve", mints.curve, clients, timeoutMs));
  return [...builds, ...(await side)];
}

/** The failed runs in a row before this one, from this job's own heartbeat. */
async function previousFailures(): Promise<number> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job: "trade-canary" } });
  const meta = (row?.meta ?? null) as Record<string, unknown> | null;
  const n = meta?.consecutiveFailures;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * The newest count known, for the scheduler's failureMeta: a run given up at its deadline records
 * no meta of its own, and a lost count would restart the "two in a row" from zero.
 */
let lastKnownFailures = 0;
export function canaryFailureMeta(): JobRunMeta {
  return { consecutiveFailures: lastKnownFailures + 1 };
}

export interface TradeCanaryDeps {
  clients?: CanaryClients;
  mints?: CanaryMints;
  now?: number;
  timeoutMs?: number;
}

export async function runTradeCanary(env: Env, deps: TradeCanaryDeps = {}): Promise<JobRunMeta> {
  const now = deps.now ?? Date.now();
  const before = await previousFailures();
  lastKnownFailures = before;
  let probes: ProbeResult[];
  try {
    const mints = deps.mints ?? (await pickCanaryMints(env, now));
    probes = await runCanaryProbes(deps.clients ?? canaryClients(env), mints, deps.timeoutMs);
  } catch (err) {
    // The coin read (the database) failed: a failed run like any other, so the count goes on.
    throw new JobFailure(`trade canary: ${errText(err)}`, { consecutiveFailures: before + 1 });
  }
  const failed = probes.filter((p) => p.status === "failed");
  const consecutiveFailures = failed.length > 0 ? before + 1 : 0;
  lastKnownFailures = consecutiveFailures;
  const built = (key: ProbeKey) => {
    const p = probes.find((x) => x.key === key);
    return p?.status === "ok" ? (p.detail ?? null) : null;
  };
  const meta: JobRunMeta = {
    consecutiveFailures,
    failed: failed.length,
    probes: Object.fromEntries(probes.map((p) => [p.key, p.status])),
    probeMs: Object.fromEntries(probes.map((p) => [p.key, p.ms])),
    graduatedMint: built("graduated"),
    curveMint: built("curve"),
  };
  // Degraded probes pass the run (no page) but are logged, and show as "degraded" in meta.probes.
  const degraded = probes.filter((p) => p.status === "degraded");
  if (degraded.length > 0)
    logger.warn("trade canary degraded", {
      degraded: degraded.map((p) => `${p.key}: ${p.detail ?? "degraded"}`).join("; "),
    });
  if (failed.length > 0) {
    const text = failed.map((p) => `${p.key}: ${p.detail ?? "failed"}`).join("; ");
    logger.warn("trade canary failed", { consecutiveFailures, failed: text });
    throw new JobFailure(`trade canary: ${text}`, meta);
  }
  return meta;
}
