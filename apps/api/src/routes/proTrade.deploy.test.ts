// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildSolTransfer,
  HELIUS_SENDER_TIP_ACCOUNTS,
  loadEnv,
  parseWireTransaction,
  prisma,
  sendViaSender,
  signTransaction,
  type Env,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { newBuildId, signBuildToken } from "../buildToken.js";

/**
 * Trades across API instances (trading robustness audit 2026-10-19, #2): a send on an instance
 * that never saw the build, a trade another instance sent picked up at boot, and "expired"
 * answered from the trade's row. The chain and Sender are stand-ins; the database is real.
 */

const chain = vi.hoisted(() => ({ height: 10_000, seen: new Set<string>() }));

vi.mock("@trenchscanner/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@trenchscanner/core")>();
  class ChainRpc extends core.TradingRpc {
    override async getBlockHeight() {
      return chain.height;
    }
    override async getSignatureStatus(signature: string) {
      return chain.seen.has(signature)
        ? { seen: true as const, confirmed: true, error: null }
        : { seen: false as const };
    }
  }
  return { ...core, TradingRpc: ChainRpc, sendViaSender: vi.fn(async () => ({ ok: true as const })) };
});

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    address: bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)),
    seed: Uint8Array.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)),
  };
};
const TRADER = keyPair();
const MINT = "So11111111111111111111111111111111111111112";
const TIP = HELIUS_SENDER_TIP_ACCOUNTS[0]!;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** A trade for TRADER that tips Sender: unsigned, and signed with a priority fee of its own. */
function trade(microLamportsPerUnit = 0n) {
  const blockhash = bs58.encode(randomBytes(32));
  const unsigned = (micro: bigint) =>
    buildSolTransfer({
      from: TRADER.address,
      to: TIP,
      lamports: 1_000_000n,
      recentBlockhash: blockhash,
      microLamportsPerUnit: micro,
    });
  const built = unsigned(0n);
  const sign = (micro: bigint) => {
    const { signed, signature } = signTransaction(unsigned(micro), TRADER.seed, TRADER.address);
    return { base64: Buffer.from(signed).toString("base64"), signature };
  };
  return { message: parseWireTransaction(built).message, sign, first: sign(microLamportsPerUnit) };
}

