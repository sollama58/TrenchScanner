import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bs58 from "bs58";
import { z } from "zod";
import {
  buildManualTrade,
  estimateManualFees,
  estimateSwapCosts,
  estimateSaleProceeds,
  estimateBuyLamports,
  burnCreditPrices,
  rawPerCredit,
  SUBSCRIPTION_MINT_DECIMALS,
  type SwapCosts,
  decodeMessage,
  isSenderTipAccount,
  JupiterSwapClient,
  looksLikeSolanaAddress,
  parseWireTransaction,
  pingSender,
  senderUrl,
  sendViaSender,
  signedMatchesBuild,
  TradeRejected,
  TradingRpc,
  TransientError,
  GuardRefusal,
  NoRouteError,
  RateLimitedError,
  verifyTransactionSignatures,
  walletTokenTrades,
  SUBSCRIPTION_MINT,
  type DecodedMessage,
  type Env,
  type PlatformTradeRecord,
  type WalletTrade,
  walletTag,
  prisma,
  recordPlatformTrade,
  sacrificeSettings,
  settlePlatformTrade,
  tradeOutcome,
} from "@trenchscanner/core";
import { cachedProStatus, type ProStatus } from "../proMode.js";
import { requireTwoFactor } from "../twoFactor.js";
import { accessSwapOpen as accessSwapOpenFor } from "./auth.js";
import { sharedSolPrice } from "../solPrice.js";
import { feeSummary } from "../tradeFees.js";
import { countProTrade } from "../proTradeCounters.js";
import { quoteSacrifice, sacrificeRefusal, sacrificeView, type SacrificeQuote } from "../sacrificeQuote.js";
import { newBuildId, signBuildToken, verifyBuildToken } from "../buildToken.js";
import { SenderHealth } from "../senderHealth.js";

/**
 * Pro trades from the token modal (user decision 2026-10-17), for Pro Mode wallets only
 * (proMode.ts): everyone else gets a 404 here, as if none of it existed.
 *
 *   POST /pro/trade/build            a swap for the signed-in wallet to sign (manualTrade.ts)
 *   POST /pro/trade/send             relays the signed swap to Helius Sender, and keeps resending
 *                                    it until it lands or its blockhash expires (through the RPC
 *                                    too, with MEV Protect off, once Sender stops answering)
 *   GET  /pro/trade/status/:sig      whether it landed
 *   GET  /pro/trade/:mint/position   the wallet's balance and trades in the coin, for the chart
 *   GET  /pro/trade/fees             what the wallet's trades here cost in fees, against other
 *                                    platforms' fees (tradeFees.ts), for the Portfolio page
 *
 * Non-custodial: the API never sees a key. It builds bytes the guard has simulated, the wallet
 * signs them in the browser, and /send relays only a transaction the session's own wallet signed
 * and that tips Sender - so it can't be used to push anyone else's traffic on our Helius key.
 */

/** A trade made from our Trade panel, as the position sends it; null for one made anywhere else. */
function panelTrade(row: { lamports: bigint; platformFeeLamports: bigint } | undefined) {
  return row
    ? { lamports: row.lamports.toString(), platformFeeLamports: row.platformFeeLamports.toString() }
    : null;
}

/** Whether the Sacrifice is actually taken on this quote: "on", a fee payer, and priced. */
const charged = (q: SacrificeQuote) => q.mode === "on" && !!q.tier?.pays && q.lamports !== null;

/** The Sacrifice as the send records it (and as a build token carries it). */
const sacrificeRecord = (q: SacrificeQuote): PlatformTradeRecord["sacrifice"] => ({
  mode: q.mode,
  tier: q.tier?.reason ?? null,
  pays: q.tier?.pays ?? false,
  asdfRaw: q.asdfRaw,
  lamports: q.lamports,
  asdfPerSol: q.asdfPerSol,
});

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

const buildSchema = z.object({
  mint: z.string().refine(looksLikeSolanaAddress, "not a token address"),
  side: z.enum(["buy", "sell"]),
  /** Buy: lamports. Sell: raw token units. Decimal strings (u64s never go through a float). */
  amount: z
    .string()
    .regex(/^\d{1,20}$/)
    .refine((v) => BigInt(v) <= 18_446_744_073_709_551_615n, "amount too large"),
  slippageBps: z.number().int().min(10).max(5_000),
  speed: z.enum(["eco", "turbo"]),
  /** A sale of the whole balance, read fresh here (the panel's copy can be seconds old). */
  all: z.boolean().optional(),
  /**
   * A sell preset's percent of the balance, read fresh here. The panel's figure can be seconds
   * old; 100 is the whole balance (closing), the same as `all`.
   */
  percent: z.number().int().min(1).max(100).optional(),
  /** The trader's own priority fee and Sender tip, lamports; left out, the going rate and the minimum. */
  priorityFeeLamports: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
  tipLamports: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
});

/**
 * Buying $ASDFASDFA here pays no Sacrifice, for every wallet, Pro Mode or not (user ask
 * 2026-10-19: the site's "Get $ASDFASDFA" buy is fee-free for all). Selling it is a normal trade.
 */
export function freeAsdfBuy(side: "buy" | "sell", mint: string): boolean {
  return side === "buy" && mint === SUBSCRIPTION_MINT;
}

const feeSchema = z.object({
  mint: z.string().refine(looksLikeSolanaAddress, "not a token address"),
  /** The side the panel is sizing; a $ASDFASDFA buy pays no Sacrifice. Left out: a buy. */
  side: z.enum(["buy", "sell"]).optional(),
  speed: z.enum(["eco", "turbo"]),
  /** The trade's SOL value the Sacrifice is quoted on, lamports. */
  lamports: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  priorityFeeLamports: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
  tipLamports: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
});

const costsSchema = z.object({
  mint: z.string().refine(looksLikeSolanaAddress, "not a token address"),
  /** The buy the swap costs are quoted on, lamports (the amount the panel's buy is set to). */
  refLamports: z
    .string()
    .regex(/^\d{1,12}$/)
    .optional(),
});

const saleQuoteSchema = z.object({
  mint: z.string().refine(looksLikeSolanaAddress, "not a token address"),
  /** The coins the sale would sell, raw units (the amount the panel's sell is set to). */
  units: z.string().regex(/^[1-9]\d{0,19}$/, "not an amount"),
});

const sendSchema = z.object({
  transaction: z.string().min(1).max(2_000),
  speed: z.enum(["eco", "turbo"]),
  mevProtect: z.boolean(),
  /**
   * The build's token (buildToken.ts), which /build returned: good on any instance. Left out (a
   * panel loaded before 2026-10-19), only a build in this instance's memory can be sent.
   */
  buildToken: z.string().min(1).max(8_000).optional(),
});

/**
 * Trade limits (user ask 2026-10-18): no trade under 0.01 SOL (a buy's spend, a sale's quoted
 * proceeds), and one trade sent per second per wallet. A sale of the whole balance closes a
 * position and is exempt from both: nobody is ever stuck holding dust or waiting to get out.
 */
export const MIN_TRADE_LAMPORTS = 10_000_000n;
export const TRADE_COOLDOWN_MS = 1_000;

/** "every second", or "every N seconds" for any other window. */
function tradePacePhrase(ms: number): string {
  return ms === 1_000 ? "every second" : `every ${ms / 1_000} seconds`;
}

/**
 * When each wallet last sent a trade, for TRADE_COOLDOWN_MS. This map only sees this process.
 * recordPlatformTrade's pace check is what holds the same limit across API instances.
 */
export class TradeCooldown {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly ms = TRADE_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Ms until the wallet may send another trade; 0 when it may now. */
  left(wallet: string): number {
    const at = this.last.get(wallet);
    return at === undefined ? 0 : Math.max(0, at + this.ms - this.now());
  }

