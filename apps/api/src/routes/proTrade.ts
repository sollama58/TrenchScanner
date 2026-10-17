import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bs58 from "bs58";
import { z } from "zod";
import {
  buildManualTrade,
  decodeMessage,
  isSenderTipAccount,
  JupiterSwapClient,
  looksLikeSolanaAddress,
  parseWireTransaction,
  senderUrl,
  sendViaSender,
  TradeRejected,
  TradingRpc,
  TransientError,
  GuardRefusal,
  NoRouteError,
  RateLimitedError,
  verifyTransactionSignatures,
  walletTokenTrades,
  type Env,
  type WalletTrade,
} from "@trenchscanner/core";
import { isProWallet } from "../proMode.js";
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
  amount: z.string().regex(/^\d{1,20}$/),
  slippageBps: z.number().int().min(10).max(5_000),
  speed: z.enum(["eco", "turbo"]),
});

const sendSchema = z.object({
  transaction: z.string().min(1).max(2_000),
  lastValidBlockHeight: z.number().int().positive(),
  speed: z.enum(["eco", "turbo"]),
  mevProtect: z.boolean(),
});

/** One person clicking: generous for a scalper, tight for anything scripted. */
const BUILD_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };
const SEND_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };
const READ_RATE_LIMIT = { max: 120, timeWindow: "1 minute" };

