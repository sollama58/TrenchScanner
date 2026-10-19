import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { EXIT_PLAN, type ExitPlan } from "../curation/profitSim.js";
import {
  buildLegacyTransaction,
  buildSolTransfer,
  decodeMessage,
  parseLookupTableAddresses,
  resolveAccountKeys,
  decodeShortVec,
  encodeShortVec,
  parseWireTransaction,
  signTransaction,
  verifyTransactionSignatures,
  SYSTEM_PROGRAM_ID,
  systemTransferInstruction,
  type InstructionSpec,
} from "./transaction.js";
import {
  createKeyProvider,
  createKmsKeyProvider,
  createLocalKeyProvider,
  generateWalletKeypair,
  openWalletSecret,
  sealWalletSecret,
} from "./keyVault.js";
import { isNotNowRpcError, TradingRpc, tipsJito } from "./rpc.js";
import { decideExit, ladderSoldFraction, sellAmount } from "./exitEngine.js";
import {
  associatedTokenAddress,
  checkInstructions,
  guardSwapTransaction,
  PROGRAM,
  type GuardRpc,
  type TradeExpectation,
} from "./txGuard.js";
import { HELIUS_SENDER_TIP_ACCOUNTS, senderUrl, sendViaSender } from "./sender.js";
import {
  dexScreenerPricesUsd,
  JupiterSwapClient,
  KeyRefusedError,
  NoRouteError,
  RateLimitedError,
  type SwapQuote,
} from "./jupiterSwap.js";
import { TransientError } from "./errors.js";
import {
  DEFAULT_TRADING_BOT_CONFIG,
  effectiveExitPlan,
  readTradingBotConfig,
  tradingBotConfigSchema,
} from "./config.js";
import {
  mintRisk,
  positionMultiple,
  withdrawalAmount,
  RENT_EXEMPT_MIN_LAMPORTS,
  TX_FEE_LAMPORTS,
} from "./engine.js";

const MASTER = "11".repeat(32);
const OWNER = "So11111111111111111111111111111111111111112";
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7));

describe("compact-u16", () => {
  it("round-trips across the byte boundaries", () => {
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
      const bytes = Uint8Array.from(encodeShortVec(n));
      expect(decodeShortVec(bytes, 0)).toEqual([n, bytes.length]);
    }
  });
});

describe("SOL transfer", () => {
  it("builds a transaction the sender's key signs and verifies", () => {
    const sender = generateWalletKeypair();
    const to = generateWalletKeypair().publicKey;
    const unsigned = buildSolTransfer({
      from: sender.publicKey,
      to,
      lamports: 123_456_789n,
      recentBlockhash: BLOCKHASH,
    });
    const parsed = parseWireTransaction(unsigned);
    expect(parsed.version).toBe("legacy");
    expect(parsed.requiredSignatures).toBe(1);
    expect(parsed.accountKeys).toEqual([sender.publicKey, to, SYSTEM_PROGRAM_ID]);
    // The instruction data ends the message: transfer (2) then the amount, little-endian.
    const data = parsed.message.slice(-12);
    expect([...data.slice(0, 4)]).toEqual([2, 0, 0, 0]);
    expect(Buffer.from(data.slice(4)).readBigUInt64LE()).toBe(123_456_789n);

    const { signed, signature } = signTransaction(unsigned, sender.seed, sender.publicKey);
    expect(verifyTransactionSignatures(signed)).toBe(true);
    expect(bs58.decode(signature)).toHaveLength(64);
    expect(signed.slice(1, 65)).toEqual(bs58.decode(signature));
  });

  it("refuses to sign for a wallet that is not the fee payer", () => {
    const sender = generateWalletKeypair();
    const other = generateWalletKeypair();
    const unsigned = buildSolTransfer({
      from: other.publicKey,
      to: sender.publicKey,
      lamports: 1n,
      recentBlockhash: BLOCKHASH,
    });
    expect(() => signTransaction(unsigned, sender.seed, sender.publicKey)).toThrow(/fee payer/);
  });

  it("signs a v0 message too", () => {
    const wallet = generateWalletKeypair();
    const legacy = buildSolTransfer({
      from: wallet.publicKey,
      to: generateWalletKeypair().publicKey,
      lamports: 5n,
      recentBlockhash: BLOCKHASH,
    });
    // Same message as v0: the version prefix, then the legacy body, then no lookup tables.
    const v0 = Uint8Array.from([...legacy.slice(0, 65), 0x80, ...legacy.slice(65), 0]);
    const parsed = parseWireTransaction(v0);
    expect(parsed.version).toBe(0);
    const { signed } = signTransaction(v0, wallet.seed, wallet.publicKey);
    expect(verifyTransactionSignatures(signed)).toBe(true);
  });
});