  /**
   * Starts the wallet's cooldown now, before the send, so two sends racing each other can't both
   * pass; the function returned gives it back (the send didn't go out).
   */
  take(wallet: string): () => void {
    const before = this.last.get(wallet);
    const at = this.now();
    if (this.last.size > 5_000) for (const [w, t] of this.last) if (at - t > this.ms) this.last.delete(w);
    this.last.set(wallet, at);
    return () => {
      if (this.last.get(wallet) !== at) return;
      if (before === undefined) this.last.delete(wallet);
      else this.last.set(wallet, before);
    };
  }
}

/** One person clicking: generous for a scalper, tight for anything scripted. */
const BUILD_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };
const SEND_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };
const READ_RATE_LIMIT = { max: 120, timeWindow: "1 minute" };

/** How often an unconfirmed trade is resent to Sender, and for how long at most. */
const RESEND_EVERY_MS = 2_000;
const RESEND_FOR_MS = 75_000;
/**
 * In-flight trades kept for resending at once, across everyone, and for one wallet. The resend
 * loop reads their statuses in one batched call and sends RESEND_BATCH at a time, so the global
 * cap is only a memory backstop.
 */
const MAX_IN_FLIGHT = 5_000;
const MAX_IN_FLIGHT_PER_WALLET = 5;
const RESEND_BATCH = 50;
/**
 * Sender sends of one trade with no answer (a timeout, a 5xx, a dropped connection) before its
 * resends also go through the RPC and its backup (user decision 2026-10-19): only for a trade with
 * MEV Protect off, since the RPC path skips Sender's protection.
 */
const RPC_FALLBACK_AFTER = 2;
/**
 * A build is good for one send within this long (a blockhash lives about a minute): /send relays
 * only a transaction on a blockhash this route handed that wallet, so our Helius key carries
 * nothing it didn't build, and the expiry it answers by is the build's own, not the caller's.
 */
const BUILD_TTL_MS = 120_000;
const MAX_BUILDS_PER_WALLET = 10;
/** A position read is reused for this long (the panel polls; a trade invalidates it). */
const POSITION_TTL_MS = 4_000;
const SUPPLY_TTL_MS = 10 * 60_000;
/** Blocks past the blockhash's last valid height before "expired": RPC nodes lag each other. */
const EXPIRY_MARGIN_BLOCKS = 10;
/** How long a trade no longer resent stays answerable as expired. */
const RETIRED_KEEP_MS = 5 * 60_000;
/** Parsed transactions kept (they never change), across every wallet and coin. */
const MAX_CACHED_TRADES = 20_000;
/** Swap costs (a Jupiter quote each) are reused this long: the panel re-reads its fee every 20s. */
const SWAP_COSTS_TTL_MS = 60_000;
/** The "Get $ASDFASDFA" quick picks, in burn credits (user ask 2026-10-19). */
export const CREDIT_PICKS = [10, 50, 100, 250, 500, 1000] as const;
/** One pick: its credits, the $ASDFASDFA they burn (raw units) and about the SOL that buys them. */
interface CreditPick {
  credits: number;
  units: string;
  /** Null without a route. */
  lamports: string | null;
}
const MAX_CACHED_SWAP_COSTS = 2_000;
/** The reference buy when the panel names none: 0.1 SOL. */
const DEFAULT_REF_LAMPORTS = 100_000_000n;
const MAX_REF_LAMPORTS = 100_000_000_000n;
/** The network's base fee on a one-signature trade, lamports. */
const BASE_FEE_LAMPORTS = 5_000n;
/** The fees read settles trades still "sent" this old, this many per read (expiry: tradeOutcome in core). */
const FEES_SETTLE_AFTER_MS = 60_000;
const FEES_SETTLE_PER_READ = 20;
/** At boot, trades still "sent" this recently are resent again (the blockhash decides the rest). */
const RESUME_WINDOW_MS = 3 * 60_000;
/**
 * On shutdown, how long in-flight trades are still resent before the process lets them go: a
 * deploy's SIGTERM no longer stops a trade after its first send. Under the api's
 * SHUTDOWN_DEADLINE_MS (index.ts), which is under render.yaml's maxShutdownDelaySeconds.
 */
export const DRAIN_MAX_MS = 75_000;
const DRAIN_POLL_MS = 500;

interface InFlight {
  base64: string;
  url: string;
  lastValidBlockHeight: number;
  until: number;
  wallet: string;
  /** MEV Protect is off, so its resends may also go through the RPC once Sender stops answering. */
  rpcFallback: boolean;
  /** Its Sender sends in a row with no answer; any answer, a refusal included, resets it. */
  silent: number;
}

