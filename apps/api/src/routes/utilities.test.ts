// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BURN_CREDIT_MEMO,
  DAILY_FREE_CREDITS,
  DexScreenerClient,
  FREE_LOOKUP_NOTE,
  loadEnv,
  prisma,
  SolanaRpc,
  SPL_TOKEN_PROGRAM_ID,
  SUBSCRIPTION_MINT,
  type CandidateToken,
  type ParsedTransaction,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `utilities-route-test-${Date.now()}`;
const TOKENS = 10n ** 6n;

/** A fresh base58 address or signature per call, so rows never collide across runs. */
const random = (bytes: number) =>
  bs58.encode(Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))));

describe.skipIf(!dbAvailable)("utility routes", () => {
  let app: FastifyInstance;
  const adminWallet = random(32);
  const env = loadEnv({ ...process.env, ADMIN_WALLET_ADDRESSES: adminWallet });
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
  const wallets: string[] = [adminWallet];
  const mints: string[] = [];

  beforeAll(async () => {
    app = await buildServer(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: { in: wallets } } });
    await prisma.burnEvent.deleteMany({ where: { burnerWallet: { in: wallets } } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: wallets } } });
    await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
  });

  /** A signed-in wallet, subscribed unless asked otherwise (Utilities sits behind the paywall). */
  async function signIn({ subscribed = true, walletAddress = random(32) } = {}) {
    if (!wallets.includes(walletAddress)) wallets.push(walletAddress);
    const user = await prisma.user.create({
      data: {
        walletAddress,
        ...(subscribed
          ? { subscription: { create: { expiresAt: new Date(Date.now() + 86_400_000), source: "BURN" } } }
          : {}),
      },
    });
    const cookie = await signer.sign({ userId: user.id, walletAddress, sessionVersion: 0 });
    return { walletAddress, cookies: { [SESSION_COOKIE_NAME]: cookie } };
  }

  function burnTx(
    signature: string,
    authority: string,
    tokens: bigint,
    memo: string | null,
  ): ParsedTransaction {
    return {
      slot: 1,
      blockTime: Math.floor(Date.now() / 1000),
      transaction: {
        signatures: [signature],
        message: {
          instructions: [
            {
              program: "spl-token",
              programId: SPL_TOKEN_PROGRAM_ID,
              parsed: {
                type: "burn",
                info: { mint: SUBSCRIPTION_MINT, authority, amount: (tokens * TOKENS).toString() },
              },
            },
            ...(memo === null ? [] : [{ program: "spl-memo", parsed: memo }]),
          ],
        },
      },
      meta: { err: null, innerInstructions: null },
    };
  }

  function reading(mint: string): CandidateToken {
    return {
      mintAddress: mint,
      symbol: "TEST",
      name: "Test coin",
      priceUsd: 0.0001,
      marketCapUsd: 100_000,
      liquidityUsd: 20_000,
      volume24hUsd: 50_000,
      buys24h: 300,
      sells24h: 200,
      pairCreatedAt: new Date(Date.now() - 30 * 60_000),
    };
  }

  async function grant(wallet: string, credits: number) {
    await prisma.burnCreditEntry.create({
      data: { wallet, delta: credits, kind: "grant", source: "granted", note: TAG },
    });
  }

  /** Uses up a subscriber's free daily credits, so a lookup is paid from the balance. */
  async function useDailyFree(wallet: string) {
    await prisma.burnCreditEntry.create({
      data: { wallet, delta: -DAILY_FREE_CREDITS, kind: "spend", source: "daily", note: TAG },
    });
  }

  it("sits behind the subscription", async () => {
    const lapsed = await signIn({ subscribed: false });
    const res = await app.inject({ method: "GET", url: "/utilities", cookies: lapsed.cookies });
    expect(res.statusCode).toBe(402);
  });

  it("credits a burn tagged for credits, at the ratio, once", async () => {
    const me = await signIn();
    const signature = random(64);
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValue(
      burnTx(signature, me.walletAddress, 1_500n, BURN_CREDIT_MEMO),
    );
    const first = await app.inject({
      method: "POST",
      url: "/utilities/claim",
      cookies: me.cookies,
      payload: { signature },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "credited", credits: 15, balance: 15 });

    const again = await app.inject({
      method: "POST",
      url: "/utilities/claim",
      cookies: me.cookies,
      payload: { signature },
    });
    expect(again.json()).toMatchObject({ status: "already_credited", balance: 15 });

    // A burn tagged for credits can't buy subscription months, however large.
    const big = random(64);
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValue(
      burnTx(big, me.walletAddress, 200_000n, BURN_CREDIT_MEMO),
    );
    const sub = await app.inject({
      method: "POST",
      url: "/subscription/claim",
      cookies: me.cookies,
      payload: { signature: big },
    });
    expect(sub.statusCode).toBe(400);
    expect(sub.json().error).toMatch(/Burn Credits/);
  });

  it("refuses a burn without the credits tag, and credits another wallet's burn to that wallet", async () => {
    const me = await signIn();
    const other = random(32);
    wallets.push(other);
    const untagged = random(64);
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValueOnce(
      burnTx(untagged, me.walletAddress, 500n, null),
    );
    const res = await app.inject({
      method: "POST",
      url: "/utilities/claim",
      cookies: me.cookies,
      payload: { signature: untagged },
    });
    expect(res.statusCode).toBe(400);

    const theirs = random(64);
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValueOnce(
      burnTx(theirs, other, 500n, BURN_CREDIT_MEMO),
    );
    const held = await app.inject({
      method: "POST",
      url: "/utilities/claim",
      cookies: me.cookies,
      payload: { signature: theirs },
    });
    expect(held.statusCode).toBe(202);
    const entry = await prisma.burnCreditEntry.findUniqueOrThrow({ where: { burnSignature: theirs } });
    expect(entry.wallet).toBe(other);
  });

  it("charges a token lookup only once it succeeds, and lets it be re-opened free", async () => {
    const me = await signIn();
    await useDailyFree(me.walletAddress);
    await grant(me.walletAddress, 1);
    const mint = random(32);
    mints.push(mint);
    const lookup = vi
      .spyOn(DexScreenerClient.prototype, "getTokensByAddresses")
      .mockResolvedValue([reading(mint)]);

    // Not paid for yet: the view is closed.
    const closed = await app.inject({ method: "GET", url: `/utilities/token/${mint}`, cookies: me.cookies });
    expect(closed.statusCode).toBe(402);

    const res = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: me.cookies,
      payload: { mint },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mint, charged: 1, balance: 0 });

    // A new mint is on Token, stamped as viewed so the scan picks it up.
    const token = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint } });
    expect(token.lastViewedAt).not.toBeNull();
    expect(token.discoverySource).toBe("utility");

    const view = await app.inject({ method: "GET", url: `/utilities/token/${mint}`, cookies: me.cookies });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      scan: "scanning",
      card: { kind: "stream", curated: null, snapshot: { marketCapUsd: 100_000 } },
    });

    // Looking it up again is free, even with no credits left.
    const reopen = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: me.cookies,
      payload: { mint },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toMatchObject({ charged: 0, balance: 0 });
    expect(lookup).toHaveBeenCalledTimes(2);
    // A person is waiting: the lookup takes the budget's reserved slots instead of queueing behind
    // the live refreshes, and asks the fallback about a mint DexScreener hasn't listed yet.
    expect(lookup).toHaveBeenCalledWith(
      [mint],
      1,
      expect.objectContaining({ priority: true, fallbackIfUnlisted: [mint] }),
    );
  });

  it("looks a coin the scanner already tracks up free, and says so before it runs", async () => {
    const me = await signIn();
    const mint = random(32);
    mints.push(mint);
    // On the feed: found by the scanner itself, not by a lookup.
    await prisma.token.create({
      data: {
        mintAddress: mint,
        symbol: "TRK",
        name: "Tracked coin",
        firstSeenAt: new Date(),
        discoverySource: "pumpfun",
      },
    });
    vi.spyOn(DexScreenerClient.prototype, "getTokensByAddresses").mockResolvedValue([reading(mint)]);

    const quote = await app.inject({
      method: "GET",
      url: `/utilities/quote?utility=token&subject=${mint}`,
      cookies: me.cookies,
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ cost: 0, free: "tracked" });

    // No credits at all, and the lookup still opens.
    const res = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: me.cookies,
      payload: { mint },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mint, charged: 0, balance: 0, free: "tracked" });
    const entry = await prisma.burnCreditEntry.findFirstOrThrow({
      where: { wallet: me.walletAddress, kind: "spend" },
    });
    expect(entry).toMatchObject({ delta: 0, note: FREE_LOOKUP_NOTE });
    const view = await app.inject({ method: "GET", url: `/utilities/token/${mint}`, cookies: me.cookies });
    expect(view.statusCode).toBe(200);

    // An untracked coin still quotes its price.
    const other = await app.inject({
      method: "GET",
      url: `/utilities/quote?utility=token&subject=${random(32)}`,
      cookies: me.cookies,
    });
    expect(other.json()).toMatchObject({ cost: 1, free: null });
  });

  it("takes nothing for an address no market knows, and refuses a lookup it can't pay for", async () => {
    const me = await signIn();
    await grant(me.walletAddress, 1);
    vi.spyOn(DexScreenerClient.prototype, "getTokensByAddresses").mockResolvedValue([]);
    const missing = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: me.cookies,
      payload: { mint: random(32) },
    });
    expect(missing.statusCode).toBe(404);

    const broke = await signIn();
    await useDailyFree(broke.walletAddress);
    const res = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: broke.cookies,
      payload: { mint: random(32) },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "not_enough_credits", balance: 0, cost: 1 });

    const overview = await app.inject({ method: "GET", url: "/utilities", cookies: me.cookies });
    expect(overview.json()).toMatchObject({ balance: 1, prices: { tokensPerCredit: 100 } });
  });

  it("pays a subscriber's lookups from the free daily credits first, and never past them", async () => {
    const me = await signIn();
    await grant(me.walletAddress, 1);
    vi.spyOn(DexScreenerClient.prototype, "getTokensByAddresses").mockImplementation(async (mints) =>
      mints.map(reading),
    );
    const lookUp = (mint: string) =>
      app.inject({ method: "POST", url: "/utilities/token", cookies: me.cookies, payload: { mint } });
    const first = await lookUp(random(32));
    expect(first.json()).toMatchObject({
      charged: 1,
      freeCredits: 1,
      freeLeft: DAILY_FREE_CREDITS - 1,
      balance: 1,
    });
    const overview = await app.inject({ method: "GET", url: "/utilities", cookies: me.cookies });
    expect(overview.json()).toMatchObject({
      balance: 1,
      daily: { allowance: DAILY_FREE_CREDITS, left: DAILY_FREE_CREDITS - 1 },
    });
    expect(overview.json().lookups[0]).toMatchObject({ cost: 1, freeCredits: 1 });

    for (let i = 1; i < DAILY_FREE_CREDITS; i++) await lookUp(random(32));
    // The allowance is spent: the next lookup takes the granted credit, the one after is refused.
    expect((await lookUp(random(32))).json()).toMatchObject({
      charged: 1,
      freeCredits: 0,
      freeLeft: 0,
      balance: 0,
    });
    const broke = await lookUp(random(32));
    expect(broke.statusCode).toBe(402);
    expect(broke.json()).toMatchObject({ code: "not_enough_credits", balance: 0, freeLeft: 0 });
  });

  it("lets an admin award credits to any wallet, while the admin's own lookups still cost credits", async () => {
    const admin = await signIn({ walletAddress: adminWallet });
    const me = await signIn();
    const award = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      cookies: admin.cookies,
      payload: { wallet: me.walletAddress, delta: 5, note: TAG },
    });
    expect(award.statusCode).toBe(200);
    expect(award.json()).toMatchObject({ wallet: me.walletAddress, balance: 5 });

    // Only admins can award.
    const refused = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      cookies: me.cookies,
      payload: { wallet: me.walletAddress, delta: 5 },
    });
    expect(refused.statusCode).toBe(403);

    // Being an admin doesn't make a lookup free.
    vi.spyOn(DexScreenerClient.prototype, "getTokensByAddresses").mockImplementation(async (mints) =>
      mints.map(reading),
    );
    const res = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: admin.cookies,
      payload: { mint: random(32) },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "not_enough_credits", balance: 0 });
  });

  it("charges a wallet lookup once the profile loads, and re-opens it free", async () => {
    const me = await signIn();
    await useDailyFree(me.walletAddress);
    await grant(me.walletAddress, 1);
    const target = random(32);
    const res = await app.inject({
      method: "POST",
      url: "/utilities/wallet",
      cookies: me.cookies,
      payload: { wallet: target },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wallet: target, charged: 1, balance: 0 });

    const reopen = await app.inject({
      method: "POST",
      url: "/utilities/wallet",
      cookies: me.cookies,
      payload: { wallet: target },
    });
    expect(reopen.json()).toMatchObject({ charged: 0, balance: 0 });

    const other = await app.inject({
      method: "POST",
      url: "/utilities/wallet",
      cookies: me.cookies,
      payload: { wallet: random(32) },
    });
    expect(other.statusCode).toBe(402);

    const overview = await app.inject({ method: "GET", url: "/utilities", cookies: me.cookies });
    expect(overview.json().lookups[0]).toMatchObject({ utility: "wallet", subject: target, open: true });
  });
  it("serves the Side Wallet Checker free, with each side wallet's labels", async () => {
    const me = await signIn();
    const kol = random(32);
    const side = random(32);
    wallets.push(kol, side);
    await prisma.kolWallet.create({
      data: { wallet: kol, name: "Route KOL", twitter: "routekol", seenAt: new Date() },
    });
    const entry = { wallet: side, shared: 3, pct: 75, coins: 5, gapSec: 12 };
    await prisma.kolSideWallets.create({
      data: {
        wallet: kol,
        coins24h: 1,
        coins7d: 2,
        coins30d: 4,
        sides: { "24h": [], "7d": [], "30d": [entry] },
        computedAt: new Date(),
      },
    });
    await prisma.walletRisk.create({
      data: {
        wallet: side,
        score: 61.4,
        appearances: 5,
        dumps: 3,
        fastExits: 0,
        snipes: 0,
        dumper: true,
        solIn: 1,
        solOut: 1,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      },
    });
    try {
      const board = await app.inject({ method: "GET", url: "/utilities/side-wallets", cookies: me.cookies });
      expect(board.statusCode).toBe(200);
      expect(board.json().kols.find((k: { wallet: string }) => k.wallet === kol)).toEqual({
        wallet: kol,
        name: "Route KOL",
        twitter: "routekol",
        // No X picture read for it yet: the list shows its letter.
        avatar: null,
        knownSideOf: null,
        coins: { "24h": 1, "7d": 2, "30d": 4 },
        sides: { "24h": 0, "7d": 0, "30d": 1 },
        // Flagged Wallets counts labeled possible sides (possibleSides.ts); none seeded here.
        flagged: 0,
      });
      expect(board.json().rules).toMatchObject({
        minShared: { "24h": 5, "7d": 15, "30d": 25 },
        minPct: 50,
        bot: { minCoins: 200, minPct: 50 },
        holdDays: 90,
      });

      const one = await app.inject({
        method: "GET",
        url: `/utilities/side-wallets/${kol}`,
        cookies: me.cookies,
      });
      expect(one.statusCode).toBe(200);
      expect(one.json().sides["30d"]).toEqual([
        { ...entry, risk: { score: 61, dumper: true, winner: false, sniper: false } },
      ]);
      // Free: no credit is taken.
      const overview = await app.inject({ method: "GET", url: "/utilities", cookies: me.cookies });
      expect(overview.json()).toMatchObject({ balance: 0, lookups: [] });

      const missing = await app.inject({
        method: "GET",
        url: `/utilities/side-wallets/${random(32)}`,
        cookies: me.cookies,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await prisma.kolSideWallets.deleteMany({ where: { wallet: kol } });
      await prisma.kolWallet.deleteMany({ where: { wallet: kol } });
      await prisma.walletRisk.deleteMany({ where: { wallet: side } });
    }
  });

  it("compares a KOL and one wallet coin by coin, with both funders", async () => {
    const me = await signIn();
    const kol = random(32);
    const side = random(32);
    const funder = random(32);
    wallets.push(kol, side);
    await prisma.kolWallet.create({ data: { wallet: kol, name: "Pair KOL", seenAt: new Date() } });
    await prisma.walletFunder.createMany({
      data: [
        { wallet: kol, status: "found", funder, amountSol: 5, fundedAt: new Date() },
        { wallet: side, status: "found", funder, amountSol: 1, fundedAt: new Date() },
      ],
    });
    const now = Date.now();
    const mints: string[] = [];
    // Two coins together (the wallet 30s after, then 20s before), one an hour apart.
    for (const [i, gapMs] of [30_000, -20_000, 3_600_000].entries()) {
      const mint = random(32);
      mints.push(mint);
      const token = await prisma.token.create({ data: { mintAddress: mint, symbol: `PAIR${i}` } });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(),
          reason: "called",
          status: "done",
          windowEnd: new Date(),
        },
      });
      const at = now - (i + 1) * 3_600_000;
      await prisma.tokenWalletActivity.createMany({
        data: [
          {
            tokenId: token.id,
            wallet: kol,
            buys: 1,
            sells: 1,
            solIn: 2,
            solOut: 3,
            firstBuyAt: new Date(at),
            firstSellAt: new Date(at + 600_000),
          },
          {
            tokenId: token.id,
            wallet: side,
            buys: 1,
            sells: 1,
            solIn: 1,
            solOut: 1.5,
            firstBuyAt: new Date(at + gapMs),
            firstSellAt: new Date(at + 660_000),
          },
        ],
      });
    }
    try {
      const res = await app.inject({
        method: "GET",
        url: `/utilities/side-wallets/${kol}/${side}?window=7d`,
        cookies: me.cookies,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fundingLink).toBe("same-funder");
      expect(body.kolCoins).toBe(3);
      expect(body.trades.map((t: { symbol: string }) => t.symbol)).toEqual(["PAIR0", "PAIR1"]);
      expect(body.trades[0]).toMatchObject({ gapSec: 30, sellGapSec: 60 });
      expect(body.summary).toMatchObject({
        shared: 2,
        before: 1,
        after: 1,
        bothSold: 2,
        exitedTogether: 2,
        medianSizeRatio: 0.5,
      });

      // Any wallet, KOL or not (a Multi-Wallet-Bundle opens the same comparison): none shared here.
      const other = await app.inject({
        method: "GET",
        url: `/utilities/side-wallets/${random(32)}/${side}`,
        cookies: me.cookies,
      });
      expect(other.statusCode).toBe(200);
      expect(other.json()).toMatchObject({ kolCoins: 0, trades: [] });
    } finally {
      await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
      await prisma.walletFunder.deleteMany({ where: { wallet: { in: [kol, side] } } });
      await prisma.kolWallet.deleteMany({ where: { wallet: kol } });
    }
  });
});
