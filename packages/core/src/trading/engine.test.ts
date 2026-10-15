import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import { prisma } from "../db.js";
import { feeForRetry, runTradingEngine, withdrawalAmount, type TradingEngineDeps } from "./engine.js";
import { TransientError } from "./errors.js";
import { createLocalKeyProvider, generateWalletKeypair } from "./keyVault.js";
import {
  NoRouteError,
  WSOL_MINT,
  type FallbackSwapClient,
  type SwapClient,
  type SwapQuote,
} from "./jupiterSwap.js";
import type { MintInfo, TransactionFill } from "./rpc.js";
import {
  buildCloseTokenAccount,
  buildLegacyTransaction,
  buildSolTransfer,
  computeBudgetInstructions,
  decodeMessage,
  parseWireTransaction,
  SYSTEM_PROGRAM_ID,
  verifyTransactionSignatures,
} from "./transaction.js";
import { associatedTokenAddress, checkInstructions, PROGRAM, type ParsedAccountState } from "./txGuard.js";
import { ensureTradingWallet } from "./wallets.js";
import { ensureServerWalletAccount } from "./serverWallet.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));
const keys = createLocalKeyProvider("ab".repeat(32));
const LAMPORTS = 1_000_000_000n;

type Effect = {
  wallet: string;
  mint: string | null;
  solDelta: bigint;
  tokenDelta: bigint;
  /** A hostile build: also moves this many of another mint's tokens out of the wallet. */
  steal?: { mint: string; amount: bigint };
  /** A hostile build: reassigns the wallet. */
  reassign?: boolean;
};

/**
 * A pretend chain and a pretend Jupiter. A "swap" is a real, signable transaction (a 1-lamport
 * System transfer, unique per build) whose effect the fake swap remembers by its message;
 * simulate reports that effect on the watched accounts and send applies it, so the engine's
 * guard, signing, recording and settling all run for real against Postgres.
 */
class FakeChain {
  sol = new Map<string, bigint>();
  /** owner:mint -> raw amount, held in the owner's associated account. */
  tokens = new Map<string, bigint>();
  effects = new Map<string, Effect>();
  landed = new Map<string, TransactionFill>();
  sent: string[] = [];
  /** lamports per raw token unit */
  price = new Map<string, number>();
  solUsd = 200;
  hostile: "none" | "drain-sol" | "steal-other" | "reassign" | "skim" = "none";
  /** Token balance reads lag: they return the balance from before the last transaction, once. */
  lagOnce = false;
  private lastBalance = new Map<string, bigint>();
  jupiterNoRoute = false;
  height = 100;
  /** What a mint read returns: a Pump.fun-style Token-2022 mint unless overridden. */
  mintInfo: (mint: string) => MintInfo | null = () => ({
    program: PROGRAM.token2022,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: ["metadataPointer", "tokenMetadata"],
  });
  /** The program the RPC claims owns the wallet's token accounts (a hostile RPC lies here). */
  reportedTokenProgram: string = PROGRAM.token;
  /** Mints the PumpPortal stand-in will build for. */
  fallbackMints = new Set<string>();
  /** Signatures the "network" drops (sent, but never land). */
  drop = false;
  /** This many sends land but fail on chain (the fee is paid, nothing else happens). */
  failOnChain = 0;
  /** The priority fee (lamports) a build sets when not told one: the route's "estimate". */
  estimateFee = 20_000n;
  /** The exact priority fee each swap build was asked for (undefined: the estimate). */
  feeRequests: (number | undefined)[] = [];
  private nonce = 1n;

  key = (owner: string, mint: string) => `${owner}:${mint}`;
  ata = (owner: string, mint: string) => associatedTokenAddress(owner, mint, PROGRAM.token);

  /** The state of every watched account, with an effect applied or not. */
  private state(addresses: string[], effect?: Effect): (ParsedAccountState | null)[] {
    return addresses.map((address) => {
      if (this.sol.has(address)) {
        const lamports =
          this.sol.get(address)! + (effect && effect.wallet === address ? effect.solDelta : 0n);
        const owner =
          effect?.reassign && effect.wallet === address
            ? "Attacker1111111111111111111111111111111111"
            : SYSTEM_PROGRAM_ID;
        return { lamports, owner, token: null };
      }
      for (const [k, amount] of this.tokens) {
        const [owner, mint] = k.split(":") as [string, string];
        if (this.ata(owner, mint) !== address) continue;
        let after = amount;
        if (effect && effect.wallet === owner && effect.mint === mint) after += effect.tokenDelta;
        if (effect?.steal && effect.wallet === owner && effect.steal.mint === mint)
          after -= effect.steal.amount;
        return {
          lamports: 2_039_280n,
          owner: PROGRAM.token,
          token: { mint, owner, amount: after, delegate: null, closeAuthority: null, state: "initialized" },
        };
      }
      // An account the swap would create.
      if (effect?.mint && this.ata(effect.wallet, effect.mint) === address && effect.tokenDelta > 0n) {
        return {
          lamports: 2_039_280n,
          owner: PROGRAM.token,
          token: {
            mint: effect.mint,
            owner: effect.wallet,
            amount: effect.tokenDelta,
            delegate: null,
            closeAuthority: null,
            state: "initialized",
          },
        };
      }
      return null;
    });
  }

