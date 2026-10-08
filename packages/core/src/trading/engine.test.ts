import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import { prisma } from "../db.js";
import { runTradingEngine, type TradingEngineDeps } from "./engine.js";
import { createLocalKeyProvider, generateWalletKeypair } from "./keyVault.js";
import { WSOL_MINT, type SwapClient, type SwapQuote } from "./jupiterSwap.js";
import type { TransactionFill } from "./rpc.js";
import { buildSolTransfer, parseWireTransaction, verifyTransactionSignatures } from "./transaction.js";
import { ensureTradingWallet } from "./wallets.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `trading-test-${Date.now()}`;
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));
const keys = createLocalKeyProvider("ab".repeat(32));
const LAMPORTS = 1_000_000_000n;

/**
 * A pretend chain and a pretend Jupiter. A "swap" is a real, signable transaction (a 1-lamport
 * transfer, unique per build) whose effect the fake swap remembers by its message; simulate
 * reports that effect and send applies it, so the engine's signing, simulation guard, recording
 * and settling all run for real against Postgres.
 */
class FakeChain {
  sol = new Map<string, bigint>();
  tokens = new Map<string, bigint>();
  effects = new Map<string, { wallet: string; mint: string | null; solDelta: bigint; tokenDelta: bigint }>();
  landed = new Map<string, TransactionFill>();
  /** lamports per raw token unit */
  price = new Map<string, number>();
  solUsd = 200;
  drain = false;
  private nonce = 1n;

  tokenKey = (owner: string, mint: string) => `${owner}:${mint}`;

  rpc: TradingEngineDeps["rpc"] = {
    getBalance: async (a) => this.sol.get(a) ?? 0n,
    getBlockHeight: async () => 100,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 200 }),
    simulate: async (b64, wallet) => {
      const effect = this.effects.get(this.messageKey(b64));
      const before = this.sol.get(wallet) ?? 0n;
      return { error: null, lamportsAfter: before + (effect?.solDelta ?? 0n), logs: [] };
    },
    send: async (b64) => {
      const bytes = Buffer.from(b64, "base64");
      expect(verifyTransactionSignatures(bytes)).toBe(true);
      const effect = this.effects.get(this.messageKey(b64))!;
      const signature = bs58.encode(bytes.subarray(1, 65));
      this.sol.set(effect.wallet, (this.sol.get(effect.wallet) ?? 0n) + effect.solDelta);
      if (effect.mint) {
        const k = this.tokenKey(effect.wallet, effect.mint);
        this.tokens.set(k, (this.tokens.get(k) ?? 0n) + effect.tokenDelta);
      }
      this.landed.set(signature, {
        failed: false,
        error: null,
        lamportsDelta: effect.solDelta,
        tokenDelta: effect.tokenDelta,
        decimals: 6,
      });
    },
    getSignatureStatus: async (sig) =>
      this.landed.has(sig) ? { seen: true, confirmed: true, error: null } : { seen: false },
    getTransactionFill: async (sig) => this.landed.get(sig) ?? null,
    getTokenBalance: async (owner, mint) => ({
      raw: this.tokens.get(this.tokenKey(owner, mint)) ?? 0n,
      decimals: 6,
    }),
  };

  private messageKey(b64: string) {
    return Buffer.from(parseWireTransaction(Buffer.from(b64, "base64")).message).toString("base64");
  }

  swap: SwapClient = {
    quote: async ({ inputMint, outputMint, amount }) => {
      const buying = inputMint === WSOL_MINT;
      const mint = buying ? outputMint : inputMint;
      const p = this.price.get(mint)!;
      const out = buying ? BigInt(Math.floor(Number(amount) / p)) : BigInt(Math.floor(Number(amount) * p));
      return {
        inputMint,
        outputMint,
        inAmount: amount.toString(),
        outAmount: out.toString(),
        otherAmountThreshold: "0",
        priceImpactPct: "0",
      } satisfies SwapQuote;
    },
    swapTransaction: async ({ quote, userPublicKey }) => {
      const buying = quote.inputMint === WSOL_MINT;
      const mint = buying ? quote.outputMint : quote.inputMint;
      const tx = buildSolTransfer({
        from: userPublicKey,
        to: generateWalletKeypair().publicKey,
        lamports: this.nonce++,
        recentBlockhash: BLOCKHASH,
      });
      const fee = 10_000n;
      const solDelta = this.drain
        ? -(this.sol.get(userPublicKey) ?? 0n)
        : buying
          ? -BigInt(quote.inAmount) - fee
          : BigInt(quote.outAmount) - fee;
      const tokenDelta = buying ? BigInt(quote.outAmount) : -BigInt(quote.inAmount);
      this.effects.set(Buffer.from(parseWireTransaction(tx).message).toString("base64"), {
        wallet: userPublicKey,
        mint,
        solDelta,
        tokenDelta,
      });
      return { transaction: tx, lastValidBlockHeight: 200 };
    },
    pricesUsd: async (mints) => {
      const out = new Map<string, number>();
      for (const m of mints) {
        if (m === WSOL_MINT) out.set(m, this.solUsd);
        // lamports per raw unit -> USD per whole token (6 decimals)
        else if (this.price.has(m)) out.set(m, (this.price.get(m)! / 1e9) * 1e6 * this.solUsd);
      }
      return out;
    },
  };
}