describe.skipIf(!dbAvailable)("Pro trades across API instances", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: TRADER.address, PRO_TRADING_ENABLED: true }
    : (undefined as never);
  const servers: FastifyInstance[] = [];
  let cookie = "";
  let userId = "";
  /** A new API instance: nothing in memory, as after a deploy. */
  const instance = async () => {
    const app = await buildServer(env);
    servers.push(app);
    return app;
  };
  const send = (app: FastifyInstance, payload: object) =>
    app.inject({
      method: "POST",
      url: "/pro/trade/send",
      payload: { speed: "turbo", mevProtect: true, ...payload },
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
  const tokenFor = (message: Uint8Array, over: { closing?: boolean } = {}) =>
    signBuildToken(env.JWT_SECRET, {
      id: newBuildId(),
      wallet: TRADER.address,
      message: Buffer.from(message).toString("base64"),
      lastValidBlockHeight: chain.height + 150,
      side: "sell",
      access: false,
      closing: over.closing ?? true,
      mint: MINT,
      lamports: 50_000_000n,
      networkFeeLamports: 25_000n,
      sacrifice: { mode: "off", tier: null, pays: false, asdfRaw: null, lamports: null, asdfPerSol: null },
      expiresAt: Date.now() + 120_000,
    });

  beforeAll(async () => {
    await prisma.platformTrade.deleteMany({ where: { wallet: TRADER.address } });
    const user = await prisma.user.create({ data: { walletAddress: TRADER.address } });
    userId = user.id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: TRADER.address,
    });
  });

  afterEach(async () => {
    // Everything lands, so each instance's shutdown drain ends at once.
    for (const t of await prisma.platformTrade.findMany({ where: { wallet: TRADER.address } }))
      chain.seen.add(t.signature);
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await prisma.platformTrade.deleteMany({ where: { wallet: TRADER.address } });
    vi.mocked(sendViaSender).mockClear();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("sends a build on an instance that never saw it, once per build across instances", async () => {
    const t = trade();
    const token = tokenFor(t.message);
    // Without its token (a panel from before build tokens), a build this instance didn't make is refused.
    const fresh = await instance();
    const old = await send(fresh, { transaction: t.first.base64 });
    expect(old.statusCode).toBe(400);
    expect(old.json()).toMatchObject({ notSent: true });
    // With it, it goes out, and its row carries what any instance needs to resend it.
    const res = await send(fresh, { transaction: t.first.base64, buildToken: token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signature: t.first.signature });
    expect(sendViaSender).toHaveBeenCalledWith(expect.stringContaining("mev-protect=true"), t.first.base64);
    const row = await prisma.platformTrade.findUniqueOrThrow({ where: { signature: t.first.signature } });
    expect(row).toMatchObject({
      status: "sent",
      transaction: t.first.base64,
      lastValidBlockHeight: BigInt(chain.height + 150),
      senderSpeed: "turbo",
      senderMevProtect: true,
    });
    expect(row.buildId).toBeTruthy();
    // The same build signed again with another priority fee, on yet another instance: refused.
    const variant = t.sign(7n);
    expect(variant.signature).not.toBe(t.first.signature);
    const again = await send(await instance(), { transaction: variant.base64, buildToken: token });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ notSent: true });
    // The same signature again (a retried request): already out, so it answers with it.
    const retried = await send(await instance(), { transaction: t.first.base64, buildToken: token });
    expect(retried.json()).toEqual({ signature: t.first.signature });
    const sent = vi.mocked(sendViaSender).mock.calls.map((c) => c[1]);
    expect(sent).not.toContain(variant.base64);
    expect(new Set(sent)).toEqual(new Set([t.first.base64]));
  });

  it("refuses a transaction its token doesn't cover, or a tampered token", async () => {
    const app = await instance();
    const t = trade();
    const other = trade();
    const token = tokenFor(other.message);
    const mismatched = await send(app, { transaction: t.first.base64, buildToken: token });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ notSent: true });
    const [payload, mac] = tokenFor(t.message).split(".") as [string, string];
    const tampered = await send(app, {
      transaction: t.first.base64,
      buildToken: `${payload}.${mac.slice(1)}A`,
    });
    expect(tampered.statusCode).toBe(400);
    expect(sendViaSender).not.toHaveBeenCalled();
  });

  it("resumes resending at boot a trade another instance sent, and not one past its blockhash", async () => {
    const live = trade().first;
    const expired = trade().first;
    const row = (sig: string, tx: string, lastValidBlockHeight: number) => ({
      signature: sig,
      wallet: TRADER.address,
      mint: MINT,
      side: "buy",
      lamports: 20_000_000n,
      networkFeeLamports: 25_000n,
      transaction: tx,
      lastValidBlockHeight: BigInt(lastValidBlockHeight),
      senderSpeed: "eco",
      senderMevProtect: false,
    });
    await prisma.platformTrade.createMany({
      data: [
        row(live.signature, live.base64, chain.height + 100),
        row(expired.signature, expired.base64, chain.height - 1),
      ],
    });
    await instance();
    await vi.waitFor(
      () =>
        expect(sendViaSender).toHaveBeenCalledWith(expect.stringContaining("swqos_only=true"), live.base64),
      { timeout: 6_000, interval: 100 },
    );
    expect(vi.mocked(sendViaSender).mock.calls.map((c) => c[1])).not.toContain(expired.base64);
    const url = vi.mocked(sendViaSender).mock.calls[0]![0];
    expect(url).not.toContain("mev-protect");
    // The key comes from this instance's env, never from the row.
    if (env.HELIUS_API_KEY) expect(url).toContain("api-key=");
  });

  it("answers expired from the row on an instance that didn't send it", async () => {
    const app = await instance();
    const gone = trade().first;
    const open = trade().first;
    await prisma.platformTrade.createMany({
      data: [
        { sig: gone.signature, h: chain.height - 50 },
        { sig: open.signature, h: chain.height + 100 },
      ].map(({ sig, h }) => ({
        signature: sig,
        wallet: TRADER.address,
        mint: MINT,
        side: "buy",
        lamports: 20_000_000n,
        networkFeeLamports: 25_000n,
        lastValidBlockHeight: BigInt(h),
      })),
    });
    const status = (sig: string) =>
      app
        .inject({
          method: "GET",
          url: `/pro/trade/status/${sig}`,
          cookies: { [SESSION_COOKIE_NAME]: cookie },
        })
        .then((r) => r.json());
    expect(await status(gone.signature)).toEqual({ state: "expired" });
    expect(await status(open.signature)).toEqual({ state: "pending" });
    await vi.waitFor(async () =>
      expect(
        (await prisma.platformTrade.findUniqueOrThrow({ where: { signature: gone.signature } })).status,
      ).toBe("expired"),
    );
  });
});