  private effectOf(b64: string) {
    return this.effects.get(
      Buffer.from(parseWireTransaction(Buffer.from(b64, "base64")).message).toString("base64"),
    );
  }

  rpc: TradingEngineDeps["rpc"] = {
    getBalance: async (a) => this.sol.get(a) ?? 0n,
    getBlockHeight: async () => this.height,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: this.height + 150 }),
    getAccountsData: async (addresses) => addresses.map(() => null),
    getParsedAccounts: async (addresses) => this.state(addresses),
    simulateParsed: async (b64, addresses) => ({
      error: null,
      logs: [],
      accounts: this.state(addresses, this.effectOf(b64)),
    }),
    send: async (b64) => {
      const bytes = Buffer.from(b64, "base64");
      expect(verifyTransactionSignatures(bytes)).toBe(true);
      const signature = bs58.encode(bytes.subarray(1, 65));
      this.sent.push(signature);
      if (this.drop || this.landed.has(signature)) return null;
      const effect = this.effectOf(b64);
      if (!effect) return null;
      if (this.failOnChain > 0) {
        this.failOnChain--;
        this.sol.set(effect.wallet, (this.sol.get(effect.wallet) ?? 0n) - 10_000n);
        this.landed.set(signature, {
          failed: true,
          error: '{"InstructionError":[2,{"Custom":6001}]}',
          lamportsDelta: -10_000n,
          tokenDelta: 0n,
          decimals: null,
          blockTime: null,
        });
        return null;
      }
      this.sol.set(effect.wallet, (this.sol.get(effect.wallet) ?? 0n) + effect.solDelta);
      if (effect.mint) {
        const k = this.key(effect.wallet, effect.mint);
        this.lastBalance.set(k, this.tokens.get(k) ?? 0n);
        this.tokens.set(k, (this.tokens.get(k) ?? 0n) + effect.tokenDelta);
      }
      this.landed.set(signature, {
        failed: false,
        error: null,
        lamportsDelta: effect.solDelta,
        tokenDelta: effect.tokenDelta,
        decimals: 6,
        blockTime: null,
      });
      return null;
    },
    getSignatureStatus: async (sig) => {
      const fill = this.landed.get(sig);
      return fill ? { seen: true, confirmed: true, error: fill.error } : { seen: false };
    },
    getTransactionFill: async (sig) => this.landed.get(sig) ?? null,
    getMintInfo: async (mint) => this.mintInfo(mint),
    getPriorityFeeEstimate: async () => 0n,
    getTokenBalance: async (owner, mint) => {
      let raw = this.tokens.get(this.key(owner, mint));
      if (this.lagOnce && this.lastBalance.has(this.key(owner, mint))) {
        this.lagOnce = false;
        raw = this.lastBalance.get(this.key(owner, mint));
      }
      return {
        raw: raw ?? 0n,
        decimals: 6,
        accounts:
          raw === undefined
            ? []
            : [{ address: this.ata(owner, mint), programId: this.reportedTokenProgram, raw }],
      };
    },
  };

  /** Registers a built transaction's effect under its message. */
  private register(
    userPublicKey: string,
    mint: string,
    buying: boolean,
    inAmount: bigint,
    outAmount: bigint,
    feeLamports: bigint = this.estimateFee,
  ) {
    // Shaped like a real swap: one call to the aggregator listing the token accounts it moves.
    // A hostile "skim" instead sends the trade's worth to a stranger with a System transfer.
    const other = [...this.tokens.keys()].find(
      (k) => k.startsWith(`${userPublicKey}:`) && !k.endsWith(`:${mint}`),
    );
    const tx =
      this.hostile === "skim"
        ? buildSolTransfer({
            from: userPublicKey,
            to: generateWalletKeypair().publicKey,
            lamports: 50_000_000n + this.nonce++,
            recentBlockhash: BLOCKHASH,
          })
        : buildLegacyTransaction(userPublicKey, BLOCKHASH, [
            // The priority fee as a route sets it: 100,000 units at fee x 10 micro-lamports.
            ...computeBudgetInstructions(100_000, feeLamports * 10n),
            {
              programId: PROGRAM.jupiterV6,
              accounts: [
                { pubkey: this.ata(userPublicKey, mint), writable: true },
                ...(other ? [{ pubkey: this.ata(userPublicKey, other.split(":")[1]!), writable: true }] : []),
                { pubkey: generateWalletKeypair().publicKey, writable: true },
              ],
              data: [Number(this.nonce++ % 256n)],
            },
          ]);
    const fee = 10_000n;
    const effect: Effect = {
      wallet: userPublicKey,
      mint,
      solDelta: buying ? -inAmount - fee : outAmount - fee,
      tokenDelta: buying ? outAmount : -inAmount,
    };
    if (this.hostile === "drain-sol") effect.solDelta = -(this.sol.get(userPublicKey) ?? 0n);
    if (this.hostile === "reassign") effect.reassign = true;
    if (this.hostile === "steal-other") {
      const other = [...this.tokens.keys()].find(
        (k) => k.startsWith(`${userPublicKey}:`) && !k.endsWith(`:${mint}`),
      );
      if (other) effect.steal = { mint: other.split(":")[1]!, amount: this.tokens.get(other)! };
    }
    this.effects.set(Buffer.from(parseWireTransaction(tx).message).toString("base64"), effect);
    return tx;
  }

  private out(mint: string, buying: boolean, amount: bigint) {
    const p = this.price.get(mint)!;
    return buying ? BigInt(Math.floor(Number(amount) / p)) : BigInt(Math.floor(Number(amount) * p));
  }

  swap: SwapClient = {
    quote: async ({ inputMint, outputMint, amount }) => {
      if (this.jupiterNoRoute) throw new NoRouteError("no route");
      const buying = inputMint === WSOL_MINT;
      const out = this.out(buying ? outputMint : inputMint, buying, amount);
      return {
        inputMint,
        outputMint,
        inAmount: amount.toString(),
        outAmount: out.toString(),
        otherAmountThreshold: ((out * 85n) / 100n).toString(),
        priceImpactPct: "0",
      } satisfies SwapQuote;
    },
    swapTransaction: async ({ quote, userPublicKey, priorityFeeLamports }) => {
      const buying = quote.inputMint === WSOL_MINT;
      const mint = buying ? quote.outputMint : quote.inputMint;
      this.feeRequests.push(priorityFeeLamports);
      return {
        transaction: this.register(
          userPublicKey,
          mint,
          buying,
          BigInt(quote.inAmount),
          BigInt(quote.outAmount),
          priorityFeeLamports !== undefined ? BigInt(priorityFeeLamports) : this.estimateFee,
        ),
        lastValidBlockHeight: this.height + 150,
      };
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

  fallback: FallbackSwapClient = {
    handles: (mint) => this.fallbackMints.has(mint),
    build: async ({ side, mint, wallet, amount }) => ({
      transaction: this.register(
        wallet,
        mint,
        side === "buy",
        amount,
        this.out(mint, side === "buy", amount),
      ),
      lastValidBlockHeight: null,
    }),
  };
}

describe.skipIf(!dbAvailable)("trading engine", () => {
  const admin = generateWalletKeypair().publicKey;
  let userId = "";
  let walletKey = "";
  let tokenId = "";
  // Real addresses: the guard derives the wallet's token accounts from them.
  const mint = generateWalletKeypair().publicKey;
  let chain: FakeChain;
  let clock = new Date();
  const deps = (): TradingEngineDeps => ({
    rpc: chain.rpc,
    swap: chain.swap,
    fallback: chain.fallback,
    keys,
    canTrade: (w) => w === admin,
    maxBuyLamports: LAMPORTS,
    now: () => clock,
  });

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: admin } })).id;
    walletKey = (await ensureTradingWallet(userId, admin, keys)).publicKey;
    // Idempotent: a second call returns the same wallet.
    expect((await ensureTradingWallet(userId, admin, keys)).publicKey).toBe(walletKey);
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
    await prisma.token.deleteMany({ where: { id: tokenId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function freshSignal(config: object = {}) {
    await prisma.tradingPosition.deleteMany({ where: { userId } });
    await prisma.tradingWithdrawal.deleteMany({ where: { userId } });
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
    const data = {
      enabled: true,
      signalsFrom: new Date(clock.getTime() - 60_000),
      config: { sources: { models: ["rules"] }, buySol: 0.05, ...config },
    };
    await prisma.tradingBot.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  const position = () =>
    prisma.tradingPosition.findUniqueOrThrow({ where: { userId_mint: { userId, mint } } });
  const tick = async (minutes = 0) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    return runTradingEngine(deps());
  };
  const opened = async () => {
    await freshSignal();
    expect((await tick()).buys).toBe(1);
    await tick();
    expect((await position()).status).toBe("open");
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
    expect(orders.map((o) => [o.side, o.reason, o.status, o.route])).toEqual([
      ["buy", "entry", "confirmed", "jupiter"],
      ["sell", "take_profit", "confirmed", "jupiter"],
      ["sell", "trailing_stop", "confirmed", "jupiter"],
    ]);

    // Half a minute after closing, the emptied token account is closed for its rent.
    expect((await tick(1)).reclaimed).toBe(1);
  });

  it("refuses swaps whose simulation drains SOL, empties another position, or reassigns the wallet", async () => {
    const other = generateWalletKeypair().publicKey;
    chain.tokens.set(chain.key(walletKey, other), 777n);
    for (const hostile of ["drain-sol", "steal-other", "reassign"] as const) {
      await freshSignal();
      chain.hostile = hostile;
      const run = await tick();
      expect(run.buys).toBe(0);
      const p = await position();
      expect(p.status).toBe("failed");
      expect(p.error).toMatch(/refused/);
      expect(chain.sent).toHaveLength(0);
      expect(await prisma.tradingOrder.count({ where: { positionId: p.id } })).toBe(0);
    }
    expect(chain.sol.get(walletKey)).toBe(LAMPORTS);
  });

  it("refuses a fallback build that skims the trade with an extra SOL transfer", async () => {
    await freshSignal();
    chain.jupiterNoRoute = true;
    chain.fallbackMints.add(mint);
    chain.hostile = "skim";
    expect((await tick()).buys).toBe(0);
    const p = await position();
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/to others/);
    expect(chain.sent).toHaveLength(0);
  });

  it("does not count a missing price toward stuck, and still closes at the hold cap", async () => {
    await opened();
    chain.swap.pricesUsd = async () => new Map([[WSOL_MINT, 200]]);
    chain.jupiterNoRoute = true; // no quote either: no price at all
    chain.fallbackMints.add(mint); // ...but the fallback can still sell
    await tick(1);
    let p = await position();
    expect(p.status).toBe("open");
    expect(p.failCount).toBe(0);
    expect(p.error).toMatch(/no price/);
    // Past the 30-minute cap for a position that never sold: out by the clock.
    expect((await tick(31)).sells).toBe(1);
    await tick();
    p = await position();
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("max_hold");
  });

  it("does not let a lagging balance read undo a confirmed sale", async () => {
    await opened();
    chain.price.set(mint, 0.105);
    expect((await tick(1)).sells).toBe(1);
    chain.lagOnce = true; // the settle's read sees the balance from before the sale
    await tick();
    const p = await position();
    expect(p.rungsTaken).toBe(1);
    expect(p.tokensHeld).toBe("500000000");
    // ...so the same rung is not sold again.
    expect((await tick(1)).sells).toBe(0);
  });

  it("reopens a closed position whose tokens turn up in the wallet", async () => {
    await opened();
    await prisma.tradingPosition.update({
      where: { userId_mint: { userId, mint } },
      data: {
        status: "closed",
        closedAt: new Date(clock.getTime() - 5 * 60_000),
        closeReason: "manual",
        tokensHeld: "0",
      },
    });
    const run = await tick();
    expect(run.recovered).toBe(1);
    const p = await position();
    expect(p.status).toBe("open");
    expect(p.tokensHeld).toBe("1000000000");
  });

  it("refuses to buy a token whose mint is risky", async () => {
    const risky: MintInfo[] = [
      { program: PROGRAM.token, mintAuthority: admin, freezeAuthority: null, extensions: [] },
      { program: PROGRAM.token, mintAuthority: null, freezeAuthority: admin, extensions: [] },
      {
        program: PROGRAM.token2022,
        mintAuthority: null,
        freezeAuthority: null,
        extensions: ["tokenMetadata", "permanentDelegate"],
      },
    ];
    for (const info of risky) {
      await freshSignal();
      chain.mintInfo = () => info;
      const run = await tick();
      expect(run.buys).toBe(0);
      expect(run.skipped).toBe(1);
      expect(await prisma.tradingPosition.count({ where: { userId } })).toBe(0);
    }
  });

  it("retries an entry that hit a transient failure while the signal is fresh", async () => {
    await freshSignal();
    const height = chain.rpc.getBlockHeight;
    chain.rpc.getBlockHeight = async () => null; // the RPC hiccups mid-entry
    expect((await tick()).buys).toBe(0);
    let p = await position();
    expect(p.status).toBe("buying");
    expect(p.failCount).toBe(1);
    expect(p.error).toMatch(/block height/);
    expect(chain.sent).toHaveLength(0);
    chain.rpc.getBlockHeight = height;
    // A few seconds later the retry goes out - at the route's own fee: nothing was sent before.
    expect((await tick(0.1)).buys).toBe(1);
    await tick();
    p = await position();
    expect(p.status).toBe("open");
    expect(p.failCount).toBe(0);
    // Built twice (the first build was never sent), both at the estimate.
    expect(chain.feeRequests).toEqual([undefined, undefined]);
  });

  it("gives up an entry that keeps failing before it is sent, freeing the token for a later signal", async () => {
    await freshSignal();
    chain.rpc.getBlockHeight = async () => null;
    await tick();
    // Past the signal's age limit (90s) and the retry grace (2 min): given up, and gone.
    await tick(4);
    expect(await prisma.tradingPosition.count({ where: { userId } })).toBe(0);
    expect(chain.sent).toHaveLength(0);
  });

  it("does not count a dependency that didn't answer against an exit", async () => {
    await opened();
    chain.price.set(mint, 0.02); // under the stop
    const height = chain.rpc.getBlockHeight;
    chain.rpc.getBlockHeight = async () => null;
    await tick(1);
    const p = await position();
    expect(p.status).toBe("open");
    expect(p.failCount).toBe(0);
    expect(p.error).toMatch(/block height/);
    expect(p.nextAttemptAt!.getTime() - clock.getTime()).toBeLessThanOrEqual(5_000);
    chain.rpc.getBlockHeight = height;
    expect((await tick(0.1)).sells).toBe(1);
  });

  it("refuses a sale that would take SOL from the wallet, and retries it", async () => {
    await opened();
    chain.price.set(mint, 0.02); // under the stop
    chain.hostile = "drain-sol";
    await tick(1);
    const p = await position();
    expect(p.status).toBe("open");
    expect(p.error).toMatch(/refused/);
    expect(p.failCount).toBe(1);
    expect(chain.sol.get(walletKey)).toBe(LAMPORTS - 50_010_000n);
  });

  it("closes token accounts only under a real token program", async () => {
    await opened();
    await prisma.tradingPosition.update({
      where: { userId_mint: { userId, mint } },
      data: { closeRequested: true },
    });
    await tick();
    await tick();
    expect((await position()).status).toBe("closed");
    chain.reportedTokenProgram = generateWalletKeypair().publicKey; // a hostile RPC's answer
    const sentBefore = chain.sent.length;
    expect((await tick(1)).reclaimed).toBe(0);
    expect(chain.sent.length).toBe(sentBefore);
  });

  it("reports open positions it has no key to manage", async () => {
    await opened();
    const run = await runTradingEngine({ ...deps(), keys: null });
    expect(run.failedStages).toContain("exits");
    expect((await position()).error).toMatch(/no key/);
  });

  it("falls back to PumpPortal when Jupiter has no route for a Pump.fun token", async () => {
    await freshSignal();
    chain.jupiterNoRoute = true;
    chain.fallbackMints.add(mint);
    expect((await tick()).buys).toBe(1);
    await tick();
    const p = await position();
    expect(p.status).toBe("open");
    const [order] = await prisma.tradingOrder.findMany({ where: { positionId: p.id } });
    expect(order!.route).toBe("pumpportal");
  });

  it("rebroadcasts a pending transaction, and recovers a buy whose status never showed but whose tokens arrived", async () => {
    await freshSignal();
    chain.drop = true;
    await tick();
    await tick();
    expect(chain.sent.length).toBeGreaterThanOrEqual(2); // the send, then a rebroadcast
    expect((await position()).status).toBe("buying");
    // Past expiry (plus margin), with the tokens somehow in the wallet: recovered, not failed.
    chain.tokens.set(chain.key(walletKey, mint), 1_000_000_000n);
    chain.height += 150 + 40;
    const run = await tick();
    expect(run.recovered).toBe(1);
    const p = await position();
    expect(p.status).toBe("open");
    expect(p.tokensBought).toBe("1000000000");
  });

  it("retries a buy that expired unlanded, doubling the fee it paid", async () => {
    await freshSignal();
    chain.drop = true;
    await tick();
    // Past expiry with nothing in the wallet: written off as a try, and tried again at once.
    chain.height += 150 + 40;
    chain.drop = false;
    expect((await tick()).buys).toBe(1);
    await tick();
    const p = await position();
    expect(p.status).toBe("open");
    const orders = await prisma.tradingOrder.findMany({
      where: { positionId: p.id },
      orderBy: { createdAt: "asc" },
    });
    expect(orders.map((o) => [o.status, o.priorityFeeLamports])).toEqual([
      ["expired", 20_000n],
      // Double what never landed, at least 0.0001 SOL.
      ["confirmed", 100_000n],
    ]);
    expect(chain.feeRequests).toEqual([undefined, 100_000]);
  });

  it("gives up a buy that keeps expiring, raising the fee each try up to the cap", async () => {
    await freshSignal({ maxPriorityFeeSol: 0.0003 });
    chain.drop = true;
    await tick();
    for (let i = 0; i < 4; i++) {
      chain.height += 150 + 40;
      await tick();
    }
    const p = await position();
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/failed 4 times/);
    const fees = (
      await prisma.tradingOrder.findMany({ where: { positionId: p.id }, orderBy: { createdAt: "asc" } })
    ).map((o) => o.priorityFeeLamports);
    expect(fees).toEqual([20_000n, 100_000n, 200_000n, 300_000n]);
  });

  it("retries a buy that failed on chain, but not at a price that ran past the slippage", async () => {
    await freshSignal();
    chain.failOnChain = 1;
    await tick();
    await tick(); // settles the failure; the retry waits a few seconds
    let p = await position();
    expect(p.status).toBe("buying");
    expect(p.failCount).toBe(1);
    expect(p.proceedsLamports).toBe(-10_000n); // the failed try's fee
    // It landed, so the fee was enough: the retry isn't raised.
    expect((await tick(0.1)).buys).toBe(1);
    await tick();
    expect((await position()).status).toBe("open");
    expect(chain.feeRequests).toEqual([undefined, undefined]);

    // Again, but the price runs 40% before the retry: 15% slippage allows no chase that far.
    await freshSignal();
    chain.tokens.clear();
    chain.failOnChain = 1;
    await tick();
    await tick();
    chain.price.set(mint, 0.07);
    await tick(0.1);
    p = await position();
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/price ran/);
  });

  it("backs off an exit it cannot sell, then calls it stuck and frees the slot", async () => {
    await opened();
    chain.price.set(mint, 0.02); // under the stop
    chain.jupiterNoRoute = true;
    chain.fallback = { handles: () => false, build: async () => Promise.reject(new Error("unused")) };
    await tick(1);
    let p = await position();
    expect(p.failCount).toBe(1);
    expect(p.nextAttemptAt!.getTime()).toBeGreaterThan(clock.getTime());
    // Inside the backoff nothing is tried.
    expect((await tick()).exitsChecked).toBe(0);
    await tick(1);
    await tick(1);
    p = await position();
    expect(p.status).toBe("stuck");
    expect(p.failCount).toBe(3);
  });

  it("buys nothing for a wallet that is not an admin, nothing too old, and nothing past the server's spend cap", async () => {
    await freshSignal();
    expect((await runTradingEngine({ ...deps(), canTrade: () => false })).buys).toBe(0);
    await freshSignal({ maxSignalAgeSeconds: 10 });
    const stale = await tick();
    expect(stale.buys).toBe(0);
    expect(stale.skipped).toBe(1);
    await freshSignal();
    const capped = await runTradingEngine({ ...deps(), maxDailySpendLamports: 10_000_000n });
    expect(capped.buys).toBe(0);
  });

  it("drops an entry the worker died before sending once the bot is off, so it stops holding a slot", async () => {
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
    // Nothing was ever sent: no trace left, and a later signal may still buy the token.
    expect(await prisma.tradingPosition.count({ where: { userId } })).toBe(0);
    expect(chain.sent).toHaveLength(0);
  });

  it("raises the fee on a sale that expired unlanded", async () => {
    await opened();
    chain.price.set(mint, 0.02); // under the stop
    chain.drop = true;
    expect((await tick(1)).sells).toBe(1);
    chain.height += 150 + 40;
    chain.drop = false;
    expect((await tick()).sells).toBe(1);
    await tick();
    const p = await position();
    expect(p.status).toBe("closed");
    expect(p.failCount).toBe(0);
    const sells = await prisma.tradingOrder.findMany({
      where: { positionId: p.id, side: "sell" },
      orderBy: { createdAt: "asc" },
    });
    expect(sells.map((o) => [o.status, o.priorityFeeLamports])).toEqual([
      ["expired", 20_000n],
      ["confirmed", 100_000n],
    ]);
  });

  it("lets only one pass run at a time", async () => {
    await freshSignal();
    const [a, b] = await Promise.all([tick(), tick()]);
    expect([a.locked, b.locked].sort()).toEqual([false, true]);
    expect(a.buys + b.buys).toBe(1);
  });

  it("sells everything on request, even when the token can't be priced", async () => {
    await opened();
    chain.swap.pricesUsd = async () => new Map();
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

  it("withdraws only to the address sealed into the wallet, keeping a reserve while positions are open", async () => {
    await opened();
    await prisma.tradingBot.update({ where: { userId }, data: { enabled: false } });
    // A row pointing somewhere else (as if the database were tampered with) is refused.
    await prisma.tradingWithdrawal.create({
      data: { userId, destination: "someone-else", requestedLamports: 1_000_000n },
    });
    // "max" with a position open leaves the reserve (0.02 SOL by default) behind.
    await prisma.tradingWithdrawal.create({ data: { userId, destination: admin, requestedLamports: null } });
    const send = chain.rpc.send;
    chain.rpc.send = async (b64) => {
      const bytes = Buffer.from(b64, "base64");
      const parsed = parseWireTransaction(bytes);
      if (parsed.accountKeys.includes(SYSTEM_PROGRAM_ID) && parsed.accountKeys[1] === admin) {
        const amount = Buffer.from(parsed.message.slice(-8)).readBigUInt64LE();
        // The base fee, and the priority fee: 2,000 units at the 200,000 micro-lamport floor.
        chain.sol.set(walletKey, chain.sol.get(walletKey)! - amount - 5_400n);
        chain.landed.set(bs58.encode(bytes.subarray(1, 65)), {
          failed: false,
          error: null,
          lamportsDelta: -amount - 5_400n,
          tokenDelta: 0n,
          decimals: null,
          blockTime: null,
        });
        return null;
      }
      return send(b64);
    };
    const before = chain.sol.get(walletKey)!;
    await tick();
    await tick();
    chain.rpc.send = send;
    const rows = await prisma.tradingWithdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["failed", "confirmed"]);
    expect(rows[1]!.sentLamports).toBe(before - 5_400n - 20_000_000n);
    expect(chain.sol.get(walletKey)).toBe(20_000_000n);
  });

  it("resends a withdrawal that expired unlanded with a higher fee, a few times", async () => {
    await prisma.tradingPosition.deleteMany({ where: { userId } });
    await prisma.tradingWithdrawal.deleteMany({ where: { userId } });
    await prisma.tradingBot.update({ where: { userId }, data: { enabled: false } });
    await prisma.tradingWithdrawal.create({
      data: { userId, destination: admin, requestedLamports: 1_000_000n },
    });
    const prices: bigint[] = [];
    chain.rpc.send = async (b64) => {
      const decoded = decodeMessage(parseWireTransaction(Buffer.from(b64, "base64")).message);
      prices.push(checkInstructions(decoded, decoded.staticKeys, walletKey).priorityFeeLamports);
      return null; // never lands
    };
    await tick();
    for (let i = 0; i < 3; i++) {
      chain.height += 150 + 40;
      await tick();
    }
    const [w] = await prisma.tradingWithdrawal.findMany({ where: { userId } });
    expect(w!.status).toBe("failed");
    expect(w!.attempts).toBe(2);
    expect(w!.error).toMatch(/3 times/);
    // Sent three times (rebroadcasts aside), each paying double the last.
    expect([...new Set(prices)]).toEqual([400n, 800n, 1_600n]);
  });

  it("will not open a wallet whose sealed withdrawal address was changed in the database", async () => {
    await prisma.tradingWithdrawal.deleteMany({ where: { userId } });
    await prisma.tradingBot.update({ where: { userId }, data: { enabled: false } });
    const thief = generateWalletKeypair().publicKey;
    await prisma.tradingWallet.update({ where: { userId }, data: { withdrawTo: thief } });
    await prisma.user.update({ where: { id: userId }, data: { walletAddress: thief } });
    await prisma.tradingWithdrawal.create({ data: { userId, destination: thief, requestedLamports: null } });
    await tick();
    const [w] = await prisma.tradingWithdrawal.findMany({ where: { userId } });
    expect(w!.status).toBe("failed");
    expect(w!.signature).toBeNull();
    expect(chain.sent).toHaveLength(0);
    await prisma.tradingWallet.update({ where: { userId }, data: { withdrawTo: admin } });
    await prisma.user.update({ where: { id: userId }, data: { walletAddress: admin } });
  });
});

