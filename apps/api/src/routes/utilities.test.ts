// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BURN_CREDIT_MEMO,
  DexScreenerClient,
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
  const env = loadEnv({ ...process.env });
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
  const wallets: string[] = [];
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

  async function signIn() {
    const walletAddress = random(32);
    wallets.push(walletAddress);
    const user = await prisma.user.create({ data: { walletAddress } });
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
    await prisma.burnCreditEntry.create({ data: { wallet, delta: credits, kind: "grant", note: TAG } });
  }

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
    expect(first.json()).toMatchObject({ status: "credited", credits: 3, balance: 3 });

    const again = await app.inject({
      method: "POST",
      url: "/utilities/claim",
      cookies: me.cookies,
      payload: { signature },
    });
    expect(again.json()).toMatchObject({ status: "already_credited", balance: 3 });

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
    const res = await app.inject({
      method: "POST",
      url: "/utilities/token",
      cookies: broke.cookies,
      payload: { mint: random(32) },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "not_enough_credits", balance: 0, cost: 1 });

    const overview = await app.inject({ method: "GET", url: "/utilities", cookies: me.cookies });
    expect(overview.json()).toMatchObject({ balance: 1, prices: { tokensPerCredit: 500 } });
  });
});