export async function registerProTradeRoutes(app: FastifyInstance, opts: { env: Env }) {
  const { env } = opts;
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  // Keyless, Jupiter limits by IP, and the api's IP is shared with other services on its host: the
  // scan's key is the fallback when this one (or none) is rate limited.
  const jupiter = new JupiterSwapClient({
    apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined,
    backupApiKey: env.JUPITER_API_KEY || undefined,
  });
  // The panel's previews (swap costs, sale quotes) on their own client, keyless first: a busy
  // minute of previews mustn't spend the keys' budget a sale needs. The keys stay its fallback.
  const previewJupiter = new JupiterSwapClient({
    apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined,
    backupApiKey: env.JUPITER_API_KEY || undefined,
    keylessFirst: true,
  });
  const solPrice = sharedSolPrice;
  const tradeCache = new Map<string, WalletTrade | null>();
  const positions = new Map<string, { at: number; body: unknown }>();
  const supplies = new Map<string, { at: number; raw: bigint; decimals: number }>();
  const swapCosts = new Map<string, { at: number; costs: SwapCosts | null }>();
  /** The swap costs for a wallet's buy of `ref` lamports of `mint`, cached; null when they can't be read. */
  const swapCostsFor = async (wallet: string, mint: string, ref: bigint): Promise<SwapCosts | null> => {
    const key = `${wallet}:${mint}:${ref}`;
    const hit = swapCosts.get(key);
    if (hit && Date.now() - hit.at < SWAP_COSTS_TTL_MS) return hit.costs;
    const costs = await estimateSwapCosts(
      { rpc, jupiter: previewJupiter },
      { wallet, mint, referenceLamports: ref },
    ).catch(() => null);
    if (swapCosts.size >= MAX_CACHED_SWAP_COSTS) swapCosts.delete(swapCosts.keys().next().value!);
    swapCosts.set(key, { at: Date.now(), costs });
    return costs;
  };
  const saleQuotes = new Map<string, { at: number; lamports: bigint | null }>();
  /** The SOL a sale of `units` of `mint` would get, cached like the swap costs; null without a route. */
  const saleQuoteFor = async (mint: string, units: bigint): Promise<bigint | null> => {
    const key = `${mint}:${units}`;
    const hit = saleQuotes.get(key);
    if (hit && Date.now() - hit.at < SWAP_COSTS_TTL_MS) return hit.lamports;
    const lamports = await estimateSaleProceeds({ jupiter: previewJupiter }, { mint, units }).catch(
      () => null,
    );
    if (saleQuotes.size >= MAX_CACHED_SWAP_COSTS) saleQuotes.delete(saleQuotes.keys().next().value!);
    saleQuotes.set(key, { at: Date.now(), lamports });
    return lamports;
  };
  /**
   * The "Get $ASDFASDFA" credit picks (user ask 2026-10-19): each pick's SOL, quoted to land at
   * least that many burn credits of $ASDFASDFA at the current price. Shared by every wallet (the
   * coin is fixed) and cached like the swap costs, so an open picker costs a handful of quotes a minute.
   */
  let creditPicks: { at: number; tokensPerCredit: number; picks: Promise<CreditPick[]> } | null = null;
  const creditPicksFor = async (): Promise<{ tokensPerCredit: number; picks: CreditPick[] }> => {
    const { tokensPerCredit } = await burnCreditPrices();
    if (
      !creditPicks ||
      creditPicks.tokensPerCredit !== tokensPerCredit ||
      Date.now() - creditPicks.at >= SWAP_COSTS_TTL_MS
    ) {
      const perCredit = rawPerCredit(tokensPerCredit);
      // One after another, each starting from the last one's price, so most take two quotes.
      const picks = (async () => {
        const out: CreditPick[] = [];
        let guess = DEFAULT_REF_LAMPORTS;
        let guessCredits = 0;
        for (const credits of CREDIT_PICKS) {
          const units = perCredit * BigInt(credits);
          const start = guessCredits > 0 ? (guess * BigInt(credits)) / BigInt(guessCredits) : guess;
          const lamports = await estimateBuyLamports(
            { jupiter: previewJupiter },
            { mint: SUBSCRIPTION_MINT, units, guessLamports: start },
          );
          if (lamports !== null) {
            guess = lamports;
            guessCredits = credits;
          }
          out.push({ credits, units: units.toString(), lamports: lamports?.toString() ?? null });
        }
        return out;
      })();
      creditPicks = { at: Date.now(), tokensPerCredit, picks };
      // A failed read isn't kept.
      picks.catch(() => (creditPicks = null));
    }
    return { tokensPerCredit, picks: await creditPicks.picks };
  };
  const inFlight = new Map<string, InFlight>();
  /**
   * A signature this process already saw fail on chain (a slippage miss, most often). Kept so a
   * later status read that misses the recent cache can't call that landing expired or still pending:
   * the trader would retry a trade that already landed, or think a landed one was still open.
   */
  const failures = new Map<string, { reason: "slippage" | "rejected"; error: string; at: number }>();
  const rememberFailure = (signature: string, error: string) => {
    const now = Date.now();
    if (failures.size > 2_000)
      for (const [s, f] of failures)
        if (now - f.at > RETIRED_KEEP_MS || failures.size > 2_000) failures.delete(s);
    const failure = { ...landedFailure(error), at: now };
    failures.set(signature, failure);
    return { reason: failure.reason, error: failure.error };
  };
  /** Signatures a /send is recording and sending right now (not yet in `inFlight`). */
  const sending = new Set<string>();
  const senderHealth = new SenderHealth();
  // Trades the resend loop has stopped resending, kept a while so their status can still say
  // "expired" rather than pending forever.
  const retired = new Map<string, { lastValidBlockHeight: number; at: number }>();
  const positionReads = new Map<string, Promise<unknown>>();

  function retire(signature: string, f: InFlight) {
    inFlight.delete(signature);
    const now = Date.now();
    if (retired.size > 2_000)
      for (const [s, r] of retired)
        if (now - r.at > RETIRED_KEEP_MS || retired.size > 2_000) retired.delete(s);
    retired.set(signature, { lastValidBlockHeight: f.lastValidBlockHeight, at: now });
  }

  /** Bumped per wallet when it trades: a read begun before then keeps its answer out of the cache. */
  const positionEpochs = new Map<string, number>();

  /**
   * Drops one wallet's cached positions (it just traded); everyone else's stay. A read still in
   * flight was begun before the trade, so it is let go too: the next request reads afresh instead
   * of joining it, and its answer isn't cached (the pre-trade balance would come back for a while).
   */
  function forgetPositions(wallet: string) {
    for (const key of positions.keys()) if (key.startsWith(`${wallet}:`)) positions.delete(key);
    for (const key of positionReads.keys()) if (key.startsWith(`${wallet}:`)) positionReads.delete(key);
    if (positionEpochs.size > 10_000) positionEpochs.clear();
    positionEpochs.set(wallet, (positionEpochs.get(wallet) ?? 0) + 1);
  }
  // Build tokens (buildToken.ts) are signed with a key derived from JWT_SECRET for that use alone.
  const tokenSecret = env.JWT_SECRET;
  /** The Sender endpoint for a tier, with the API key: rebuilt from the row on any instance. */
  const senderFor = (speed: "eco" | "turbo", mevProtect: boolean) =>
    senderUrl(env.HELIUS_SENDER_URL, { speed, mevProtect, apiKey: env.HELIUS_API_KEY || undefined });
  // Kept for panels loaded before build tokens (one deploy's worth): their send finds its build
  // here, on the instance that built it. A token makes a send good on any instance.
  const builds = new Map<
    string,
    {
      /** The build's id, as its token carries it (PlatformTrade.buildId). */
      id: string;
      blockhash: string;
      lastValidBlockHeight: number;
      at: number;
      side: "buy" | "sell";
      /** An access-token buy by a wallet without Pro Mode: sends without Pro Mode too. */
      access: boolean;
      /** A sale of the whole balance: exempt from the trade limits. */
      closing: boolean;
      /** The built message: what the wallet sends must be it (signedMatchesBuild). */
      message: DecodedMessage;
      /** For the fees record (PlatformTrade): the coin, the SOL value and the network's fees. */
      mint: string;
      lamports: bigint;
      networkFeeLamports: bigint;
      /** The Sacrifice worked out at build (sacrificeQuote.ts): what the send takes or records. */
      sacrifice: SacrificeQuote;
    }[]
  >();

  const cooldown = new TradeCooldown();
  function tooSoon(reply: FastifyReply, leftMs: number) {
    const seconds = Math.max(1, Math.ceil(leftMs / 1_000));
    return reply.code(429).send({
      error: `One trade ${tradePacePhrase(TRADE_COOLDOWN_MS)}: try again in ${seconds}s. Nothing was sent.`,
      retryAfterMs: leftMs,
      notSent: true,
    });
  }
  const tooSmall = (side: "buy" | "sell") =>
    side === "buy"
      ? "The smallest buy is 0.01 SOL."
      : "That sale is worth under 0.01 SOL, the smallest trade. Sell 100% to close the position.";

  /** The wallet's builds still good for a send, oldest first. */
  function liveBuilds(wallet: string) {
    const now = Date.now();
    const list = (builds.get(wallet) ?? []).filter((b) => now - b.at < BUILD_TTL_MS);
    if (list.length > 0) builds.set(wallet, list);
    else builds.delete(wallet);
    return list;
  }

  /**
   * The session's wallet, when it has Pro Mode. Without it (even one that had it once): answers
   * 404 and returns null.
   */
  /**
   * The signed-in wallet and whether it has Pro Mode. Pro Mode or nothing: a wallet without it
   * can't sell either (user decision 2026-10-18). The one carve-out, `access`: routes that also
   * serve the access-token buy (anyone signed in may swap SOL for $ASDFASDFA here to burn for
   * access, Privy accounts above all), open while trading is on. It buys only; the read routes
   * (fee, costs, position) let it through for that one coin, so the Trade panel can show them.
   */
  async function proWallet(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { access?: boolean } = {},
  ): Promise<{ wallet: string; pro: boolean; source: ProStatus["source"] } | null> {
    const wallet = request.user!.walletAddress;
    const status = await cachedProStatus(env, wallet);
    if (!status.pro && !(opts.access && accessSwapOpen())) {
      reply.code(404).send({ error: "not found", notSent: true });
      return null;
    }
    return { wallet, pro: status.pro, source: status.source };
  }
  /** The wallet's $ASDFASDFA now, for the Sacrifice's free-tier check; null when unreadable. */
  const asdfBalance = (wallet: string) => () =>
    rpc
      .getTokenBalance(wallet, SUBSCRIPTION_MINT)
      .then((b) => b?.raw ?? null)
      .catch(() => null);
  /** The Sacrifice on a trade worth `lamports` by this wallet (sacrificeQuote.ts). */
  const sacrificeOn = (
    who: { wallet: string; pro: boolean; source: ProStatus["source"] },
    lamports: bigint,
    access: boolean,
  ) =>
    quoteSacrifice({
      wallet: who.wallet,
      source: who.source,
      access,
      lamports,
      liveBalance: asdfBalance(who.wallet),
    });
  // The kill switch (PRO_TRADING_ENABLED) stops the access buy too.
  const accessSwapOpen = () => accessSwapOpenFor(env);
  /** A read about the access token itself, which the access buy's Trade panel needs. */
  const accessMint = (query: unknown) => (query as { mint?: unknown } | null)?.mint === SUBSCRIPTION_MINT;

  app.addHook("preHandler", app.authenticate);

  app.post("/trade/build", { config: { rateLimit: BUILD_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: true });
    if (!who) return;
    const { wallet } = who;
    // Without Pro Mode, only the access-token buy: $ASDFASDFA, buys only, any size (the 5 SOL cap
    // was lifted by the user on 2026-10-18). Anything
    // else gets the same 404 as before, malformed or not, so the route still looks absent.
    const asked = (request.body ?? {}) as { side?: unknown; mint?: unknown };
    const accessBuy = asked.side === "buy" && asked.mint === SUBSCRIPTION_MINT && accessSwapOpen();
    if (!who.pro && !accessBuy) return reply.code(404).send({ error: "not found", notSent: true });
    const parsed = buildSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const body = parsed.data;
    if (body.percent !== undefined && body.side !== "sell")
      return reply.code(400).send({ error: "A percent is for a sale." });
    // A percent is taken off the balance read below, not the panel's copy. 100% closes, as `all` does.
    const closing =
      body.side === "sell" && (body.percent !== undefined ? body.percent >= 100 : body.all === true);
    if (!closing) {
      const left = cooldown.left(wallet);
      if (left > 0) return tooSoon(reply, left);
      if (body.side === "buy" && BigInt(body.amount) < MIN_TRADE_LAMPORTS)
        return reply.code(422).send({ error: tooSmall("buy") });
    }
    // The account's own two-factor choices: every buy, buys over a size, or sales.
    if (
      !(await requireTwoFactor(env, request, reply, request.user!.userId, body.side, {
        lamports: body.side === "buy" ? BigInt(body.amount) : undefined,
      }))
    )
      return;
    try {
      let amount = BigInt(body.amount);
      // The balance a percent (or a 100% sale) was taken from, returned so the page can check the
      // build sells that share and not some other amount.
      let inputBalance: string | undefined;
      if (body.side === "sell" && (body.all || body.percent !== undefined)) {
        const balance = await rpc.getTokenBalance(wallet, body.mint);
        if (!balance) throw new TransientError("couldn't read the balance");
        if (balance.raw === 0n) return reply.code(422).send({ error: "You don't hold any of this coin." });
        inputBalance = balance.raw.toString();
        amount = body.percent !== undefined ? sellShare(balance.raw, body.percent) : balance.raw;
        if (amount <= 0n)
          return reply.code(422).send({ error: "That share of your balance is too small to sell." });
      }
      // A buy the wallet plainly can't pay for, said plainly: a new wallet starts with no SOL, and
      // some nodes won't simulate a transaction whose payer doesn't exist yet. Unread is no verdict.
      if (body.side === "buy") {
        const lamports = await rpc.getBalance(wallet);
        if (lamports === 0n)
          return reply.code(422).send({ error: "Your wallet has no SOL yet. Add some SOL to it, then buy." });
        if (lamports !== null && lamports < amount)
          return reply.code(422).send({
            error: `Your wallet has ${solAmount(lamports)} SOL, less than this buy. Buy less, or add SOL first.`,
          });
      }
      const build = () =>
        buildManualTrade(
          { rpc, jupiter },
          {
            wallet,
            mint: body.mint,
            side: body.side,
            amount,
            slippageBps: body.slippageBps,
            speed: body.speed,
            ...(body.priorityFeeLamports !== undefined
              ? { priorityFeeLamports: BigInt(body.priorityFeeLamports) }
              : {}),
            ...(body.tipLamports !== undefined ? { tipLamports: BigInt(body.tipLamports) } : {}),
          },
        );
      // More goes after a pause when the chain or Jupiter didn't answer: most such misses are a
      // moment's rate limit, and tapping again shouldn't be the trader's job.
      const built = await (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await build();
          } catch (err) {
            const wait = BUILD_RETRY_MS[attempt];
            if (!(err instanceof TransientError || err instanceof RateLimitedError) || wait === undefined)
              throw err;
            request.log.warn(
              { wallet: walletTag(wallet), mint: body.mint, attempt, error: String(err) },
              "pro trade build retried",
            );
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      })();
      countProTrade("buildOk");
      // A partial sale is measured by what the route quotes for it, in lamports.
      if (!closing && body.side === "sell" && BigInt(built.quotedOut) < MIN_TRADE_LAMPORTS)
        return reply.code(422).send({ error: tooSmall("sell") });
      const tradeLamports = body.side === "buy" ? amount : BigInt(built.quotedOut);
      // The Sacrifice (ASDF fee plan): worked out here and kept on the build, so the send takes
      // exactly this number. In "on" mode a fee payer short of burned credits is refused with
      // the credits to top up, and an unusable ASDF price refuses rather than guesses.
      const sacrifice = await sacrificeOn(who, tradeLamports, freeAsdfBuy(body.side, body.mint));
      const refused = sacrificeRefusal(sacrifice);
      if (refused) return reply.code(refused.code).send(refused.body);
      const builtWire = parseWireTransaction(Buffer.from(built.transaction, "base64"));
      const message = decodeMessage(builtWire.message);
      const at = Date.now();
      const record = {
        id: newBuildId(),
        lastValidBlockHeight: built.lastValidBlockHeight,
        side: body.side,
        access: accessBuy && !who.pro,
        closing,
        mint: body.mint,
        lamports: tradeLamports,
        networkFeeLamports: BigInt(built.priorityFeeLamports) + BigInt(built.tipLamports) + BASE_FEE_LAMPORTS,
      };
      const list = liveBuilds(wallet);
      list.push({ ...record, blockhash: message.recentBlockhash, at, message, sacrifice });
      builds.set(wallet, list.slice(-MAX_BUILDS_PER_WALLET));
      if (builds.size > 5_000) builds.clear();
      const buildToken = signBuildToken(tokenSecret, {
        ...record,
        wallet,
        message: Buffer.from(builtWire.message).toString("base64"),
        sacrifice: sacrificeRecord(sacrifice),
        expiresAt: at + BUILD_TTL_MS,
      });
      return {
        ...built,
        ...(inputBalance !== undefined ? { inputAmount: amount.toString(), inputBalance } : {}),
        buildToken,
        quietSign: await quietSign(rpc, wallet, body.mint, body.side),
        sacrifice: sacrificeView(sacrifice),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TradeRejected || err instanceof NoRouteError)
        return reply.code(422).send({ error: message });
      if (err instanceof GuardRefusal) {
        // The guard's simulation refused it: most often the wallet can't afford it or the price
        // moved past the slippage, which the simulation's error says.
        countProTrade("buildRefused");
        request.log.warn(
          { wallet: walletTag(wallet), mint: body.mint, side: body.side, error: message },
          "pro trade refused",
        );
        return reply.code(422).send({ error: plainRefusal(message, body.side) });
      }
      if (err instanceof TransientError || err instanceof RateLimitedError) {
        countProTrade("buildUnavailable");
        request.log.warn(
          { wallet: walletTag(wallet), mint: body.mint, side: body.side, error: message },
          "pro trade build unavailable",
        );
        return reply.code(503).send({
          error:
            err instanceof RateLimitedError
              ? "Jupiter is busy right now, so the trade couldn't be priced. Try again in a few seconds."
              : "Couldn't reach the chain or Jupiter just now. Try again.",
        });
      }
      countProTrade("buildFailed");
      request.log.error({ err, wallet: walletTag(wallet), mint: body.mint }, "pro trade build failed");
      return reply.code(502).send({ error: `Couldn't build the trade: ${message}` });
    }
  });

  // What a trade would pay now: the network (priority fee and Sender's tip) and the Sacrifice
  // (ASDF fee plan) on a trade of `lamports` (the panel's amount; 0.1 SOL when left out).
  // platformFeeLamports is the Sacrifice's SOL value only while it is "on" and the wallet pays;
  // `sacrifice` says the tier, the credits and the burned-credit balance in every mode.
  app.get("/trade/fee", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: accessMint(request.query) });
    if (!who) return;
    const parsed = feeSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const q = parsed.data;
    // Nothing sent lately says whether Sender is up: ask it, for the next read (never waited on).
    if (senderHealth.pingDue())
      void pingSender(env.HELIUS_SENDER_URL).then((ok) => senderHealth.notePing(ok));
    const [fees, sacrifice] = await Promise.all([
      estimateManualFees(rpc, {
        mint: q.mint,
        speed: q.speed,
        ...(q.priorityFeeLamports !== undefined
          ? { priorityFeeLamports: BigInt(q.priorityFeeLamports) }
          : {}),
        ...(q.tipLamports !== undefined ? { tipLamports: BigInt(q.tipLamports) } : {}),
      }),
      sacrificeOn(
        who,
        q.lamports !== undefined && BigInt(q.lamports) > 0n ? BigInt(q.lamports) : DEFAULT_REF_LAMPORTS,
        freeAsdfBuy(q.side ?? "buy", q.mint),
      ),
    ]);
    return {
      priorityFeeLamports: fees.priorityFeeLamports.toString(),
      tipLamports: fees.tipLamports.toString(),
      baseFeeLamports: fees.baseFeeLamports.toString(),
      platformFeeLamports: charged(sacrifice) ? sacrifice.lamports!.toString() : "0",
      sacrifice: sacrificeView(sacrifice),
      // The panel warns while Sender isn't answering: shielded trades may expire, others use the RPC.
      senderDown: senderHealth.down,
    };
  });

  // The rest of what a buy costs (user ask 2026-10-18): the coin's transfer tax, the route's pool
  // and LP fees, price impact and a first buy's account rent. Each part it can't read is null.
  app.get("/trade/costs", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: accessMint(request.query) });
    if (!who) return;
    const parsed = costsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const q = parsed.data;
    let ref = q.refLamports !== undefined ? BigInt(q.refLamports) : DEFAULT_REF_LAMPORTS;
    if (ref <= 0n) ref = DEFAULT_REF_LAMPORTS;
    if (ref > MAX_REF_LAMPORTS) ref = MAX_REF_LAMPORTS;
    const [costs, sacrifice] = await Promise.all([
      swapCostsFor(who.wallet, q.mint, ref),
      sacrificeOn(who, ref, freeAsdfBuy("buy", q.mint)),
    ]);
    if (!costs) return reply.code(503).send({ error: "Couldn't read the swap's costs just now." });
    return {
      refLamports: ref.toString(),
      transferFeeBps: costs.transferFeeBps,
      poolFeeBps: costs.poolFeeBps,
      venues: costs.venues,
      priceImpactPct: costs.priceImpactPct,
      accountRentLamports: costs.accountRentLamports.toString(),
      routeVia: costs.routeVia,
      outAmount: costs.outAmount?.toString() ?? null,
      decimals: costs.decimals,
      platformFeeBps: charged(sacrifice) ? 20 : 0,
      sacrifice: sacrificeView(sacrifice),
    };
  });

  // What each "Get $ASDFASDFA" credit pick costs in SOL (creditPicksFor). Anyone signed in may read
  // it while the access buy is open, as for the access token's other reads.
  app.get("/trade/credit-picks", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: true });
    if (!who) return;
    const { tokensPerCredit, picks } = await creditPicksFor();
    return { mint: SUBSCRIPTION_MINT, decimals: SUBSCRIPTION_MINT_DECIMALS, tokensPerCredit, picks };
  });

  // What a sale would get, SOL by the route's quote: the Sell side's preview (user ask 2026-10-19).
  app.get("/trade/sale-quote", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: accessMint(request.query) });
    if (!who) return;
    const parsed = saleQuoteSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const units = BigInt(parsed.data.units);
    const lamports = await saleQuoteFor(parsed.data.mint, units);
    if (lamports === null) return reply.code(503).send({ error: "Couldn't quote the sale just now." });
    return { units: units.toString(), outLamports: lamports.toString() };
  });

  app.post("/trade/send", { config: { rateLimit: SEND_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: true });
    if (!who) return;
    const { wallet } = who;
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid", notSent: true });
    const { transaction, speed, mevProtect, buildToken } = parsed.data;
    const bytes = Uint8Array.from(Buffer.from(transaction, "base64"));
    let signature: string;
    let lastValidBlockHeight: number;
    let sentBuild: {
      id: string;
      side: "buy" | "sell";
      closing: boolean;
      mint: string;
      lamports: bigint;
      networkFeeLamports: bigint;
      sacrifice: PlatformTradeRecord["sacrifice"];
    };
    try {
      const wire = parseWireTransaction(bytes);
      const message = decodeMessage(wire.message);
      // Only the session's own wallet's transactions, signed by it alone, that pay Sender's tip.
      if (wire.requiredSignatures !== 1 || wire.accountKeys[0] !== wallet)
        return reply
          .code(400)
          .send({ error: "That transaction isn't from your wallet. Nothing was sent.", notSent: true });
      if (!verifyTransactionSignatures(bytes))
        return reply
          .code(400)
          .send({ error: "The wallet's signature doesn't verify. Nothing was sent.", notSent: true });
      if (!message.staticKeys.some(isSenderTipAccount))
        return reply
          .code(400)
          .send({ error: "That transaction doesn't tip Sender. Nothing was sent.", notSent: true });
      signature = bs58.encode(wire.signatures[0]!);
      // Sent already (a retried request), or being sent by a request still under way: the resend
      // loop has it, or will.
      if (inFlight.has(signature) || sending.has(signature)) return { signature };
      // One send per build, and only what was built (the wallet may add its own compute budget
      // and Lighthouse guards): our Sender key relays nothing a build didn't make. The build comes
      // from its token, on any instance, or (a panel without tokens) from this instance's memory;
      // one send per build across instances is PlatformTrade's unique buildId, written before it.
      const list = liveBuilds(wallet);
      let at: number;
      if (buildToken !== undefined) {
        const claims = verifyBuildToken(tokenSecret, buildToken);
        const built =
          claims && claims.wallet === wallet && (who.pro || claims.access)
            ? decodeMessage(Buffer.from(claims.message, "base64"))
            : null;
        if (!claims || !built || signedMatchesBuild(built, message) !== null)
          return reply.code(400).send({
            error: "That trade is too old or doesn't match its build. Nothing was sent; try again.",
            notSent: true,
          });
        sentBuild = claims;
        lastValidBlockHeight = claims.lastValidBlockHeight;
        at = list.findIndex((b) => b.id === claims.id);
      } else {
        at = list.findIndex(
          (b) =>
            b.blockhash === message.recentBlockhash &&
            (who.pro || b.access) &&
            signedMatchesBuild(b.message, message) === null,
        );
        if (at < 0)
          return reply.code(400).send({
            error: "That trade is too old or wasn't built here. Nothing was sent; try again.",
            notSent: true,
          });
        const b = list[at]!;
        sentBuild = { ...b, sacrifice: sacrificeRecord(b.sacrifice) };
        lastValidBlockHeight = b.lastValidBlockHeight;
      }
      if ([...inFlight.values()].filter((f) => f.wallet === wallet).length >= MAX_IN_FLIGHT_PER_WALLET)
        return reply.code(429).send({
          error: "Wait for your open trades to land before sending more. Nothing was sent.",
          notSent: true,
        });
      if (!sentBuild.closing) {
        const left = cooldown.left(wallet);
        if (left > 0) return tooSoon(reply, left);
      }
      if (at >= 0) list.splice(at, 1);
    } catch {
      return reply
        .code(400)
        .send({ error: "That isn't a transaction this can send. Nothing was sent.", notSent: true });
    }
    // The wallet's cooldown starts here, with nothing awaited since it was checked above, so two
    // sends racing each other (two builds sent at once) can't both pass it. Closing sales count
    // too: a buy right after one still waits. Given back on every path where nothing goes out.
    const giveBack = cooldown.take(wallet);
    sending.add(signature);
    try {
      const url = senderFor(speed, mevProtect);
      // The trade record and its Sacrifice, in one transaction before anything goes on chain
      // (recordPlatformTrade in core): in "on" mode the burned pot is re-checked under the wallet's
      // credit lock, so two sends can't spend the same credits, and a charge is never unrecorded.
      // The row also carries what any instance needs to keep resending it and to call it expired.
      const q = sentBuild.sacrifice;
      try {
        const recorded = await recordPlatformTrade({
          signature,
          wallet,
          mint: sentBuild.mint,
          side: sentBuild.side,
          lamports: sentBuild.lamports,
          networkFeeLamports: sentBuild.networkFeeLamports,
          sacrifice: q,
          inFlight: {
            transaction,
            lastValidBlockHeight,
            senderSpeed: speed,
            senderMevProtect: mevProtect,
            buildId: sentBuild.id,
          },
          // Closing sales are exempt. The row is still written under the pace lock, so the next
          // paced trade on any instance sees it. The in-memory cooldown is only the fast path.
          paceMs: sentBuild.closing ? undefined : TRADE_COOLDOWN_MS,
        });
        if (recorded.status === "short") {
          giveBack();
          return reply.code(422).send({
            error:
              "Your burned credits no longer cover this trade's Sacrifice. Nothing was sent; top up and try again.",
            topUp: true,
            notSent: true,
          });
        }
        if (recorded.status === "too-soon") {
          giveBack();
          return tooSoon(reply, recorded.retryAfterMs);
        }
      } catch (err) {
        // Recorded already: this signature (a retried request, maybe on another instance) is out and
        // being resent; anything else signed from the same build is not sent a second time.
        if ((err as { code?: unknown } | null)?.code === "P2002") {
          // This request sends nothing: the wallet's cooldown is the earlier send's.
          giveBack();
          const row = await prisma.platformTrade
            .findUnique({ where: { signature }, select: { wallet: true, status: true } })
            .catch(() => null);
          if (row?.wallet === wallet && row.status === "sent") return { signature };
          return reply
            .code(409)
            .send({ error: "This trade was already sent once. Nothing more was sent.", notSent: true });
        }
        // No row means nothing may go out: a later signature of this build would otherwise be a
        // second trade, and the build id that blocks it would never have been stored.
        request.log.warn({ signature, err: String(err) }, "platform trade not recorded");
        giveBack();
        return reply.code(503).send({
          error: "Couldn't record the trade just now. Nothing was sent; try again.",
          notSent: true,
        });
      }
      const sent = await sendViaSender(url, transaction);
      senderHealth.note(sent.ok || sent.refused);
      if (!sent.ok && sent.refused) {
        countProTrade("sendRefused");
        giveBack();
        // Nothing went out: the Sacrifice comes back at once.
        await settleRefused(signature);
        request.log.warn(
          { wallet: walletTag(wallet), signature, error: sent.error },
          "sender refused a pro trade",
        );
        // Refused by Sender: nothing went out under this signature (it is safe to build again).
        // 409, not a 5xx: a proxy's 502 must never read as "nothing went out".
        return reply
          .code(409)
          .send({ error: `Helius Sender refused the trade: ${sent.error}`, notSent: true });
      }
      // No clear answer (a timeout): it may have gone out, so it is treated as sent and resent.
      if (!sent.ok) {
        countProTrade("sendUnclear");
        request.log.warn(
          { wallet: walletTag(wallet), signature, error: sent.error },
          "sender send unclear; resending",
        );
      }
      inFlight.set(signature, {
        base64: transaction,
        url,
        lastValidBlockHeight,
        until: Date.now() + RESEND_FOR_MS,
        wallet,
        rpcFallback: !mevProtect,
        silent: sent.ok ? 0 : 1,
      });
      // A backstop on memory only (each wallet has at most MAX_IN_FLIGHT_PER_WALLET): the oldest
      // stops being resent, and its status can still say "expired".
      if (inFlight.size > MAX_IN_FLIGHT) {
        const [oldest, f] = inFlight.entries().next().value!;
        retire(oldest, f);
      }
      scheduleResend();
      forgetPositions(wallet);
      return { signature };
    } finally {
      sending.delete(signature);
    }
  });

  /**
   * A recorded trade's outcome, once known (only "sent" rows change), with its Sacrifice refunded
   * when it failed or expired (settlePlatformTrade in core). The worker's settlement job settles
   * whatever no panel is watching.
   */
  const settle = (signature: string, status: "confirmed" | "failed" | "expired") =>
    settlePlatformTrade(signature, status).catch((err) =>
      app.log.error({ signature, status, err: String(err) }, "platform trade not settled"),
    );
  /** A trade Sender refused (nothing went out): failed, with its Sacrifice refunded at once. */
  const settleRefused = (signature: string) => settle(signature, "failed");

  /**
   * The wallet's recorded trade's blockhash life, from its row: a trade another instance sent
   * (before a deploy) can be answered "expired" here too. Undefined when there is no such row.
   */
  const rowFlight = async (signature: string, wallet: string) => {
    const row = await prisma.platformTrade
      .findUnique({ where: { signature }, select: { wallet: true, lastValidBlockHeight: true } })
      .catch(() => null);
    if (row?.wallet !== wallet || row.lastValidBlockHeight === null) return undefined;
    return { lastValidBlockHeight: Number(row.lastValidBlockHeight) };
  };

  app.get<{ Params: { signature: string } }>(
    "/trade/status/:signature",
    { config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const who = await proWallet(request, reply, { access: true });
      if (!who) return;
      const { wallet } = who;
      const { signature } = request.params;
      if (!SIGNATURE_RE.test(signature)) return reply.code(400).send({ error: "not a signature" });
      // The node's recent status cache: the panel asks about a trade seconds old, and a full
      // history search is slower. "Not seen" there proves nothing for an older one, so expiry is
      // only ever concluded from a history search below.
      let status = await rpc.getSignatureStatus(signature, { searchHistory: false });
      if (!status) {
        const earlier = failures.get(signature);
        if (earlier) return { state: "failed", reason: earlier.reason, error: earlier.error };
        return { state: "unknown" };
      }
      if (!status.seen) {
        // A landing we already saw fail stays a failure. Expiry is only for a signature never seen.
        const earlier = failures.get(signature);
        if (earlier) return { state: "failed", reason: earlier.reason, error: earlier.error };
        // Past its blockhash's life and never seen: it won't land. The height is read first
        // and the status again after it, so a landing in between can't read as expired.
        const flight =
          inFlight.get(signature) ?? retired.get(signature) ?? (await rowFlight(signature, wallet));
        const height = flight ? await rpc.getBlockHeight() : null;
        if (flight && height !== null && height > flight.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
          const again = await rpc.getSignatureStatus(signature, { searchHistory: true });
          if (again && !again.seen) {
            inFlight.delete(signature);
            retired.delete(signature);
            void settle(signature, "expired");
            return { state: "expired" };
          }
          // Landed longer ago than the recent cache reaches.
          if (again) status = again;
        }
        if (!status.seen) return { state: "pending" };
      }
      if (status.error) {
        inFlight.delete(signature);
        void settle(signature, "failed");
        // The balance may have moved (a fee, or a fill the error doesn't describe): the next
        // position read must not answer with the pre-trade cache.
        forgetPositions(wallet);
        const failure = rememberFailure(signature, status.error);
        return { state: "failed", ...failure };
      }
      if (status.confirmed) {
        inFlight.delete(signature);
        failures.delete(signature);
        void settle(signature, "confirmed");
        forgetPositions(wallet);
        return { state: "confirmed" };
      }
      // Seen earlier as a failure, and this read hasn't confirmed it since: still a failure.
      // A cache miss must not turn a landed revert into "pending" or, past the blockhash, "expired".
      const earlier = failures.get(signature);
      if (earlier) return { state: "failed", reason: earlier.reason, error: earlier.error };
      return { state: "pending" };
    },
  );

  // Fees saved (user ask 2026-10-18): Pro Mode only, the session's own wallet's trades. Trades
  // the panel stopped watching before they settled are settled here, a few per read.
  app.get("/trade/fees", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply);
    if (!who) return;
    const { wallet } = who;
    reply.header("Cache-Control", "private, no-store");
    const open = await prisma.platformTrade.findMany({
      where: { wallet, status: "sent", sentAt: { lt: new Date(Date.now() - FEES_SETTLE_AFTER_MS) } },
      orderBy: { sentAt: "asc" },
      take: FEES_SETTLE_PER_READ,
      select: { signature: true, sentAt: true },
    });
    await Promise.all(
      open.map(async (t) => {
        // Unseen well past its blockhash's life, it never landed (tradeOutcome in core).
        const outcome = tradeOutcome(await rpc.getSignatureStatus(t.signature).catch(() => null), t.sentAt);
        if (outcome) return settle(t.signature, outcome);
      }),
    );
    const [trades, first, solUsd] = await Promise.all([
      prisma.platformTrade.findMany({
        where: { wallet, status: "confirmed" },
        select: { side: true, lamports: true, platformFeeLamports: true, networkFeeLamports: true },
      }),
      prisma.platformTrade.findFirst({
        where: { wallet },
        orderBy: { sentAt: "asc" },
        select: { sentAt: true },
      }),
      solPrice.get().catch(() => null),
    ]);
    const { mode, freeRank } = await sacrificeSettings();
    return {
      ...feeSummary(trades),
      since: first?.sentAt ?? null,
      solUsd,
      solUsdAt: solUsd ? solPrice.readAt() : null,
      sacrifice: { mode, freeRank },
    };
  });

  app.get<{ Params: { mint: string } }>(
    "/trade/:mint/position",
    { config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const who = await proWallet(request, reply, { access: request.params.mint === SUBSCRIPTION_MINT });
      if (!who) return;
      const { wallet } = who;
      const { mint } = request.params;
      if (!looksLikeSolanaAddress(mint)) return reply.code(400).send({ error: "not a token address" });
      const key = `${wallet}:${mint}`;
      const cached = positions.get(key);
      if (cached && Date.now() - cached.at < POSITION_TTL_MS) return cached.body;
      // One read per wallet and coin at a time: a second request waits for the first's answer.
      let read = positionReads.get(key);
      if (!read) {
        const mine: Promise<unknown> = readPosition(wallet, mint).finally(() => {
          if (positionReads.get(key) === mine) positionReads.delete(key);
        });
        read = mine;
        positionReads.set(key, read);
      }
      const body = await read;
      if (!body) return reply.code(503).send({ error: "Couldn't read your balance just now." });
      return body;
    },
  );

  async function readPosition(wallet: string, mint: string): Promise<unknown> {
    const key = `${wallet}:${mint}`;
    const epoch = positionEpochs.get(wallet) ?? 0;
    const [balance, history, supply, solUsd] = await Promise.all([
      rpc.getTokenBalance(wallet, mint),
      walletTokenTrades(rpc, wallet, mint, tradeCache),
      supplyOf(mint),
      solPrice.get().catch(() => null),
    ]);
    if (!balance) return null;
    if (tradeCache.size > MAX_CACHED_TRADES) tradeCache.clear();
    // The trades made from our Trade panel, for the position's fees saved (user ask 2026-10-19).
    const signatures = (history?.trades ?? []).map((t) => t.signature);
    const panel = new Map(
      signatures.length
        ? (
            await prisma.platformTrade
              .findMany({
                where: { wallet, mint, signature: { in: signatures }, status: { in: ["sent", "confirmed"] } },
                select: { signature: true, lamports: true, platformFeeLamports: true },
              })
              .catch(() => [])
          ).map((r) => [r.signature, r])
        : [],
    );
    const body = {
      wallet,
      mint,
      decimals: balance.decimals ?? supply?.decimals ?? null,
      balance: balance.raw.toString(),
      supply: supply ? supply.raw.toString() : null,
      solUsd,
      solUsdAt: solUsd ? solPrice.readAt() : null,
      trades: (history?.trades ?? []).map((t) => ({
        signature: t.signature,
        t: t.t,
        side: t.side,
        lamports: t.lamports.toString(),
        tokens: t.tokens.toString(),
        // Made from our Trade panel: its SOL value and what we charged, as tradeFees.ts counts them.
        panel: panelTrade(panel.get(t.signature)),
      })),
      // The history couldn't be read (the balance could): the chart shows the position without marks.
      historyUnavailable: history === null,
      truncated: history?.truncated ?? false,
    };
    // The wallet traded while this read ran: answer it, but don't keep it.
    if ((positionEpochs.get(wallet) ?? 0) !== epoch) return body;
    if (positions.size > 1_000) positions.clear();
    positions.set(key, { at: Date.now(), body });
    return body;
  }

  async function supplyOf(mint: string) {
    const hit = supplies.get(mint);
    if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit;
    const read = await rpc.getTokenSupply(mint);
    if (!read) return hit ?? null;
    const entry = { at: Date.now(), ...read };
    if (supplies.size > 5_000) supplies.clear();
    supplies.set(mint, entry);
    return entry;
  }

  // Resending: the same signed bytes every couple of seconds until the trade lands, fails, or its
  // blockhash expires. One timer for all of them; nothing runs while nothing is in flight.
  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleResend() {
    if (timer || inFlight.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void resendAll().finally(scheduleResend);
    }, RESEND_EVERY_MS);
    timer.unref?.();
  }
  async function resendAll() {
    const now = Date.now();
    const height = await rpc.getBlockHeight().catch(() => null);
    const live: [string, InFlight][] = [];
    for (const [signature, f] of inFlight) {
      if (now > f.until || (height !== null && height > f.lastValidBlockHeight)) retire(signature, f);
      else live.push([signature, f]);
    }
    // One status read for them all (256 a call; each is seconds old, so the recent cache is enough).
    const statuses = await rpc
      .getSignatureStatuses(
        live.map(([s]) => s),
        { searchHistory: false },
      )
      .catch(() => null);
    const unseen = live.filter(([signature, f], i) => {
      const st = statuses?.[i];
      // Landed and reverted (slippage, most often): stop resending the same bytes, and don't
      // treat the sighting as a fill. A wider slippage is never built from here.
      if (st && st.seen && st.error) {
        rememberFailure(signature, st.error);
        inFlight.delete(signature);
        forgetPositions(f.wallet);
        void settle(signature, "failed");
        return false;
      }
      if (!st?.seen) return true;
      inFlight.delete(signature);
      forgetPositions(f.wallet);
      return false;
    });
    for (let i = 0; i < unseen.length; i += RESEND_BATCH)
      await Promise.all(unseen.slice(i, i + RESEND_BATCH).map(([signature, f]) => resend(signature, f)));
  }
  /**
   * One resend: to Sender, and with MEV Protect off, once Sender has left it unanswered twice, the
   * same bytes through the RPC and its backup too (the Sender tip in it is harmless there). Neither
   * answer changes the trade: it may have gone out either way, and only its status settles it.
   */
  async function resend(signature: string, f: InFlight) {
    const viaRpc = f.rpcFallback && f.silent >= RPC_FALLBACK_AFTER;
    if (viaRpc && f.silent === RPC_FALLBACK_AFTER)
      app.log.warn(
        { wallet: walletTag(f.wallet), signature },
        "sender silent; resending through the rpc too",
      );
    const [sent] = await Promise.all([
      sendViaSender(f.url, f.base64),
      viaRpc ? rpc.send(f.base64).catch(() => null) : null,
    ]);
    const answered = sent.ok || sent.refused;
    senderHealth.note(answered);
    f.silent = answered ? 0 : f.silent + 1;
  }
  /**
   * At boot: trades still "sent" and inside their blockhash's life go back on the resend loop
   * (the instance that sent them stopped: a crash, or a deploy past its drain). Their rows carry
   * the signed bytes and the Sender tier; the key is this instance's own.
   */
  let closing = false;
  async function resumeInFlight() {
    const rows = await prisma.platformTrade.findMany({
      where: {
        status: "sent",
        transaction: { not: null },
        lastValidBlockHeight: { not: null },
        sentAt: { gt: new Date(Date.now() - RESUME_WINDOW_MS) },
      },
      orderBy: { sentAt: "asc" },
      take: MAX_IN_FLIGHT,
      select: {
        signature: true,
        wallet: true,
        transaction: true,
        lastValidBlockHeight: true,
        senderSpeed: true,
        senderMevProtect: true,
      },
    });
    if (rows.length === 0 || closing) return;
    const height = await rpc.getBlockHeight().catch(() => null);
    let resumed = 0;
    for (const r of rows) {
      const lastValidBlockHeight = Number(r.lastValidBlockHeight);
      if (inFlight.has(r.signature) || inFlight.size >= MAX_IN_FLIGHT) continue;
      // Past its life it can't land: /status, the fees read or the settlement job settles it.
      if (height !== null && height > lastValidBlockHeight) continue;
      inFlight.set(r.signature, {
        base64: r.transaction!,
        url: senderFor(r.senderSpeed === "turbo" ? "turbo" : "eco", r.senderMevProtect === true),
        lastValidBlockHeight,
        until: Date.now() + RESEND_FOR_MS,
        wallet: r.wallet,
        // Only a row that says MEV Protect was off: an older row without it stays on Sender.
        rpcFallback: r.senderMevProtect === false,
        silent: 0,
      });
      resumed++;
    }
    if (resumed > 0) app.log.info({ resumed }, "pro trades resumed after a restart");
    scheduleResend();
  }
  void resumeInFlight().catch((err) => app.log.warn({ err: String(err) }, "pro trades not resumed"));

  // A deploy's SIGTERM: trades in flight are resent until they land or expire (bounded by
  // DRAIN_MAX_MS) before the process goes, instead of after one send.
  app.addHook("onClose", async () => {
    closing = true;
    const until = Date.now() + DRAIN_MAX_MS;
    if (inFlight.size > 0) app.log.info({ inFlight: inFlight.size }, "pro trades draining before shutdown");
    while (inFlight.size > 0 && Date.now() < until) {
      scheduleResend();
      // Not unref'd: this wait is what keeps the process up while the trades drain.
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    if (inFlight.size > 0)
      app.log.warn({ inFlight: inFlight.size }, "pro trades still in flight at shutdown");
    if (timer) clearTimeout(timer);
    timer = null;
    inFlight.clear();
    retired.clear();
  });
}