describe("retry fees", () => {
  it("leaves the first try to the route's estimate, and doubles a try that never landed, up to the cap", () => {
    expect(feeForRetry(2_000_000n, null)).toBeUndefined();
    expect(feeForRetry(2_000_000n, { status: "confirmed", priorityFeeLamports: 50_000n })).toBeUndefined();
    // Landed and failed: the fee was enough to land.
    expect(feeForRetry(2_000_000n, { status: "failed", priorityFeeLamports: 50_000n })).toBeUndefined();
    expect(feeForRetry(2_000_000n, { status: "expired", priorityFeeLamports: 300_000n })).toBe(600_000n);
    expect(feeForRetry(2_000_000n, { status: "expired", priorityFeeLamports: 10_000n })).toBe(100_000n);
    expect(feeForRetry(2_000_000n, { status: "expired", priorityFeeLamports: 1_500_000n })).toBe(2_000_000n);
    expect(feeForRetry(2_000_000n, { status: "expired", priorityFeeLamports: null })).toBe(1_000_000n);
    expect(feeForRetry(0n, { status: "expired", priorityFeeLamports: 10_000n })).toBeUndefined();
  });

  it("sizes a withdrawal around its priority fee", () => {
    expect(withdrawalAmount(1_000_000_000n, null, 0n, 400n)).toEqual({ lamports: 1_000_000_000n - 5_400n });
    expect(withdrawalAmount(10_000n, 4_000n, 0n, 1_000n)).toEqual({ lamports: 4_000n });
    expect(withdrawalAmount(10_000n, 5_000n, 0n, 1_000n)).toHaveProperty("error");
  });

  it("marks a dependency's failure transient", () => {
    expect(new TransientError("x")).toBeInstanceOf(Error);
  });
});

