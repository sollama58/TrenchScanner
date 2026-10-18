import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bs58 from "bs58";
import { z } from "zod";
import {
  buildManualTrade,
  estimateManualFees,
  estimateSwapCosts,
  type SwapCosts,
  decodeMessage,
  isSenderTipAccount,
  JupiterSwapClient,
  looksLikeSolanaAddress,
  parseWireTransaction,
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
  type WalletTrade,
  walletTag,
} from "@trenchscanner/core";
import { proStatus } from "../proMode.js";
import { requireTwoFactor } from "../twoFactor.js";
import { accessSwapOpen as accessSwapOpenFor } from "./auth.js";
import { SolPrice } from "../solPrice.js";

/**
 * Pro trades from the token modal (user decision 2026-10-17), for Pro Mode wallets only
 * (proMode.ts): everyone else gets a 404 here, as if none of it existed.
 *
 *   POST /pro/trade/build            a swap for the signed-in wallet to sign (manualTrade.ts)
 *   POST /pro/trade/send             relays the signed swap to Helius Sender, and keeps resending
 *                                    it until it lands or its blockhash expires
 *   GET  /pro/trade/status/:sig      whether it landed
 *   GET  /pro/trade/:mint/position   the wallet's balance and trades in the coin, for the chart
 *
 * Non-custodial: the API never sees a key. It builds bytes the guard has simulated, the wallet
 * signs them in the browser, and /send relays only a transaction the session's own wallet signed
 * and that tips Sender - so it can't be used to push anyone else's traffic on our Helius key.
 */

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

const feeSchema = z.object({
  mint: z.string().refine(looksLikeSolanaAddress, "not a token address"),
  speed: z.enum(["eco", "turbo"]),
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
  /** The buy the swap costs are quoted on, lamports (the panel's first buy button). */
  refLamports: z
    .string()
    .regex(/^\d{1,12}$/)
    .optional(),
});

const sendSchema = z.object({
  transaction: z.string().min(1).max(2_000),
  speed: z.enum(["eco", "turbo"]),
  mevProtect: z.boolean(),
});

/**
 * Trade limits (user ask 2026-10-18): no trade under 0.01 SOL (a buy's spend, a sale's quoted
 * proceeds), and one trade sent every 5 seconds per wallet. A sale of the whole balance closes a
 * position and is exempt from both: nobody is ever stuck holding dust or waiting to get out.
 */
export const MIN_TRADE_LAMPORTS = 10_000_000n;
export const TRADE_COOLDOWN_MS = 5_000;

/** When each wallet last sent a trade, for TRADE_COOLDOWN_MS. */
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
/** In-flight trades kept for resending at once, across everyone, and for one wallet. */
const MAX_IN_FLIGHT = 200;
const MAX_IN_FLIGHT_PER_WALLET = 5;
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
const MAX_CACHED_SWAP_COSTS = 2_000;
/** The reference buy when the panel names none: 0.1 SOL. */
const DEFAULT_REF_LAMPORTS = 100_000_000n;
const MAX_REF_LAMPORTS = 100_000_000_000n;

interface InFlight {
  base64: string;
  url: string;
  lastValidBlockHeight: number;
  until: number;
  wallet: string;
}