/** How often an unconfirmed trade is resent to Sender, and for how long at most. */
const RESEND_EVERY_MS = 2_000;
const RESEND_FOR_MS = 75_000;
/** In-flight trades kept for resending at once, across everyone. */
const MAX_IN_FLIGHT = 200;
/** A position read is reused for this long (the panel polls; a trade invalidates it). */
const POSITION_TTL_MS = 4_000;
const SUPPLY_TTL_MS = 10 * 60_000;
/** Parsed transactions kept (they never change), across every wallet and coin. */
const MAX_CACHED_TRADES = 20_000;

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
  const inFlight = new Map<string, InFlight>();

  /** The session's wallet when it has Pro Mode; otherwise answers 404 and returns null. */
  async function proWallet(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const wallet = request.user!.walletAddress;
    if (!(await isProWallet(env, wallet))) {
      reply.code(404).send({ error: "not found" });
      return null;
    }
    return wallet;
  }

  app.addHook("preHandler", app.authenticate);

  app.post("/trade/build", { config: { rateLimit: BUILD_RATE_LIMIT } }, async (request, reply) => {
    const wallet = await proWallet(request, reply);
    if (!wallet) return;
    const parsed = buildSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const body = parsed.data;
    try {
      return await buildManualTrade(
        { rpc, jupiter },
        {
          wallet,
          mint: body.mint,
          side: body.side,
          amount: BigInt(body.amount),
          slippageBps: body.slippageBps,
          speed: body.speed,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TradeRejected || err instanceof NoRouteError)
        return reply.code(422).send({ error: message });
      if (err instanceof GuardRefusal) {
        // The guard's simulation refused it: most often the wallet can't afford it or the price
        // moved past the slippage, which the simulation's error says.
        request.log.warn({ wallet, mint: body.mint, side: body.side, error: message }, "pro trade refused");
        return reply.code(422).send({ error: plainRefusal(message) });
      }
      if (err instanceof TransientError || err instanceof RateLimitedError)
        return reply.code(503).send({ error: "Couldn't reach the chain or Jupiter just now. Try again." });
      request.log.error({ err, wallet, mint: body.mint }, "pro trade build failed");
      return reply.code(502).send({ error: `Couldn't build the trade: ${message}` });
    }
  });

  app.post("/trade/send", { config: { rateLimit: SEND_RATE_LIMIT } }, async (request, reply) => {
    const wallet = await proWallet(request, reply);
    if (!wallet) return;
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const { transaction, lastValidBlockHeight, speed, mevProtect } = parsed.data;
    const bytes = Uint8Array.from(Buffer.from(transaction, "base64"));
    let signature: string;
    try {
      const wire = parseWireTransaction(bytes);
      const message = decodeMessage(wire.message);
      // Only the session's own wallet's transactions, signed by it alone, that pay Sender's tip.
      if (wire.requiredSignatures !== 1 || wire.accountKeys[0] !== wallet)
        return reply.code(400).send({ error: "That transaction isn't from your wallet. Nothing was sent." });
      if (!verifyTransactionSignatures(bytes))
        return reply.code(400).send({ error: "The wallet's signature doesn't verify. Nothing was sent." });
      if (!message.staticKeys.some(isSenderTipAccount))
        return reply.code(400).send({ error: "That transaction doesn't tip Sender. Nothing was sent." });
      signature = bs58.encode(wire.signatures[0]!);
    } catch {
      return reply.code(400).send({ error: "That isn't a transaction this can send. Nothing was sent." });
    }
    const url = senderUrl(env.HELIUS_SENDER_URL, {
      speed,
      mevProtect,
      apiKey: env.HELIUS_API_KEY || undefined,
    });
    const error = await sendViaSender(url, transaction);
    if (error) {
      request.log.warn({ wallet, signature, error }, "sender refused a pro trade");
      // Refused by Sender: nothing went out under this signature (it is safe to build again).
      return reply.code(502).send({ error: `Helius Sender refused the trade: ${error}`, signature });
    }
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
    positions.clear();
    return { signature };
  });

  app.get<{ Params: { signature: string } }>(
    "/trade/status/:signature",
    { config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const wallet = await proWallet(request, reply);
      if (!wallet) return;
      const { signature } = request.params;
      if (!SIGNATURE_RE.test(signature)) return reply.code(400).send({ error: "not a signature" });
      const status = await rpc.getSignatureStatus(signature);
      if (!status) return { state: "unknown" };
      if (!status.seen) {
        // Past its blockhash's life and never seen: it won't land.
        const flight = inFlight.get(signature);
        const height = flight ? await rpc.getBlockHeight() : null;
        if (flight && height !== null && height > flight.lastValidBlockHeight) {
          inFlight.delete(signature);
          return { state: "expired" };
        }
        return { state: "pending" };
      }
      if (status.error) {
        inFlight.delete(signature);
        return { state: "failed", error: status.error };
      }
      if (status.confirmed) {
        inFlight.delete(signature);
        positions.clear();
        return { state: "confirmed" };
      }
      return { state: "pending" };
    },
  );

  app.get<{ Params: { mint: string } }>(
    "/trade/:mint/position",
    { config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const wallet = await proWallet(request, reply);
      if (!wallet) return;
      const { mint } = request.params;
      if (!looksLikeSolanaAddress(mint)) return reply.code(400).send({ error: "not a token address" });
      const key = `${wallet}:${mint}`;
      const cached = positions.get(key);
      if (cached && Date.now() - cached.at < POSITION_TTL_MS) return cached.body;
      const [balance, history, supply, solUsd] = await Promise.all([
        rpc.getTokenBalance(wallet, mint),
        walletTokenTrades(rpc, wallet, mint, tradeCache),
        supplyOf(mint),
        solPrice.get().catch(() => null),
      ]);
      if (!balance) return reply.code(503).send({ error: "Couldn't read your balance just now." });
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
    },
  );

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
          inFlight.delete(signature);
          return;
        }
        const status = await rpc.getSignatureStatus(signature).catch(() => null);
        if (status?.seen) {
          inFlight.delete(signature);
          positions.clear();
          return;
        }
        await sendViaSender(f.url, f.base64);
      }),
    );
  }
  app.addHook("onClose", async () => {
    if (timer) clearTimeout(timer);
    inFlight.clear();
  });
}

/** The guard's refusal in the trader's words, where it can be said plainly. */
export function plainRefusal(message: string): string {
  if (/InsufficientFunds|insufficient lamports|0x1\b|"Custom":1\}/i.test(message))
    return "Not enough SOL in your wallet for this trade and its fees.";
  if (/6042|6002|6003|0x1771|SlippageToleranceExceeded|under the quoted minimum/i.test(message))
    return "The price moved past your slippage. Try again, or raise the slippage.";
  if (/AccountNotFound/i.test(message)) return "Your wallet has no SOL yet (the account doesn't exist).";
  return `The trade was refused before signing: ${message.replace(/^refused: /, "")}`;
}