describe("a legacy transaction", () => {
  it("prices a transfer and a close with compute-budget instructions the guard reads", () => {
    const payer = generateWalletKeypair().publicKey;
    const to = generateWalletKeypair().publicKey;
    const transfer = buildSolTransfer({
      from: payer,
      to,
      lamports: 1_000n,
      recentBlockhash: BLOCKHASH,
      microLamportsPerUnit: 500_000n,
    });
    let decoded = decodeMessage(parseWireTransaction(transfer).message);
    expect(decoded.staticKeys).toEqual([
      payer,
      to,
      "ComputeBudget111111111111111111111111111111",
      SYSTEM_PROGRAM_ID,
    ]);
    // 2,000 units at 500,000 micro-lamports: 1,000 lamports.
    expect(checkInstructions(decoded, decoded.staticKeys, payer)).toEqual({
      externalLamports: 1_000n,
      priorityFeeLamports: 1_000n,
    });
    const account = generateWalletKeypair().publicKey;
    const close = buildCloseTokenAccount({
      owner: payer,
      account,
      tokenProgram: PROGRAM.token,
      recentBlockhash: BLOCKHASH,
      microLamportsPerUnit: 100_000n,
    });
    decoded = decodeMessage(parseWireTransaction(close).message);
    expect(decoded.instructions).toHaveLength(3);
    // 6,000 units at 100,000 micro-lamports: 600 lamports.
    expect(checkInstructions(decoded, decoded.staticKeys, payer).priorityFeeLamports).toBe(600n);
    // No price: just the instruction itself, as before.
    expect(
      decodeMessage(
        parseWireTransaction(buildSolTransfer({ from: payer, to, lamports: 1n, recentBlockhash: BLOCKHASH }))
          .message,
      ).instructions,
    ).toHaveLength(1);
  });

  it("lays out payer, writable, then read-only accounts", () => {
    const payer = generateWalletKeypair().publicKey;
    const other = generateWalletKeypair().publicKey;
    const tx = buildLegacyTransaction(payer, BLOCKHASH, {
      programId: PROGRAM.token,
      accounts: [
        { pubkey: other, writable: true },
        { pubkey: payer, writable: true },
        { pubkey: payer, writable: false },
      ],
      data: [9],
    });
    expect(parseWireTransaction(tx).accountKeys).toEqual([payer, other, PROGRAM.token]);
  });
});