export async function registerProTradeRoutes(app: FastifyInstance, opts: { env: Env }) {
  const { env } = opts;
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const jupiter = new JupiterSwapClient({ apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined });
  const solPrice = new SolPrice();
  const tradeCache = new Map<string, WalletTrade | null>();
  const positions = new Map<string, { at: number; body: unknown }>();
  const supplies = new Map<string, { at: number; raw: bigint; decimals: number }>();
  const swapCosts = new Map<string, { at: number; costs: SwapCosts | null }>();
  /** The swap costs for a wallet's buy of `ref` lamports of `mint`, cached; null when they can't be read. */
  const swapCostsFor = async (wallet: string, mint: string, ref: bigint): Promise<SwapCosts | null> => {
    const key = `${wallet}:${mint}:${ref}`;
    const hit = swapCosts.get(key);
    if (hit && Date.now() - hit.at < SWAP_COSTS_TTL_MS) return hit.costs;
    const costs = await estimateSwapCosts({ rpc, jupiter }, { wallet, mint, referenceLamports: ref }).catch(
      () => null,
    );
    if (swapCosts.size >= MAX_CACHED_SWAP_COSTS) swapCosts.delete(swapCosts.keys().next().value!);
    swapCosts.set(key, { at: Date.now(), costs });
    return costs;
  };
  const inFlight = new Map<string, InFlight>();
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

  /** Drops one wallet's cached positions (it just traded); everyone else's stay. */
  function forgetPositions(wallet: string) {
    for (const key of positions.keys()) if (key.startsWith(`${wallet}:`)) positions.delete(key);
  }
  const builds = new Map<
    string,
    {
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
    }[]
  >();

  const cooldown = new TradeCooldown();
  function tooSoon(reply: FastifyReply, leftMs: number) {
    const seconds = Math.max(1, Math.ceil(leftMs / 1_000));
    return reply.code(429).send({
      error: `One trade every ${TRADE_COOLDOWN_MS / 1_000} seconds: try again in ${seconds}s. Nothing was sent.`,
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
  ): Promise<{ wallet: string; pro: boolean } | null> {
    const wallet = request.user!.walletAddress;
    const status = await proStatus(env, wallet);
    if (!status.pro && !(opts.access && accessSwapOpen())) {
      reply.code(404).send({ error: "not found", notSent: true });
      return null;
    }
    return { wallet, pro: status.pro };
  }
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
    const closing = body.side === "sell" && body.all === true;
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
      if (body.side === "sell" && body.all) {
        const balance = await rpc.getTokenBalance(wallet, body.mint);
        if (!balance) throw new TransientError("couldn't read the balance");
        if (balance.raw === 0n) return reply.code(422).send({ error: "You don't hold any of this coin." });
        amount = balance.raw;
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
      // One more go after a short pause when the chain or Jupiter didn't answer: most such misses
      // are a moment's rate limit, and a second tap shouldn't be the trader's job.
      const built = await build().catch(async (err) => {
        if (!(err instanceof TransientError || err instanceof RateLimitedError)) throw err;
        request.log.warn(
          { wallet: walletTag(wallet), mint: body.mint, error: String(err) },
          "pro trade build retried",
        );
        await new Promise((r) => setTimeout(r, BUILD_RETRY_MS));
        return build();
      });
      // A partial sale is measured by what the route quotes for it, in lamports.
      if (!closing && body.side === "sell" && BigInt(built.quotedOut) < MIN_TRADE_LAMPORTS)
        return reply.code(422).send({ error: tooSmall("sell") });
      const builtWire = parseWireTransaction(Buffer.from(built.transaction, "base64"));
      const message = decodeMessage(builtWire.message);
      const list = liveBuilds(wallet);
      list.push({
        blockhash: message.recentBlockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        at: Date.now(),
        side: body.side,
        access: accessBuy && !who.pro,
        closing,
        message,
      });
      builds.set(wallet, list.slice(-MAX_BUILDS_PER_WALLET));
      if (builds.size > 5_000) builds.clear();
      return built;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TradeRejected || err instanceof NoRouteError)
        return reply.code(422).send({ error: message });
      if (err instanceof GuardRefusal) {
        // The guard's simulation refused it: most often the wallet can't afford it or the price
        // moved past the slippage, which the simulation's error says.
        request.log.warn(
          { wallet: walletTag(wallet), mint: body.mint, side: body.side, error: message },
          "pro trade refused",
        );
        return reply.code(422).send({ error: plainRefusal(message, body.side) });
      }
      if (err instanceof TransientError || err instanceof RateLimitedError) {
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
      request.log.error({ err, wallet: walletTag(wallet), mint: body.mint }, "pro trade build failed");
      return reply.code(502).send({ error: `Couldn't build the trade: ${message}` });
    }
  });

  // What a trade would pay the network now (priority fee and Sender's tip), for the panel to show
  // before anything is built. TrenchScanner itself takes nothing.
  app.get("/trade/fee", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: accessMint(request.query) });
    if (!who) return;
    const parsed = feeSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const q = parsed.data;
    const fees = await estimateManualFees(rpc, {
      mint: q.mint,
      speed: q.speed,
      ...(q.priorityFeeLamports !== undefined ? { priorityFeeLamports: BigInt(q.priorityFeeLamports) } : {}),
      ...(q.tipLamports !== undefined ? { tipLamports: BigInt(q.tipLamports) } : {}),
    });
    return {
      priorityFeeLamports: fees.priorityFeeLamports.toString(),
      tipLamports: fees.tipLamports.toString(),
      baseFeeLamports: fees.baseFeeLamports.toString(),
      platformFeeLamports: "0",
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
    const costs = await swapCostsFor(who.wallet, q.mint, ref);
    if (!costs) return reply.code(503).send({ error: "Couldn't read the swap's costs just now." });
    return {
      refLamports: ref.toString(),
      transferFeeBps: costs.transferFeeBps,
      poolFeeBps: costs.poolFeeBps,
      venues: costs.venues,
      priceImpactPct: costs.priceImpactPct,
      accountRentLamports: costs.accountRentLamports.toString(),
      platformFeeBps: 0,
    };
  });

  app.post("/trade/send", { config: { rateLimit: SEND_RATE_LIMIT } }, async (request, reply) => {
    const who = await proWallet(request, reply, { access: true });
    if (!who) return;
    const { wallet } = who;
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid", notSent: true });
    const { transaction, speed, mevProtect } = parsed.data;
    const bytes = Uint8Array.from(Buffer.from(transaction, "base64"));
    let signature: string;
    let lastValidBlockHeight: number;
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
      // Sent already (a retried request): the resend loop has it.
      if (inFlight.has(signature)) return { signature };
      // One send per build, and only what was built (the wallet may add its own compute budget
      // and Lighthouse guards): our Sender key relays nothing a build didn't make.
      const list = liveBuilds(wallet);
      const at = list.findIndex(
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
      lastValidBlockHeight = list[at]!.lastValidBlockHeight;
      if ([...inFlight.values()].filter((f) => f.wallet === wallet).length >= MAX_IN_FLIGHT_PER_WALLET)
        return reply.code(429).send({
          error: "Wait for your open trades to land before sending more. Nothing was sent.",
          notSent: true,
        });
      if (!list[at]!.closing) {
        const left = cooldown.left(wallet);
        if (left > 0) return tooSoon(reply, left);
      }
      list.splice(at, 1);
    } catch {
      return reply
        .code(400)
        .send({ error: "That isn't a transaction this can send. Nothing was sent.", notSent: true });
    }
    const url = senderUrl(env.HELIUS_SENDER_URL, {
      speed,
      mevProtect,
      apiKey: env.HELIUS_API_KEY || undefined,
    });
    // Given back when Sender refuses (nothing went out). Closing sales count too: a buy right
    // after one still waits.
    const giveBack = cooldown.take(wallet);
    const sent = await sendViaSender(url, transaction);
    if (!sent.ok && sent.refused) {
      giveBack();
      request.log.warn(
        { wallet: walletTag(wallet), signature, error: sent.error },
        "sender refused a pro trade",
      );
      // Refused by Sender: nothing went out under this signature (it is safe to build again).
      // 409, not a 5xx: a proxy's 502 must never read as "nothing went out".
      return reply.code(409).send({ error: `Helius Sender refused the trade: ${sent.error}`, notSent: true });
    }
    // No clear answer (a timeout): it may have gone out, so it is treated as sent and resent.
    if (!sent.ok)
      request.log.warn(
        { wallet: walletTag(wallet), signature, error: sent.error },
        "sender send unclear; resending",
      );
    if (inFlight.size < MAX_IN_FLIGHT) {
      inFlight.set(signature, {
        base64: transaction,
        url,
        lastValidBlockHeight,
        until: Date.now() + RESEND_FOR_MS,
        wallet,
      });
      scheduleResend();
    }
    forgetPositions(wallet);
    return { signature };
  });

  app.get<{ Params: { signature: string } }>(
    "/trade/status/:signature",
    { config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const who = await proWallet(request, reply, { access: true });
      if (!who) return;
      const { wallet } = who;
      const { signature } = request.params;
      if (!SIGNATURE_RE.test(signature)) return reply.code(400).send({ error: "not a signature" });
      const status = await rpc.getSignatureStatus(signature);
      if (!status) return { state: "unknown" };
      if (!status.seen) {
        // Past its blockhash's life and never seen: it won't land. The height is read first
        // and the status again after it, so a landing in between can't read as expired.
        const flight = inFlight.get(signature) ?? retired.get(signature);
        const height = flight ? await rpc.getBlockHeight() : null;
        if (flight && height !== null && height > flight.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
          const again = await rpc.getSignatureStatus(signature);
          if (again && !again.seen) {
            inFlight.delete(signature);
            retired.delete(signature);
            return { state: "expired" };
          }
        }
        return { state: "pending" };
      }
      if (status.error) {
        inFlight.delete(signature);
        return { state: "failed", error: status.error };
      }
      if (status.confirmed) {
        inFlight.delete(signature);
        forgetPositions(wallet);
        return { state: "confirmed" };
      }
      return { state: "pending" };
    },
  );

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
        read = readPosition(wallet, mint).finally(() => positionReads.delete(key));
        positionReads.set(key, read);
      }
      const body = await read;
      if (!body) return reply.code(503).send({ error: "Couldn't read your balance just now." });
      return body;
    },
  );

  async function readPosition(wallet: string, mint: string): Promise<unknown> {
    const key = `${wallet}:${mint}`;
    const [balance, history, supply, solUsd] = await Promise.all([
      rpc.getTokenBalance(wallet, mint),
      walletTokenTrades(rpc, wallet, mint, tradeCache),
      supplyOf(mint),
      solPrice.get().catch(() => null),
    ]);
    if (!balance) return null;
    if (tradeCache.size > MAX_CACHED_TRADES) tradeCache.clear();
    const body = {
      wallet,
      mint,
      decimals: balance.decimals ?? supply?.decimals ?? null,
      balance: balance.raw.toString(),
      supply: supply ? supply.raw.toString() : null,
      solUsd,
      trades: (history?.trades ?? []).map((t) => ({
        signature: t.signature,
        t: t.t,
        side: t.side,
        lamports: t.lamports.toString(),
        tokens: t.tokens.toString(),
      })),
      // The history couldn't be read (the balance could): the chart shows the position without marks.
      historyUnavailable: history === null,
      truncated: history?.truncated ?? false,
    };
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
    await Promise.all(
      [...inFlight].map(async ([signature, f]) => {
        if (now > f.until || (height !== null && height > f.lastValidBlockHeight)) {
          retire(signature, f);
          return;
        }
        const status = await rpc.getSignatureStatus(signature).catch(() => null);
        if (status?.seen) {
          inFlight.delete(signature);
          forgetPositions(f.wallet);
          return;
        }
        await sendViaSender(f.url, f.base64);
      }),
    );
  }
  app.addHook("onClose", async () => {
    if (timer) clearTimeout(timer);
    inFlight.clear();
    retired.clear();
  });
}

/** The pause before a build's one retry, when the chain or Jupiter didn't answer the first. */
const BUILD_RETRY_MS = 800;

/** Lamports as SOL for a message, up to four decimals. */
function solAmount(lamports: bigint): string {
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** The guard's refusal in the trader's words, where it can be said plainly. */
export function plainRefusal(message: string, side: "buy" | "sell" = "buy"): string {
  if (/insufficient lamports/i.test(message))
    return "Not enough SOL in your wallet for this trade and its fees.";
  // Token program error 1 (InsufficientFunds) on a sale is the tokens, not the SOL.
  if (/InsufficientFunds|0x1\b|"Custom":1\}/i.test(message))
    return side === "sell"
      ? "You hold fewer tokens than that sale. Refresh and try again."
      : "Not enough SOL in your wallet for this trade and its fees.";
  if (/6042|6002|6003|0x1771|SlippageToleranceExceeded|under the quoted minimum/i.test(message))
    return "The price moved past your slippage. Try again, or raise the slippage.";
  if (/AccountNotFound/i.test(message)) return "Your wallet has no SOL yet (the account doesn't exist).";
  return `The trade was refused before signing: ${message.replace(/^refused: /, "")}`;
}
