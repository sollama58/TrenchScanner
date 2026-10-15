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
} from "./transaction.js";
import {
  createKeyProvider,
  createKmsKeyProvider,
  createLocalKeyProvider,
  generateWalletKeypair,
  openWalletSecret,
  sealWalletSecret,
} from "./keyVault.js";
import { decideExit, ladderSoldFraction, sellAmount } from "./exitEngine.js";
import { associatedTokenAddress, checkInstructions, PROGRAM } from "./txGuard.js";
import { JupiterSwapClient, NoRouteError, RateLimitedError, type SwapQuote } from "./jupiterSwap.js";
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

  it("sells half at 2x", () => {
    expect(decideExit(fresh, 2.1, at(5), EXIT_PLAN)).toMatchObject({
      action: "sell",
      fraction: 0.5,
      all: false,
      reason: "take_profit",
      rung: 0,
    });
  });

  it("closes a call that never sold at 30 minutes", () => {
    expect(decideExit(fresh, 1.2, at(30), EXIT_PLAN)).toMatchObject({ action: "sell", reason: "max_hold" });
  });

  it("rides the rest on a trail 35% off the high, which ratchets up", () => {
    const sold = { openedAt: opened, rungsTaken: 1, highMultiple: 2 };
    const up = decideExit(sold, 5, at(40), EXIT_PLAN);
    expect(up).toEqual({ action: "hold", highMultiple: 5 });
    // 5x high: the level is 3.25x.
    expect(decideExit({ ...sold, highMultiple: 5 }, 3.3, at(41), EXIT_PLAN).action).toBe("hold");
    expect(decideExit({ ...sold, highMultiple: 5 }, 3.2, at(41), EXIT_PLAN)).toMatchObject({
      action: "sell",
      all: true,
      reason: "trailing_stop",
    });
  });

  it("does not stop out below -50% after the sale (the trail owns the rest), and closes at 3 hours", () => {
    const sold = { openedAt: opened, rungsTaken: 1, highMultiple: 2 };
    expect(decideExit(sold, 1.25, at(60), EXIT_PLAN)).toMatchObject({ reason: "trailing_stop" });
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
    await expect(new JupiterSwapClient({ fetchImpl: down }).pricesUsd([OWNER])).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(thrown).toBe(2);
  });

  it("does not repeat a rate limit or a missing route", async () => {
    let s = scripted([json({ error: "slow down" }, 429)]);
    await expect(new JupiterSwapClient({ fetchImpl: s.fetchImpl }).pricesUsd([OWNER])).rejects.toBeInstanceOf(
      RateLimitedError,
    );
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