describe.skipIf(!dbAvailable)("the server wallet", () => {
  const server = generateWalletKeypair();
  const destination = generateWalletKeypair().publicKey;
  let serverId = "";
  let tokenId = "";
  const mint = generateWalletKeypair().publicKey;
  let chain: FakeChain;
  const deps = (withdrawTo: string | null = destination): TradingEngineDeps => ({
    rpc: chain.rpc,
    swap: chain.swap,
    fallback: chain.fallback,
    keys,
    // No admin wallets at all: the server bot trades regardless, its settings being admins' only.
    canTrade: () => false,
    maxBuyLamports: LAMPORTS,
    serverWallet: { userId: serverId, publicKey: server.publicKey, seed: server.seed, withdrawTo },
  });

  beforeAll(async () => {
    serverId = await ensureServerWalletAccount();
    expect(await ensureServerWalletAccount()).toBe(serverId);
    tokenId = (await prisma.token.create({ data: { mintAddress: mint, symbol: "SRV" } })).id;
  });
  beforeEach(() => {
    chain = new FakeChain();
    chain.sol.set(server.publicKey, LAMPORTS);
    chain.price.set(mint, 0.05);
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tradingPosition.deleteMany({ where: { userId: serverId } });
    await prisma.tradingWithdrawal.deleteMany({ where: { userId: serverId } });
    await prisma.tradingBot.deleteMany({ where: { userId: serverId } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.token.deleteMany({ where: { id: tokenId } });
  });

  it("trades from the key in the environment", async () => {
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "heuristic-v1",
        model: "rules",
        confidence: 80,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1,
        createdAt: new Date(Date.now() - 20_000),
      },
    });
    const data = {
      enabled: true,
      signalsFrom: new Date(Date.now() - 60_000),
      config: { sources: { models: ["rules"] }, buySol: 0.05 },
    };
    await prisma.tradingBot.upsert({
      where: { userId: serverId },
      create: { userId: serverId, ...data },
      update: data,
    });
    expect((await runTradingEngine(deps())).buys).toBe(1);
    await runTradingEngine(deps());
    const p = await prisma.tradingPosition.findUniqueOrThrow({
      where: { userId_mint: { userId: serverId, mint } },
    });
    expect(p.status).toBe("open");
    // Signed by the server key: the fake chain verified the signature on send.
    expect(chain.sent.length).toBeGreaterThanOrEqual(1);
  });

  it("withdraws only to the configured address, and not at all without one", async () => {
    await prisma.tradingBot.update({ where: { userId: serverId }, data: { enabled: false } });
    await prisma.tradingPosition.deleteMany({ where: { userId: serverId } });
    await prisma.tradingWithdrawal.create({
      data: { userId: serverId, destination, requestedLamports: 100_000_000n },
    });
    await runTradingEngine(deps(null));
    let rows = await prisma.tradingWithdrawal.findMany({ where: { userId: serverId } });
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/withdrawals are off/);

    await prisma.tradingWithdrawal.deleteMany({ where: { userId: serverId } });
    // A row aimed elsewhere (as if the database were tampered with) is refused.
    await prisma.tradingWithdrawal.create({
      data: {
        userId: serverId,
        destination: generateWalletKeypair().publicKey,
        requestedLamports: 100_000_000n,
      },
    });
    await prisma.tradingWithdrawal.create({
      data: { userId: serverId, destination, requestedLamports: 100_000_000n },
    });
    const sentTo: string[] = [];
    chain.rpc.send = async (b64) => {
      const parsed = parseWireTransaction(Buffer.from(b64, "base64"));
      expect(verifyTransactionSignatures(Buffer.from(b64, "base64"))).toBe(true);
      sentTo.push(parsed.accountKeys[1]!);
      return null;
    };
    await runTradingEngine(deps());
    rows = await prisma.tradingWithdrawal.findMany({
      where: { userId: serverId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["failed", "pending"]);
    expect(sentTo).toEqual([destination]);
  });
});