/** The pauses before a build's retries, when the chain or Jupiter didn't answer. */
const BUILD_RETRY_MS = [800, 2_000];

/** Lamports as SOL for a message, up to four decimals. */
function solAmount(lamports: bigint): string {
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Whether a Privy wallet may sign this trade without Privy's confirm window (user rule 2026-10-18):
 * a sale (the wallet holds the coin), or a buy of a coin the wallet already holds, whose latest scan
 * passed the safety screen, or that any model has called. Anything else, or anything that can't be
 * read, asks. The page still checks the transaction before signing it either way.
 */
export async function quietSign(
  rpc: Pick<TradingRpc, "getTokenBalance">,
  wallet: string,
  mint: string,
  side: "buy" | "sell",
): Promise<boolean> {
  if (side === "sell") return true;
  try {
    const token = await prisma.token.findUnique({
      where: { mintAddress: mint },
      select: { id: true, screenRejectedAt: true },
    });
    const [alerted, scan, balance] = await Promise.all([
      token ? prisma.curatedAlert.findFirst({ where: { tokenId: token.id }, select: { id: true } }) : null,
      token && !token.screenRejectedAt
        ? prisma.tokenSnapshot.findFirst({
            where: { tokenId: token.id },
            orderBy: { takenAt: "desc" },
            select: { rugScreenPassed: true },
          })
        : null,
      rpc.getTokenBalance(wallet, mint).catch(() => null),
    ]);
    return !!alerted || scan?.rugScreenPassed === true || (balance?.raw ?? 0n) > 0n;
  } catch {
    return false;
  }
}

/**
 * A percent of a raw balance, the same way the panel's sell presets count it (shareOf): all of it
 * at 100. The build uses this on the balance it just read, not the figure the page was showing.
 */
export function sellShare(raw: bigint, percent: number): bigint {
  if (percent >= 100) return raw;
  return (raw * BigInt(Math.round(percent * 100))) / 10_000n;
}

/**
 * Whether `message` is a swap that would execute outside the slippage the trade was built with.
 * Jupiter's SlippageToleranceExceeded is 6001 (0x1771). Pump.fun's buy and sell misses are 6002
 * and 6003. PumpSwap's is 6042 (0x179a). The RPC reports the program error as JSON
 * (`{"Custom":6001}`), which is not the log line "custom program error: 0x1771".
 */
export function slippageMiss(message: string): boolean {
  if (
    /SlippageToleranceExceeded|TooMuchSolRequired|TooLittleSolReceived|ExceededSlippage|under the quoted minimum/i.test(
      message,
    )
  )
    return true;
  if (/0x1771|0x1772|0x1773|0x179a/i.test(message)) return true;
  return /(?:^|[^0-9])(6001|6002|6003|6042)(?:[^0-9]|$)/.test(message);
}

/** The price moved before anything was signed: nothing went out. */
export const SLIPPAGE_UNSENT =
  "The price moved past your slippage. Nothing was sent. Try again, or raise the slippage.";

/** The signed trade landed and reverted because the price moved. It is not a fill. */
export const SLIPPAGE_LANDED =
  "The price moved past your slippage. Nothing was bought or sold. Try again, or raise the slippage.";

/** The guard's refusal in the trader's words, where it can be said plainly. */
export function plainRefusal(message: string, side: "buy" | "sell" = "buy"): string {
  if (/insufficient lamports/i.test(message))
    return "Not enough SOL in your wallet for this trade and its fees.";
  // Token program error 1 (InsufficientFunds) on a sale is the tokens, not the SOL.
  if (/InsufficientFunds|0x1\b|"Custom":1\}/i.test(message))
    return side === "sell"
      ? "You hold fewer tokens than that sale. Refresh and try again."
      : "Not enough SOL in your wallet for this trade and its fees.";
  if (slippageMiss(message)) return SLIPPAGE_UNSENT;
  if (/AccountNotFound/i.test(message)) return "Your wallet has no SOL yet (the account doesn't exist).";
  return `The trade was refused before signing: ${message.replace(/^refused: /, "")}`;
}

/**
 * A signature the chain has already landed as a failure. Slippage stays its own sentence (nothing
 * was bought or sold, and nothing is retried at a wider slippage). Anything else keeps its cause:
 * a timeout or a drop is not rewritten into a slippage miss.
 */
export function landedFailure(error: string): { reason: "slippage" | "rejected"; error: string } {
  if (slippageMiss(error)) return { reason: "slippage", error: SLIPPAGE_LANDED };
  const plain = plainRefusal(error);
  if (plain.startsWith("The trade was refused before signing:")) return { reason: "rejected", error };
  return { reason: "rejected", error: `${plain} Nothing was bought or sold.` };
}