describe.skipIf(!dbAvailable)("trading engine", () => {
  const admin = `${TAG}-admin`;
  let userId = "";
  let walletKey = "";
  let tokenId = "";
  const mint = `${TAG}-mint`;
  let chain: FakeChain;
  let clock = new Date();
  const deps = (): TradingEngineDeps => ({
    rpc: chain.rpc,
    swap: chain.swap,
    keys,
    canTrade: (w) => w === admin,
    maxBuyLamports: LAMPORTS,
    now: () => clock,
  });

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: admin } })).id;
    walletKey = (await ensureTradingWallet(userId, keys)).publicKey;
    // Idempotent: a second call returns the same wallet.
    expect((await ensureTradingWallet(userId, keys)).publicKey).toBe(walletKey);
    tokenId = (await prisma.token.create({ data: { mintAddress: mint, symbol: "TEST" } })).id;
  });

  beforeEach(() => {
    chain = new FakeChain();
    chain.sol.set(walletKey, LAMPORTS);
    chain.price.set(mint, 0.05); // 0.05 lamports a raw unit: 0.05 SOL buys 1,000 tokens
    clock = new Date();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tradingPosition.deleteMany({ where: { userId } });
    await prisma.tradingWithdrawal.deleteMany({ where: { userId } });
    await prisma.tradingBot.deleteMany({ where: { userId } });
    await prisma.tradingWallet.deleteMany({ where: { userId } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  async function freshSignal() {
    await prisma.tradingPosition.deleteMany({ where: { userId } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "heuristic-v1",
        model: "rules",
        confidence: 80,
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 10_000,
        createdAt: new Date(clock.getTime() - 20_000),
      },
    });
    await prisma.tradingBot.upsert({
      where: { userId },
      create: {
        userId,
        enabled: true,
        signalsFrom: new Date(clock.getTime() - 60_000),
        config: { sources: { models: ["rules"] }, buySol: 0.05 },
      },
      update: {
        enabled: true,
        signalsFrom: new Date(clock.getTime() - 60_000),
        config: { sources: { models: ["rules"] }, buySol: 0.05 },
      },
    });
  }

  const position = () =>
    prisma.tradingPosition.findUniqueOrThrow({ where: { userId_mint: { userId, mint } } });
  const tick = async (minutes = 0) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    return runTradingEngine(deps());
  };

  it("buys a followed model's call, then walks it through the default exit plan", async () => {
    await freshSignal();
    const first = await tick();
    expect(first.buys).toBe(1);
    expect((await position()).status).toBe("buying");

    await tick();
    let p = await position();
    expect(p.status).toBe("open");
    expect(p.tokensBought).toBe("1000000000");
    expect(p.entryLamports).toBe(50_010_000n);

    // 2.1x: half sells at the first rung.
    chain.price.set(mint, 0.105);
    expect((await tick(1)).sells).toBe(1);
    await tick();
    p = await position();
    expect(p.rungsTaken).toBe(1);
    expect(p.tokensHeld).toBe("500000000");
    expect(p.highMultiple).toBeCloseTo(2.1);

    // Runs to 5x (the trail's high), then falls under 3.25x: the rest sells on the trail.
    chain.price.set(mint, 0.25);
    expect((await tick(1)).sells).toBe(0);
    expect((await position()).highMultiple).toBeCloseTo(5);
    chain.price.set(mint, 0.15);
    expect((await tick(1)).sells).toBe(1);
    await tick();
    p = await position();
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("trailing_stop");
    expect(p.tokensHeld).toBe("0");
    // 0.0525 SOL at 2.1x plus 0.075 SOL at 3x, less fees.
    expect(p.proceedsLamports).toBe(52_500_000n - 10_000n + 75_000_000n - 10_000n);
    const orders = await prisma.tradingOrder.findMany({
      where: { positionId: p.id },
      orderBy: { createdAt: "asc" },
    });
    expect(orders.map((o) => [o.side, o.reason, o.status])).toEqual([
      ["buy", "entry", "confirmed"],
      ["sell", "take_profit", "confirmed"],
      ["sell", "trailing_stop", "confirmed"],
    ]);
  });

  it("refuses a swap whose simulation would drain the wallet, and never sends it", async () => {
    await freshSignal();
    chain.drain = true;
    const run = await tick();
    expect(run.buys).toBe(0);
    const p = await position();
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/refused/);
    expect(chain.sol.get(walletKey)).toBe(LAMPORTS);
    expect(await prisma.tradingOrder.count({ where: { positionId: p.id } })).toBe(0);
  });

  it("buys nothing for a wallet that is not an admin, and nothing older than the signal window", async () => {
    await freshSignal();
    const run = await runTradingEngine({ ...deps(), canTrade: () => false });
    expect(run.buys).toBe(0);
    await freshSignal();
    await prisma.tradingBot.update({
      where: { userId },
      data: { config: { sources: { models: ["rules"] }, maxSignalAgeSeconds: 10 } },
    });
    const stale = await tick();
    expect(stale.buys).toBe(0);
    expect(stale.skipped).toBe(1);
  });

  it("fails an entry the worker died before sending, so it stops holding a slot", async () => {
    await freshSignal();
    await prisma.tradingBot.update({ where: { userId }, data: { enabled: false } });
    await prisma.tradingPosition.create({
      data: {
        userId,
        mint,
        sourceKind: "model",
        sourceRef: "rules",
        sourceLabel: "Model: Rules",
        signalAt: clock,
        status: "buying",
        exitPlan: {},
        createdAt: new Date(clock.getTime() - 5 * 60_000),
      },
    });
    await tick();
    const p = await position();
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/never sent/);
  });

  it("lets only one pass run at a time", async () => {
    await freshSignal();
    const [a, b] = await Promise.all([tick(), tick()]);
    expect([a.locked, b.locked].sort()).toEqual([false, true]);
    expect(a.buys + b.buys).toBe(1);
  });

  it("sells everything on request", async () => {
    await freshSignal();
    await tick();
    await tick();
    await prisma.tradingPosition.update({
      where: { userId_mint: { userId, mint } },
      data: { closeRequested: true },
    });
    expect((await tick()).sells).toBe(1);
    await tick();
    const p = await position();
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("manual");
  });

  it("withdraws only to the sign-in wallet", async () => {
    await prisma.tradingBot.update({ where: { userId }, data: { enabled: false } });
    await prisma.tradingWithdrawal.create({ data: { userId, destination: admin, requestedLamports: null } });
    // `admin` is not a real key, so the transfer can't be built: it fails loudly, nothing moves.
    await tick();
    const bad = await prisma.tradingWithdrawal.findFirstOrThrow({ where: { userId } });
    expect(bad.status).toBe("failed");
    expect(chain.sol.get(walletKey)).toBe(LAMPORTS);

    // A real sign-in key: the user's wallet address becomes one, and a request for elsewhere fails.
    const real = generateWalletKeypair().publicKey;
    await prisma.user.update({ where: { id: userId }, data: { walletAddress: real } });
    await prisma.tradingWithdrawal.create({
      data: { userId, destination: "someone-else", requestedLamports: 1n },
    });
    await prisma.tradingWithdrawal.create({ data: { userId, destination: real, requestedLamports: null } });
    // The fake chain applies a transfer through the swap effects map, so register it as such.
    const send = chain.rpc.send;
    chain.rpc.send = async (b64) => {
      const bytes = Buffer.from(b64, "base64");
      const parsed = parseWireTransaction(bytes);
      expect(parsed.accountKeys[1]).toBe(real);
      const amount = Buffer.from(parsed.message.slice(-8)).readBigUInt64LE();
      chain.sol.set(walletKey, chain.sol.get(walletKey)! - amount - 5_000n);
      chain.landed.set(bs58.encode(bytes.subarray(1, 65)), {
        failed: false,
        error: null,
        lamportsDelta: -amount - 5_000n,
        tokenDelta: 0n,
        decimals: null,
      });
    };
    chain.rpc.simulate = async () => ({ error: null, lamportsAfter: 0n, logs: [] });
    await tick();
    await tick();
    chain.rpc.send = send;
    const rows = await prisma.tradingWithdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "confirmed"]);
    expect(rows[2]!.sentLamports).toBe(LAMPORTS - 5_000n);
    expect(chain.sol.get(walletKey)).toBe(0n);
    await prisma.user.update({ where: { id: userId }, data: { walletAddress: admin } });
  });
});