describe("key vault", () => {
  const provider = createLocalKeyProvider(MASTER);

  it("seals and reopens a seed bound to its wallet", async () => {
    const { seed, publicKey } = generateWalletKeypair();
    const sealed = await sealWalletSecret(provider, seed, { userId: "u1", publicKey, withdrawTo: OWNER });
    expect(Buffer.from(sealed.secretCiphertext).equals(Buffer.from(seed))).toBe(false);
    const opened = await openWalletSecret(provider, sealed, { userId: "u1", publicKey, withdrawTo: OWNER });
    expect(bs58.encode(ed25519.getPublicKey(opened))).toBe(publicKey);
  });

  it("refuses a sealed seed whose withdrawal address was changed", async () => {
    const { seed, publicKey } = generateWalletKeypair();
    const sealed = await sealWalletSecret(provider, seed, { userId: "u1", publicKey, withdrawTo: OWNER });
    await expect(
      openWalletSecret(provider, sealed, { userId: "u1", publicKey, withdrawTo: "Attacker" }),
    ).rejects.toThrow();
  });

  it("refuses a sealed seed moved onto another user", async () => {
    const { seed, publicKey } = generateWalletKeypair();
    const sealed = await sealWalletSecret(provider, seed, { userId: "u1", publicKey, withdrawTo: OWNER });
    await expect(
      openWalletSecret(provider, sealed, { userId: "u2", publicKey, withdrawTo: OWNER }),
    ).rejects.toThrow();
  });

  it("refuses under a different master key", async () => {
    const { seed, publicKey } = generateWalletKeypair();
    const sealed = await sealWalletSecret(provider, seed, { userId: "u1", publicKey, withdrawTo: OWNER });
    const other = createLocalKeyProvider("22".repeat(32));
    await expect(
      openWalletSecret(other, sealed, { userId: "u1", publicKey, withdrawTo: OWNER }),
    ).rejects.toThrow();
  });

  it("keeps the local provider out of production and wants every KMS setting", () => {
    const base = {
      TRADING_KEY_PROVIDER: "local" as const,
      TRADING_KMS_KEY_ID: "",
      TRADING_KMS_REGION: "us-east-1",
      TRADING_AWS_ACCESS_KEY_ID: "",
      TRADING_AWS_SECRET_ACCESS_KEY: "",
      TRADING_AWS_SESSION_TOKEN: "",
      TRADING_LOCAL_MASTER_KEY: MASTER,
    };
    expect(createKeyProvider({ ...base, NODE_ENV: "production" }).provider).toBeNull();
    expect(createKeyProvider(base).provider?.name).toBe("local");
    const kms = createKeyProvider({ ...base, TRADING_KEY_PROVIDER: "kms" });
    expect(kms.provider).toBeNull();
    expect(kms.reason).toMatch(/TRADING_KMS_KEY_ID/);
  });

  it("speaks KMS's JSON API: signed request, encryption context, key pinned on decrypt", async () => {
    const calls: { target: string; auth: string; body: Record<string, unknown> }[] = [];
    const dataKey = Buffer.alloc(32, 9);
    const fakeFetch = (async (_url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calls.push({ target: headers["x-amz-target"]!, auth: headers.authorization!, body });
      const out =
        headers["x-amz-target"] === "TrentService.GenerateDataKey"
          ? {
              CiphertextBlob: Buffer.from("wrapped").toString("base64"),
              Plaintext: dataKey.toString("base64"),
            }
          : { Plaintext: dataKey.toString("base64") };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as unknown as typeof fetch;
    const kms = createKmsKeyProvider(
      {
        keyId: "arn:aws:kms:us-east-1:1:key/abc",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "s",
      },
      fakeFetch,
    );
    const { seed, publicKey } = generateWalletKeypair();
    const sealed = await sealWalletSecret(kms, seed, { userId: "u1", publicKey, withdrawTo: OWNER });
    const opened = await openWalletSecret(kms, sealed, { userId: "u1", publicKey, withdrawTo: OWNER });
    expect(bs58.encode(ed25519.getPublicKey(opened))).toBe(publicKey);
    expect(calls.map((c) => c.target)).toEqual(["TrentService.GenerateDataKey", "TrentService.Decrypt"]);
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-east-1\/kms\/aws4_request/);
    expect(calls[0]!.body.EncryptionContext).toEqual({
      purpose: "trenchscanner-trading-wallet",
      userId: "u1",
      publicKey,
      withdrawTo: OWNER,
    });
    expect(calls[1]!.body.KeyId).toBe("arn:aws:kms:us-east-1:1:key/abc");
  });

  it("surfaces a KMS error without key material", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ __type: "AccessDeniedException", message: "not allowed" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const kms = createKmsKeyProvider(
      { keyId: "k", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" },
      fakeFetch,
    );
    await expect(kms.generateDataKey({ userId: "u", publicKey: "p", withdrawTo: "w" })).rejects.toThrow(
      /AccessDeniedException/,
    );
  });
});

describe("exit engine (the default plan)", () => {
  const opened = new Date("2026-10-08T12:00:00Z");
  const at = (minutes: number) => new Date(opened.getTime() + minutes * 60_000);
  const fresh = { openedAt: opened, rungsTaken: 0, highMultiple: null };

  it("holds between the stop and the first rung", () => {
    expect(decideExit(fresh, 1.4, at(5), EXIT_PLAN).action).toBe("hold");
  });

  it("stops out at -50% before the first sale", () => {
    expect(decideExit(fresh, 0.5, at(5), EXIT_PLAN)).toMatchObject({
      action: "sell",
      all: true,
      reason: "stop_loss",
    });
  });

  it("sells 35% at 2x", () => {
    expect(decideExit(fresh, 2.1, at(5), EXIT_PLAN)).toMatchObject({
      action: "sell",
      fraction: 0.35,
      all: false,
      reason: "take_profit",
      rung: 0,
    });
  });

  it("closes a call that never sold at 30 minutes", () => {
    expect(decideExit(fresh, 1.2, at(30), EXIT_PLAN)).toMatchObject({ action: "sell", reason: "max_hold" });
  });

  it("sells 30% more at 4x and 25% at 10x, of the original position", () => {
    const one = { openedAt: opened, rungsTaken: 1, highMultiple: 3 };
    expect(decideExit(one, 4.2, at(20), EXIT_PLAN)).toMatchObject({
      reason: "take_profit",
      rung: 1,
      fraction: 0.3,
    });
    const two = { openedAt: opened, rungsTaken: 2, highMultiple: 8 };
    expect(decideExit(two, 10.5, at(30), EXIT_PLAN)).toMatchObject({
      reason: "take_profit",
      rung: 2,
      fraction: 0.25,
      all: false,
    });
    expect(ladderSoldFraction(EXIT_PLAN, 3)).toBeCloseTo(0.9);
  });

  it("rides what is held on a trail 40% off the high, which ratchets up", () => {
    const sold = { openedAt: opened, rungsTaken: 2, highMultiple: 4 };
    const up = decideExit(sold, 5, at(40), EXIT_PLAN);
    expect(up).toEqual({ action: "hold", highMultiple: 5 });
    // 5x high: the level is 3x.
    expect(decideExit({ ...sold, highMultiple: 5 }, 3.05, at(41), EXIT_PLAN).action).toBe("hold");
    expect(decideExit({ ...sold, highMultiple: 5 }, 2.95, at(41), EXIT_PLAN)).toMatchObject({
      action: "sell",
      all: true,
      reason: "trailing_stop",
    });
  });

  it("does not stop out below -50% after the sale (the trail owns the rest), and closes at 3 hours", () => {
    const sold = { openedAt: opened, rungsTaken: 1, highMultiple: 2 };
    expect(decideExit(sold, 1.25, at(60), EXIT_PLAN).action).toBe("hold");
    expect(decideExit(sold, 1.2, at(60), EXIT_PLAN)).toMatchObject({ reason: "trailing_stop" });
    expect(decideExit(sold, 1.9, at(180), EXIT_PLAN)).toMatchObject({ reason: "trail_max_hold" });
  });

  it("walks a multi-rung ladder one rung at a time, then stops on a plan with no trail", () => {
    const plan: ExitPlan = {
      takeProfits: [
        { multiple: 3, sellFraction: 0.5 },
        { multiple: 1.5, sellFraction: 0.25 },
      ],
      stopFraction: 0.7,
      maxHoldMinutes: 60,
      trail: [],
      trailMaxHoldMinutes: 120,
    };
    expect(decideExit(fresh, 3.5, at(1), plan)).toMatchObject({
      reason: "take_profit",
      rung: 0,
      fraction: 0.25,
    });
    const one = { openedAt: opened, rungsTaken: 1, highMultiple: 1.5 };
    expect(decideExit(one, 3.5, at(2), plan)).toMatchObject({
      reason: "take_profit",
      rung: 1,
      fraction: 0.5,
    });
    expect(decideExit(one, 0.7, at(2), plan)).toMatchObject({ reason: "stop_loss", all: true });
    expect(decideExit(one, 1.2, at(60), plan)).toMatchObject({ reason: "max_hold", all: true });
    expect(ladderSoldFraction(plan, 2)).toBeCloseTo(0.75);
  });

  it("sizes sales from the original position and sweeps dust", () => {
    expect(sellAmount({ fraction: 0.5, all: false }, 1_000_000n, 1_000_000n)).toBe(500_000n);
    expect(sellAmount({ fraction: 0.5, all: false }, 1_000_000n, 400_000n)).toBe(400_000n);
    expect(sellAmount({ fraction: 0.5, all: false }, 1_000_000n, 500_500n)).toBe(500_500n);
    expect(sellAmount({ fraction: 0.1, all: true }, 1_000_000n, 123n)).toBe(123n);
  });
});

describe("bot config", () => {
  it("defaults to the project's exit plan", () => {
    expect(DEFAULT_TRADING_BOT_CONFIG.exitPlan).toBeNull();
    expect(effectiveExitPlan(DEFAULT_TRADING_BOT_CONFIG)).toBe(EXIT_PLAN);
  });

  it("rejects a ladder that sells more than the position", () => {
    const bad = tradingBotConfigSchema.safeParse({
      exitPlan: {
        takeProfits: [
          { multiple: 2, sellFraction: 0.7 },
          { multiple: 3, sellFraction: 0.7 },
        ],
        stopFraction: 0.5,
        maxHoldMinutes: 30,
        trail: [],
        trailMaxHoldMinutes: 60,
      },
    });
    expect(bad.success).toBe(false);
  });

  it("reads garbage as the defaults", () => {
    expect(readTradingBotConfig({ buySol: "lots" })).toEqual(DEFAULT_TRADING_BOT_CONFIG);
    expect(readTradingBotConfig(null)).toEqual(DEFAULT_TRADING_BOT_CONFIG);
  });
});

describe("withdrawal sizing", () => {
  it("sends everything less the fee for 'max'", () => {
    expect(withdrawalAmount(1_000_000n, null)).toEqual({ lamports: 1_000_000n - TX_FEE_LAMPORTS });
  });
  it("refuses to strand a balance below rent-exemption", () => {
    const balance = 10_000_000n;
    const tooMuch = balance - TX_FEE_LAMPORTS - RENT_EXEMPT_MIN_LAMPORTS + 1n;
    expect(withdrawalAmount(balance, tooMuch)).toHaveProperty("error");
    expect(withdrawalAmount(balance, balance)).toHaveProperty("error");
    expect(withdrawalAmount(balance, 1_000_000n)).toEqual({ lamports: 1_000_000n });
    expect(withdrawalAmount(4_000n, null)).toHaveProperty("error");
  });
});

describe("position multiple", () => {
  it("measures the token's price in SOL against the entry", () => {
    // Paid 1 SOL for 1,000 tokens (6 decimals): 0.001 SOL a token. SOL $200, token now $0.4 = 0.002 SOL.
    const position = { swapInLamports: 1_000_000_000n, tokensBought: "1000000000", decimals: 6 };
    expect(positionMultiple(position, 0.4, 200)).toBeCloseTo(2);
    expect(positionMultiple(position, undefined, 200)).toBeNull();
  });
});

describe("instruction guard", () => {
  const wallet = generateWalletKeypair().publicKey;
  const stranger = generateWalletKeypair().publicKey;
  const check = (tx: Uint8Array) => {
    const decoded = decodeMessage(parseWireTransaction(tx).message);
    return () => checkInstructions(decoded, decoded.staticKeys, wallet);
  };
  const ix = (programId: string, accounts: string[], data: number[]) =>
    buildLegacyTransaction(wallet, BLOCKHASH, {
      programId,
      accounts: accounts.map((pubkey) => ({ pubkey, writable: true })),
      data,
    });

  it("allows what a swap needs", () => {
    expect(
      check(buildSolTransfer({ from: wallet, to: stranger, lamports: 5n, recentBlockhash: BLOCKHASH })),
    ).not.toThrow();
    expect(check(ix(PROGRAM.token, [stranger], [17]))).not.toThrow(); // SyncNative
    expect(check(ix(PROGRAM.token, [stranger, wallet, wallet], [9]))).not.toThrow(); // close to the wallet
    expect(check(ix(PROGRAM.ata, [wallet, stranger, wallet], [1]))).not.toThrow(); // create own ATA
    expect(check(ix(PROGRAM.jupiterV6, [wallet, stranger], [1, 2, 3]))).not.toThrow();
    expect(check(ix(PROGRAM.computeBudget, [], [3, 1, 0, 0, 0, 0, 0, 0, 0]))).not.toThrow();
  });

  it("refuses what could take the wallet's money later or elsewhere", () => {
    expect(check(ix(SYSTEM_PROGRAM_ID, [wallet], [1, 0, 0, 0, ...new Array(32).fill(1)]))).toThrow(
      /System instruction 1/,
    ); // Assign
    expect(check(ix(SYSTEM_PROGRAM_ID, [stranger, stranger, wallet], [4, 0, 0, 0]))).toThrow(
      /System instruction 4/,
    ); // AdvanceNonce
    expect(check(ix(PROGRAM.token, [stranger, stranger, wallet], [3, 1, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      /token instruction 3/,
    ); // Transfer
    expect(check(ix(PROGRAM.token, [stranger, wallet], [4, 1, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      /token instruction 4/,
    ); // Approve
    expect(check(ix(PROGRAM.token, [stranger, wallet], [6, 2, 1, ...new Array(32).fill(1)]))).toThrow(
      /token instruction 6/,
    ); // SetAuthority
    expect(check(ix(PROGRAM.token, [stranger, stranger, wallet], [9]))).toThrow(/token instruction 9/); // close elsewhere
    expect(check(ix(PROGRAM.ata, [wallet, stranger, stranger], [1]))).toThrow(/associated-token/); // someone else's ATA
    expect(check(ix(stranger, [wallet], [0]))).toThrow(/is not allowed/); // unknown program
  });

  it("reads Jupiter's route slippage and platform fee, and refuses a wider slippage or any fee", () => {
    // shared_accounts_route: discriminator, a route plan stand-in, in (u64), quoted out (u64),
    // slippage 1500 (u16 LE), platform fee (u8).
    const route = (slippage: number, fee: number) => [
      193,
      32,
      155,
      51,
      65,
      214,
      156,
      129,
      0,
      1,
      0,
      0,
      0,
      ...new Array(16).fill(7),
      slippage & 0xff,
      slippage >> 8,
      fee,
    ];
    const jup = (data: number[], maxSlippageBps?: number) => {
      const decoded = decodeMessage(parseWireTransaction(ix(PROGRAM.jupiterV6, [wallet], data)).message);
      return () => checkInstructions(decoded, decoded.staticKeys, wallet, { maxSlippageBps });
    };
    expect(jup(route(1500, 0), 1500)()).toMatchObject({ jupiterRoutesChecked: 1 });
    expect(jup(route(1501, 0), 1500)).toThrow(/1501bps slippage/);
    expect(jup(route(1500, 50), 5000)).toThrow(/platform fee/);
    // Any other Jupiter instruction is left to the simulation.
    expect(jup([1, 2, 3], 1500)()).toMatchObject({ jupiterRoutesChecked: 0 });
  });

  it.each([
    ["route_v2", [187, 100, 250, 204, 49, 196, 175, 20]],
    ["shared_accounts_route_v2", [209, 152, 83, 147, 124, 254, 216, 233, 0]],
    ["exact_out_route_v2", [157, 138, 184, 82, 21, 244, 243, 36]],
    ["shared_accounts_exact_out_route_v2", [53, 96, 229, 202, 216, 187, 250, 24, 0]],
  ])("reads Jupiter's %s slippage and fees from its leading arguments", (name, head) => {
    // V2: discriminator [, id], amount (u64), quoted (u64), slippage, platform fee and positive
    // slippage (u16 each), then the route plan (one Whirlpool step).
    const route = (slippage: number, fee: number, positive = 0) => [
      ...head,
      ...new Array(16).fill(7),
      slippage & 0xff,
      slippage >> 8,
      fee & 0xff,
      fee >> 8,
      positive & 0xff,
      positive >> 8,
      ...[1, 0, 0, 0, 17, 1, 16, 39, 0, 1],
    ];
    const jup = (data: number[], maxSlippageBps?: number) => {
      const decoded = decodeMessage(parseWireTransaction(ix(PROGRAM.jupiterV6, [wallet], data)).message);
      return () => checkInstructions(decoded, decoded.staticKeys, wallet, { maxSlippageBps });
    };
    expect(jup(route(1500, 0), 1500)()).toMatchObject({ jupiterRoutesChecked: 1 });
    expect(jup(route(1501, 0), 1500)).toThrow(new RegExp(`${name} allows 1501bps slippage`));
    // A fee past V1's 255bps cap, which V2 allows.
    expect(jup(route(1500, 300), 5000)).toThrow(/300bps platform fee/);
    expect(jup(route(1500, 0, 50), 5000)).toThrow(/positive slippage/);
  });

  it("counts SOL sent to others and the priority fee, for the caller to bound", () => {
    const wsolAta = associatedTokenAddress(
      wallet,
      "So11111111111111111111111111111111111111112",
      PROGRAM.token,
    );
    const decode = (tx: Uint8Array) => decodeMessage(parseWireTransaction(tx).message);
    const toStranger = decode(
      buildSolTransfer({ from: wallet, to: stranger, lamports: 7_000n, recentBlockhash: BLOCKHASH }),
    );
    expect(checkInstructions(toStranger, toStranger.staticKeys, wallet).externalLamports).toBe(7_000n);
    const wrapping = decode(
      buildSolTransfer({ from: wallet, to: wsolAta, lamports: 9_000n, recentBlockhash: BLOCKHASH }),
    );
    expect(checkInstructions(wrapping, wrapping.staticKeys, wallet).externalLamports).toBe(0n);
    // 1,000,000 micro-lamports a unit, no limit set: the 1.4M-unit maximum is assumed.
    const fee = decode(ix(PROGRAM.computeBudget, [], [3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]));
    expect(checkInstructions(fee, fee.staticKeys, wallet).priorityFeeLamports).toBe(1_400_000n);
  });

  it("decodes v0 messages and resolves lookup-table accounts in runtime order", () => {
    const table = generateWalletKeypair().publicKey;
    const loaded = [generateWalletKeypair().publicKey, generateWalletKeypair().publicKey];
    const keyBytes = [wallet, PROGRAM.token].map((k) => [...bs58.decode(k)]);
    const message = Uint8Array.from([
      0x80, // v0
      1,
      0,
      1,
      2,
      ...keyBytes.flat(),
      ...bs58.decode(BLOCKHASH),
      1, // one instruction: CloseAccount(loaded[1] -> loaded[0], owner wallet)
      1,
      3,
      3,
      2,
      0,
      1,
      9,
      1,
      ...bs58.decode(table),
      1,
      0,
      1,
      1, // table: writable [0], readonly [1]
    ]);
    const decoded = decodeMessage(message);
    expect(decoded.version).toBe(0);
    const keys = resolveAccountKeys(decoded, new Map([[table, loaded]]));
    expect(keys).toEqual([wallet, PROGRAM.token, loaded[0], loaded[1]]);
    // The close goes to a loaded account, not the wallet: refused even though it hid in a table.
    // A close whose accounts come from a lookup table is refused outright: the RPC serves the tables.
    expect(() => checkInstructions(decoded, keys, wallet)).toThrow(/lookup table/);
    const header = new Uint8Array(56);
    expect(parseLookupTableAddresses(Uint8Array.from([...header, ...bs58.decode(loaded[0]!)]))).toEqual([
      loaded[0],
    ]);
  });
});

describe("swap guard (wallet security audit 2026-10-18)", () => {
  const wallet = generateWalletKeypair().publicKey;
  const mint = generateWalletKeypair().publicKey;
  const tip = HELIUS_SENDER_TIP_ACCOUNTS[0]!;
  // The chain as the guard reads it: the wallet loses `spent` lamports, nothing else changes.
  const rpc = (spent: bigint): GuardRpc => ({
    getAccountsData: async (a) => a.map(() => null),
    getParsedAccounts: async (a) =>
      a.map((k) =>
        k === wallet ? { lamports: 1_000_000_000n, owner: SYSTEM_PROGRAM_ID, token: null } : null,
      ),
    simulateParsed: async (_b64, a) => ({
      error: null,
      logs: [],
      accounts: a.map((k) =>
        k === wallet ? { lamports: 1_000_000_000n - spent, owner: SYSTEM_PROGRAM_ID, token: null } : null,
      ),
    }),
  });
  const sale: TradeExpectation = {
    kind: "sell",
    mint,
    amount: 1_000n,
    minSolOut: 0n,
    feeAllowance: 1_000_000n,
    maxExternalLamports: 1_000_000n,
    maxPriorityFeeLamports: 100_000n,
  };
  const jupiter = { programId: PROGRAM.jupiterV6, accounts: [], data: [1, 2, 3] };
  const tx = (...ixs: InstructionSpec[]) => buildLegacyTransaction(wallet, BLOCKHASH, ixs);

  it("refuses a sale that sells nothing, however small its fees", async () => {
    await expect(
      guardSwapTransaction(
        rpc(500_000n),
        tx(jupiter, systemTransferInstruction(wallet, tip, 500_000n)),
        wallet,
        sale,
      ),
    ).rejects.toThrow(/sell no tokens/);
  });
  it("refuses a transaction with no swap in it", async () => {
    await expect(
      guardSwapTransaction(rpc(500_000n), tx(systemTransferInstruction(wallet, tip, 500_000n)), wallet, sale),
    ).rejects.toThrow(/no swap instruction/);
  });
  it("refuses SOL sent to anyone but a tip account", async () => {
    const stranger = generateWalletKeypair().publicKey;
    await expect(
      guardSwapTransaction(
        rpc(500_000n),
        tx(jupiter, systemTransferInstruction(wallet, stranger, 500_000n)),
        wallet,
        sale,
      ),
    ).rejects.toThrow(/isn't a tip account/);
  });
});

describe("swap guard: multi-hop routes", () => {
  const wallet = generateWalletKeypair().publicKey;
  const mint = generateWalletKeypair().publicKey;
  const hops = [generateWalletKeypair().publicKey, generateWalletKeypair().publicKey];
  const RENT = 2_074_080n;
  const PREFUND = 890_880n;
  const ata = (m: string) => associatedTokenAddress(wallet, m, PROGRAM.token2022);
  const openAta = (m: string): InstructionSpec => ({
    programId: PROGRAM.ata,
    accounts: [
      { pubkey: wallet, writable: true, signer: true },
      { pubkey: ata(m), writable: true },
      { pubkey: wallet, writable: false },
      { pubkey: m, writable: false },
      { pubkey: SYSTEM_PROGRAM_ID, writable: false },
      { pubkey: PROGRAM.token2022, writable: false },
    ],
    data: [1],
  });
  const jupiter = { programId: PROGRAM.jupiterV6, accounts: [], data: [1, 2, 3] };
  const token = (m: string, amount: bigint, extra: Partial<{ delegate: string }> = {}) => ({
    lamports: RENT,
    owner: PROGRAM.token2022,
    token: {
      mint: m,
      owner: wallet,
      amount,
      delegate: extra.delegate ?? null,
      closeAuthority: null,
      state: null,
    },
  });
  // SOL in, through two hop tokens whose accounts the wallet lacks, to the coin.
  // `funded`: hop addresses someone sent bare SOL to before the swap opened them.
  const rpc = (spent: bigint, opened: string[], delegate?: string, funded: string[] = []): GuardRpc => ({
    getAccountsData: async (a) => a.map(() => null),
    getParsedAccounts: async (a) =>
      a.map((k) =>
        k === wallet
          ? { lamports: 1_000_000_000n, owner: SYSTEM_PROGRAM_ID, token: null }
          : funded.some((m) => ata(m) === k)
            ? { lamports: PREFUND, owner: SYSTEM_PROGRAM_ID, token: null }
            : null,
      ),
    simulateParsed: async (_b64, a) => ({
      error: null,
      logs: [],
      accounts: a.map((k) => {
        if (k === wallet) return { lamports: 1_000_000_000n - spent, owner: SYSTEM_PROGRAM_ID, token: null };
        if (k === ata(mint)) return token(mint, 5_000n);
        const hop = opened.find((m) => ata(m) === k);
        return hop ? token(hop, 0n, delegate ? { delegate } : {}) : null;
      }),
    }),
  });
  const buy: TradeExpectation = {
    kind: "buy",
    mint,
    minOut: 4_000n,
    // 0.1 SOL, fees and the 0.005 SOL margin the coin's own account comes out of.
    maxSolDrop: 100_000_000n + 5_000_000n,
    maxExternalLamports: 0n,
    maxPriorityFeeLamports: 0n,
  };
  const tx = (...ixs: InstructionSpec[]) => buildLegacyTransaction(wallet, BLOCKHASH, ixs);

  it("leaves the rent of a route's new hop accounts out of the SOL a buy spends", async () => {
    const spent = 100_000_000n + RENT * 3n;
    await expect(
      guardSwapTransaction(rpc(spent, hops), tx(...[mint, ...hops].map(openAta), jupiter), wallet, buy),
    ).resolves.toBeTruthy();
    // The same SOL gone with no hop account to show for it is over the limit.
    await expect(
      guardSwapTransaction(rpc(spent, []), tx(openAta(mint), jupiter), wallet, buy),
    ).rejects.toThrow(/more than the/);
  });
  it("takes a hop account someone sent SOL to before the swap as new, counting only the rent added", async () => {
    // The wallet tops the pre-funded account up to its rent: RENT - PREFUND, not a full RENT.
    const spent = 100_000_000n + RENT * 2n + (RENT - PREFUND);
    await expect(
      guardSwapTransaction(
        rpc(spent, hops, undefined, [hops[0]!]),
        tx(...[mint, ...hops].map(openAta), jupiter),
        wallet,
        buy,
      ),
    ).resolves.toBeTruthy();
  });
  it("lets a trade through a curve's quote coin add to the wallet's quote coin, never take from it", async () => {
    const quoteCoin = hops[0]!;
    const held = ata(quoteCoin);
    const viaRpc = (after: bigint): GuardRpc => ({
      getAccountsData: async (a) => a.map(() => null),
      getParsedAccounts: async (a) =>
        a.map((k) =>
          k === wallet
            ? { lamports: 1_000_000_000n, owner: SYSTEM_PROGRAM_ID, token: null }
            : k === held
              ? token(quoteCoin, 1_000n)
              : null,
        ),
      simulateParsed: async (_b64, a) => ({
        error: null,
        logs: [],
        accounts: a.map((k) =>
          k === wallet
            ? { lamports: 1_000_000_000n - 100_000_000n, owner: SYSTEM_PROGRAM_ID, token: null }
            : k === ata(mint)
              ? token(mint, 5_000n)
              : k === held
                ? token(quoteCoin, after)
                : null,
        ),
      }),
    });
    const holding: InstructionSpec = {
      ...jupiter,
      accounts: [
        { pubkey: held, writable: true },
        { pubkey: ata(mint), writable: true },
      ],
    };
    const viaBuy = { ...buy, via: quoteCoin };
    await expect(guardSwapTransaction(viaRpc(1_007n), tx(holding), wallet, viaBuy)).resolves.toBeTruthy();
    await expect(guardSwapTransaction(viaRpc(993n), tx(holding), wallet, viaBuy)).rejects.toThrow(
      /another position's balance/,
    );
    // Without `via` the quote coin is any other position: it may not change at all.
    await expect(guardSwapTransaction(viaRpc(1_007n), tx(holding), wallet, buy)).rejects.toThrow(
      /another position's balance/,
    );
  });
  it("refuses a hop account that isn't the wallet's alone, or too many of them", async () => {
    const stranger = generateWalletKeypair().publicKey;
    await expect(
      guardSwapTransaction(
        rpc(100_000_000n + RENT * 3n, hops, stranger),
        tx(...[mint, ...hops].map(openAta), jupiter),
        wallet,
        buy,
      ),
    ).rejects.toThrow(/isn't the wallet's alone/);
    const many = [1, 2, 3, 4].map(() => generateWalletKeypair().publicKey);
    await expect(
      guardSwapTransaction(
        rpc(100_000_000n + RENT * 5n, many),
        tx(...[mint, ...many].map(openAta), jupiter),
        wallet,
        buy,
      ),
    ).rejects.toThrow(/open 4 token accounts/);
  });
});

describe("mint risk", () => {
  const pumpLike = {
    program: PROGRAM.token2022,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: ["metadataPointer", "tokenMetadata"],
  };
  it("accepts a Pump.fun-style mint and plain SPL mints with authorities revoked", () => {
    expect(mintRisk(pumpLike)).toBeNull();
    expect(mintRisk({ ...pumpLike, program: PROGRAM.token, extensions: [] })).toBeNull();
  });
  it("refuses live authorities, harmful extensions, and non-token accounts", () => {
    expect(mintRisk({ ...pumpLike, mintAuthority: "x" })).toMatch(/mint authority/);
    expect(mintRisk({ ...pumpLike, freezeAuthority: "x" })).toMatch(/freeze authority/);
    for (const ext of [
      "permanentDelegate",
      "transferHook",
      "transferFeeConfig",
      "pausableConfig",
      "defaultAccountState",
      "nonTransferable",
    ])
      expect(mintRisk({ ...pumpLike, extensions: [...pumpLike.extensions, ext] })).toContain(ext);
    expect(mintRisk({ ...pumpLike, program: "11111111111111111111111111111111" })).toMatch(
      /not a token mint/,
    );
  });
});

describe("Jupiter swap client", () => {
  const quote = {
    inputMint: OWNER,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000",
    outAmount: "10",
    otherAmountThreshold: "9",
    priceImpactPct: "0",
  } satisfies SwapQuote;
  /** A fetch answering with each response in turn, recording the request bodies. */
  const scripted = (responses: (() => Response)[]) => {
    const bodies: unknown[] = [];
    let i = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return next();
    }) as typeof fetch;
    return { fetchImpl, bodies, calls: () => i };
  };
  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const built = json({
    swapTransaction: Buffer.from(new Uint8Array(200)).toString("base64"),
    lastValidBlockHeight: 5,
  });

  it("tries a server error once more, then calls it transient", async () => {
    let s = scripted([json({ error: "busy" }, 502), json(quote)]);
    await expect(
      new JupiterSwapClient({ fetchImpl: s.fetchImpl }).quote({
        inputMint: OWNER,
        outputMint: quote.outputMint,
        amount: 1000n,
        slippageBps: 100,
      }),
    ).resolves.toMatchObject({ outAmount: "10" });
    expect(s.calls()).toBe(2);
    s = scripted([json({ error: "busy" }, 503)]);
    await expect(
      new JupiterSwapClient({ fetchImpl: s.fetchImpl }).quote({
        inputMint: OWNER,
        outputMint: quote.outputMint,
        amount: 1000n,
        slippageBps: 100,
      }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(s.calls()).toBe(2);
    // A network failure likewise.
    let thrown = 0;
    const down = (async () => {
      thrown++;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      new JupiterSwapClient({ fetchImpl: down, backupPrices: null }).pricesUsd([OWNER]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(thrown).toBe(2);
  });

  it("fills prices Jupiter lacks, or all of them while it is down, from the backup source", async () => {
    const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const backup = async (mints: string[]) => new Map(mints.map((m) => [m, 2] as const));
    const partial = scripted([json({ [OWNER]: { usdPrice: 1 } })]);
    const got = await new JupiterSwapClient({ fetchImpl: partial.fetchImpl, backupPrices: backup }).pricesUsd(
      [OWNER, MINT],
    );
    expect([...got]).toEqual([
      [OWNER, 1],
      [MINT, 2],
    ]);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const fromBackup = await new JupiterSwapClient({ fetchImpl: down, backupPrices: backup }).pricesUsd([
      OWNER,
    ]);
    expect(fromBackup.get(OWNER)).toBe(2);
    // Both down: Jupiter's error, so the engine still treats it as an outage.
    const none = async () => new Map<string, number>();
    await expect(
      new JupiterSwapClient({ fetchImpl: down, backupPrices: none }).pricesUsd([OWNER]),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("prices from DexScreener only off the deepest liquid Solana pair", async () => {
    const pairs = [
      { chainId: "solana", baseToken: { address: OWNER }, priceUsd: "9", liquidity: { usd: 500 } },
      { chainId: "solana", baseToken: { address: OWNER }, priceUsd: "1.5", liquidity: { usd: 80_000 } },
      { chainId: "solana", baseToken: { address: OWNER }, priceUsd: "1.4", liquidity: { usd: 20_000 } },
      { chainId: "base", baseToken: { address: OWNER }, priceUsd: "7", liquidity: { usd: 900_000 } },
    ];
    const s = scripted([json(pairs)]);
    expect((await dexScreenerPricesUsd([OWNER], s.fetchImpl)).get(OWNER)).toBe(1.5);
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect((await dexScreenerPricesUsd([OWNER], broken)).size).toBe(0);
  });

  it("moves a rate-limited call to the next host, and throws only when every host is limited", async () => {
    const urls: string[] = [];
    const keys: (string | null)[] = [];
    const limitedKey = "mine";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key");
      urls.push(new URL(url).host);
      keys.push(key);
      return key === limitedKey ? json({ error: "slow down" }, 429)() : json(quote)();
    }) as typeof fetch;
    const client = new JupiterSwapClient({ apiKey: "mine", fetchImpl });
    const ask = { inputMint: OWNER, outputMint: quote.outputMint, amount: 1000n, slippageBps: 100 };
    await expect(client.quote(ask)).resolves.toMatchObject({ outAmount: "10" });
    expect(urls).toEqual(["api.jup.ag", "lite-api.jup.ag"]);
    expect(keys).toEqual(["mine", null]);
    // The limited host waits its turn on the next call.
    await client.quote(ask);
    expect(urls.slice(2)).toEqual(["lite-api.jup.ag"]);
    // A backup key is tried before the keyless host.
    urls.length = 0;
    keys.length = 0;
    const backed = new JupiterSwapClient({ apiKey: "mine", backupApiKey: "scan", fetchImpl });
    await backed.quote(ask);
    expect(keys).toEqual(["mine", "scan"]);
    // Every host limited: a RateLimitedError, each host asked once.
    const all = (async (url: string) => {
      urls.push(new URL(url).host);
      return json({ error: "slow down" }, 429)();
    }) as typeof fetch;
    urls.length = 0;
    await expect(
      new JupiterSwapClient({ apiKey: "mine", fetchImpl: all, backupPrices: null }).pricesUsd([OWNER]),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(urls).toEqual(["api.jup.ag", "lite-api.jup.ag"]);
  });

  it("moves a call to the next host on a refused key, a server error or a timeout too", async () => {
    const ask = { inputMint: OWNER, outputMint: quote.outputMint, amount: 1000n, slippageBps: 100 };
    const hosts: string[] = [];
    const failing = (fail: () => Response | Promise<Response>) =>
      (async (_url: string, init?: RequestInit) => {
        hosts.push(new Headers(init?.headers).get("x-api-key") ?? "keyless");
        return new Headers(init?.headers).get("x-api-key") === "mine" ? fail() : json(quote)();
      }) as typeof fetch;
    for (const fail of [
      json({ error: "Unauthorized" }, 401),
      json({ error: "Forbidden" }, 403),
      json({ error: "busy" }, 502),
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    ]) {
      hosts.length = 0;
      const client = new JupiterSwapClient({
        apiKey: "mine",
        backupApiKey: "scan",
        fetchImpl: failing(fail),
      });
      await expect(client.quote(ask)).resolves.toMatchObject({ outAmount: "10" });
      // Straight on to the backup key, no retry on the failed one; it goes last next time.
      expect(hosts).toEqual(["mine", "scan"]);
      await client.quote(ask);
      expect(hosts.slice(2)).toEqual(["scan"]);
    }
    // Every host failing: the most retryable failure, each host asked once and the last twice.
    hosts.length = 0;
    const down = (async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key");
      hosts.push(key ?? "keyless");
      return key ? json({ error: "Unauthorized" }, 401)() : json({ error: "busy" }, 503)();
    }) as typeof fetch;
    await expect(
      new JupiterSwapClient({ apiKey: "mine", fetchImpl: down }).quote(ask),
    ).rejects.toBeInstanceOf(TransientError);
    expect(hosts).toEqual(["mine", "keyless", "keyless"]);
    // Only refused keys: still an error, not a hang.
    hosts.length = 0;
    const refused = (async () => json({ error: "Unauthorized" }, 401)()) as typeof fetch;
    await expect(
      new JupiterSwapClient({ apiKey: "mine", fetchImpl: refused }).quote(ask),
    ).rejects.toBeInstanceOf(KeyRefusedError);
  });

  it("asks the keyless host first when told to, and keeps the keys as its fallback", async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key");
      hosts.push(key ?? new URL(url).host);
      return key ? json(quote)() : json({ error: "slow down" }, 429)();
    }) as typeof fetch;
    const client = new JupiterSwapClient({ apiKey: "mine", keylessFirst: true, fetchImpl });
    await client.quote({ inputMint: OWNER, outputMint: quote.outputMint, amount: 1000n, slippageBps: 100 });
    expect(hosts).toEqual(["lite-api.jup.ag", "mine"]);
  });

  it("does not repeat a rate limit on one host, or a missing route", async () => {
    let s = scripted([json({ error: "slow down" }, 429)]);
    await expect(
      new JupiterSwapClient({
        baseUrl: "https://jup.test",
        fetchImpl: s.fetchImpl,
        backupPrices: null,
      }).pricesUsd([OWNER]),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(s.calls()).toBe(1);
    s = scripted([json({ errorCode: "COULD_NOT_FIND_ANY_ROUTE", error: "no route" }, 400)]);
    await expect(
      new JupiterSwapClient({ fetchImpl: s.fetchImpl }).quote({
        inputMint: OWNER,
        outputMint: quote.outputMint,
        amount: 1000n,
        slippageBps: 100,
      }),
    ).rejects.toBeInstanceOf(NoRouteError);
    expect(s.calls()).toBe(1);
  });

  it("asks for the estimate under the cap, or exactly a raised fee (never over the cap)", async () => {
    const s = scripted([built]);
    const client = new JupiterSwapClient({ fetchImpl: s.fetchImpl });
    await client.swapTransaction({ quote, userPublicKey: OWNER, maxPriorityFeeLamports: 2_000_000 });
    await client.swapTransaction({
      quote,
      userPublicKey: OWNER,
      maxPriorityFeeLamports: 2_000_000,
      priorityFeeLamports: 400_000,
    });
    await client.swapTransaction({
      quote,
      userPublicKey: OWNER,
      maxPriorityFeeLamports: 2_000_000,
      priorityFeeLamports: 9_000_000,
    });
    expect(
      s.bodies.map((b) => (b as { prioritizationFeeLamports: unknown }).prioritizationFeeLamports),
    ).toEqual([
      { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "veryHigh" } },
      400_000,
      2_000_000,
    ]);
  });
});

describe("TradingRpc backup endpoint", () => {
  /** A one-route JSON-RPC server: `answer` decides each reply. */
  async function rpcServer(answer: (method: string) => { status: number; body?: unknown }) {
    const { createServer } = await import("node:http");
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const { method } = JSON.parse(raw) as { method: string };
        seen.push(method);
        const out = answer(method);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body ?? {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
  }

  it("sums a wallet's coin balances across its accounts and both token programs", async () => {
    const account = (mint: string, amount: string, decimals = 6) => ({
      account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
    });
    let page = 0;
    const node = await rpcServer(() => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        // Classic token accounts first, then Token-2022's.
        result: {
          value:
            page++ === 0
              ? [account("MintA", "5"), account("MintA", "7"), account("MintB", "0")]
              : [account("MintC", "100", 9)],
        },
      },
    }));
    try {
      const balances = await new TradingRpc({ rpcUrl: node.url }).getWalletBalances(OWNER);
      expect(balances).toEqual([
        { mint: "MintA", raw: 12n, decimals: 6 },
        { mint: "MintC", raw: 100n, decimals: 9 },
      ]);
      expect(node.seen).toEqual(["getTokenAccountsByOwner", "getTokenAccountsByOwner"]);
    } finally {
      await node.close();
    }
  });

  it("reads from the backup when the first RPC doesn't answer, and sends to both", async () => {
    const down = await rpcServer(() => ({ status: 503 }));
    const backup = await rpcServer((method) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: method === "getBalance" ? { value: 42 } : "sig" },
    }));
    try {
      const rpc = new TradingRpc({ rpcUrl: down.url, backupUrl: backup.url });
      expect(await rpc.getBalance(OWNER)).toBe(42n);
      expect(await rpc.send("AAAA")).toBeNull();
      expect(down.seen).toContain("sendTransaction");
      expect(backup.seen).toContain("sendTransaction");
      // A transaction tipping Jito goes to the block engine alone.
      const tipped = Buffer.from(
        buildSolTransfer({
          from: OWNER,
          to: "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
          lamports: 100_000n,
          recentBlockhash: BLOCKHASH,
        }),
      ).toString("base64");
      expect(tipsJito(tipped)).toBe(true);
      down.seen.length = 0;
      backup.seen.length = 0;
      const viaJito = new TradingRpc({ rpcUrl: down.url, backupUrl: down.url, jitoUrl: `${backup.url}/` });
      expect(await viaJito.send(tipped)).toBeNull();
      expect(backup.seen).toEqual(["sendTransaction"]);
      expect(down.seen).toEqual([]);
      // Without a backup the same outage is "no answer".
      expect(await new TradingRpc({ rpcUrl: down.url }).getBalance(OWNER)).toBeNull();
    } finally {
      await down.close();
      await backup.close();
    }
  });

  it("asks the backup when the first RPC answers 200 with a rate limit or out of credits", async () => {
    const backup = await rpcServer(() => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: { value: 7 } },
    }));
    const errors = [
      { code: -32429, message: "rate limited" },
      { code: -32005, message: "Node is behind" },
      { code: -32603, message: "Internal error: rate exceeded" },
      { code: -32000, message: "max usage reached" },
      { code: -32000, message: "You've run out of credits" },
      { code: -32000, message: "Too many requests for a specific RPC call" },
    ];
    try {
      for (const error of errors) {
        const first = await rpcServer(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, error } }));
        try {
          const rpc = new TradingRpc({ rpcUrl: first.url, backupUrl: backup.url });
          expect(await rpc.getBalance(OWNER), error.message).toBe(7n);
          // Asked once: the backup is the retry.
          expect(first.seen).toEqual(["getBalance"]);
        } finally {
          await first.close();
        }
      }
      // A real error is an answer: the backup isn't asked, and the read is null.
      backup.seen.length = 0;
      const refusing = await rpcServer(() => ({
        status: 200,
        body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: WrongSize" } },
      }));
      try {
        expect(
          await new TradingRpc({ rpcUrl: refusing.url, backupUrl: backup.url }).getBalance(OWNER),
        ).toBeNull();
        expect(backup.seen).toEqual([]);
      } finally {
        await refusing.close();
      }
    } finally {
      await backup.close();
    }
  });

  it("tells the not-now errors from real ones", () => {
    expect(isNotNowRpcError({ code: -32429, message: "" })).toBe(true);
    expect(isNotNowRpcError({ code: -32603, message: "Internal error" })).toBe(false);
    expect(isNotNowRpcError({ code: -32603, message: "rate limit exceeded" })).toBe(true);
    expect(isNotNowRpcError({ code: -32002, message: "Transaction simulation failed" })).toBe(false);
  });

  it("reads many signatures' statuses in one call, recent ones only when asked", async () => {
    const params: unknown[] = [];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { params: unknown[] };
        params.push(body.params[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { value: [null, { err: null, confirmationStatus: "confirmed" }, { err: { x: 1 } }] },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const rpc = new TradingRpc({
        rpcUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      });
      expect(await rpc.getSignatureStatuses(["a", "b", "c"], { searchHistory: false })).toEqual([
        { seen: false },
        { seen: true, confirmed: true, error: null },
        { seen: true, confirmed: false, error: '{"x":1}' },
      ]);
      // A count that doesn't match the ask is no answer.
      expect(await rpc.getSignatureStatus("a")).toBeNull();
      expect(params).toEqual([{ searchTransactionHistory: false }, { searchTransactionHistory: true }]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("Helius Sender", () => {
  it("sends once more without the key when Sender turns the key away, and only then", async () => {
    const { createServer } = await import("node:http");
    const seen: string[] = [];
    let keyedStatus = 401;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const keyed = new URL(req.url!, "http://x").searchParams.has("api-key");
        seen.push(keyed ? "keyed" : "keyless");
        const status = keyed ? keyedStatus : 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { jsonrpc: "2.0", id: 1, result: "sig" } : {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fast`;
    try {
      const keyedUrl = senderUrl(base, { speed: "eco", mevProtect: true, apiKey: "k" });
      for (const status of [401, 403, 429]) {
        keyedStatus = status;
        seen.length = 0;
        expect(await sendViaSender(keyedUrl, "AAAA")).toEqual({ ok: true });
        expect(seen).toEqual(["keyed", "keyless"]);
      }
      // Another refusal is the transaction's, not the key's: no second send.
      keyedStatus = 400;
      seen.length = 0;
      expect(await sendViaSender(keyedUrl, "AAAA")).toMatchObject({ ok: false, refused: true });
      expect(seen).toEqual(["keyed"]);
      // A keyless URL has nothing to drop.
      keyedStatus = 401;
      seen.length = 0;
      expect(await sendViaSender(senderUrl(base, { speed: "eco", mevProtect: true }), "AAAA")).toEqual({
        ok: true,
      });
      expect(seen).toEqual(["keyless"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
