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

const chain = vi.hoisted(() => ({ height: 10_000, seen: new Set<string>(), rpcSends: [] as string[] }));

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
    // The resend loop reads them all at once.
    override async getSignatureStatuses(signatures: string[]) {
      return Promise.all(signatures.map((s) => this.getSignatureStatus(s)));
    }
    // The RPC fallback's sends: recorded, never sent.
    override async send(base64Tx: string) {
      chain.rpcSends.push(base64Tx);
      return null;
    }
  }
  return { ...core, TradingRpc: ChainRpc, sendViaSender: vi.fn(async () => ({ ok: true as const })) };
});

const SENDER_OK = async () => ({ ok: true as const });
/** Sender not answering: a timeout, which may have gone out. */
const SENDER_SILENT = async () => ({ ok: false as const, refused: false, error: "timed out" });

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
  const senderCalls = (base64: string) =>
    vi.mocked(sendViaSender).mock.calls.filter((c) => c[1] === base64).length;
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
    // mockClear leaves a queued mockImplementationOnce, which then refuses the next test's send.
    vi.mocked(sendViaSender).mockReset();
    vi.mocked(sendViaSender).mockImplementation(SENDER_OK);
    chain.rpcSends.length = 0;
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
  it("lets only one of two trades sent at once through the 1-second limit, and gives it back when nothing went out", async () => {
    const app = await instance();
    const a = trade();
    const b = trade();
    const both = await Promise.all([
      send(app, { transaction: a.first.base64, buildToken: tokenFor(a.message, { closing: false }) }),
      send(app, { transaction: b.first.base64, buildToken: tokenFor(b.message, { closing: false }) }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 429]);
    expect(both.find((r) => r.statusCode === 429)!.json()).toMatchObject({ notSent: true });
    expect(vi.mocked(sendViaSender)).toHaveBeenCalledTimes(1);
    expect(await prisma.platformTrade.count({ where: { wallet: TRADER.address } })).toBe(1);

    // The trade that went out holds the pace for a second, in memory and in the row. Wait it out
    // so the refusal below is the sender's, not that pace.
    await new Promise((r) => setTimeout(r, 1_100));

    // Sender refusing a trade sends nothing, so the next one isn't held back by it.
    const other = await instance();
    vi.mocked(sendViaSender).mockImplementationOnce(async () => ({
      ok: false as const,
      refused: true,
      error: "HTTP 400",
    }));
    const c = trade();
    const d = trade();
    const refused = await send(other, {
      transaction: c.first.base64,
      buildToken: tokenFor(c.message, { closing: false }),
    });
    expect(refused.statusCode).toBe(409);
    const next = await send(other, {
      transaction: d.first.base64,
      buildToken: tokenFor(d.message, { closing: false }),
    });
    expect(next.statusCode).toBe(200);
  });

  it("sends nothing when the trade row cannot be recorded, then a later send still can", async () => {
    const app = await instance();
    const t = trade();
    const token = tokenFor(t.message, { closing: false });
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
    try {
      const res = await send(app, { transaction: t.first.base64, buildToken: token });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        notSent: true,
        error: "Couldn't record the trade just now. Nothing was sent; try again.",
      });
      expect(vi.mocked(sendViaSender)).not.toHaveBeenCalled();
      expect(await prisma.platformTrade.count({ where: { wallet: TRADER.address } })).toBe(0);
    } finally {
      tx.mockRestore();
    }
    // The cooldown was given back, and no row was written, so a new signature of that build goes out.
    const again = t.sign(7n);
    const next = await send(app, { transaction: again.base64, buildToken: token });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual({ signature: again.signature });
    expect(vi.mocked(sendViaSender)).toHaveBeenCalledTimes(1);
  });

  it("holds the 1-second limit across two instances", async () => {
    const a = await instance();
    const b = await instance();
    const first = trade();
    const second = trade();
    const sent = await send(a, {
      transaction: first.first.base64,
      buildToken: tokenFor(first.message, { closing: false }),
    });
    expect(sent.statusCode).toBe(200);
    const held = await send(b, {
      transaction: second.first.base64,
      buildToken: tokenFor(second.message, { closing: false }),
    });
    expect(held.statusCode).toBe(429);
    expect(held.json()).toMatchObject({ notSent: true });
    expect(held.json().error).toMatch(/every second/);
    expect(vi.mocked(sendViaSender)).toHaveBeenCalledTimes(1);
    expect(await prisma.platformTrade.count({ where: { wallet: TRADER.address } })).toBe(1);
  });

  describe("when Sender stops answering (user decision 2026-10-19: RPC fallback only with MEV Protect off)", () => {
    it("resends a trade with MEV Protect off through the RPC too after two silent Sender sends", async () => {
      vi.mocked(sendViaSender).mockImplementation(SENDER_SILENT);
      const app = await instance();
      const t = trade();
      const res = await send(app, {
        transaction: t.first.base64,
        buildToken: tokenFor(t.message),
        mevProtect: false,
      });
      // No answer may still mean it went out: sent, not refused.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ signature: t.first.signature });
      expect(chain.rpcSends).toEqual([]);
      await vi.waitFor(() => expect(chain.rpcSends).toContain(t.first.base64), {
        timeout: 10_000,
        interval: 100,
      });
      // Only after the first send and a resend went unanswered, and Sender is still tried alongside.
      const before = senderCalls(t.first.base64);
      expect(before).toBeGreaterThanOrEqual(3);
      await vi.waitFor(() => expect(senderCalls(t.first.base64)).toBeGreaterThan(before), {
        timeout: 5_000,
        interval: 100,
      });
    }, 20_000);

    it("never sends a MEV-protected trade through the RPC", async () => {
      vi.mocked(sendViaSender).mockImplementation(SENDER_SILENT);
      const app = await instance();
      const t = trade();
      const res = await send(app, {
        transaction: t.first.base64,
        buildToken: tokenFor(t.message),
        mevProtect: true,
      });
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(senderCalls(t.first.base64)).toBeGreaterThanOrEqual(4), {
        timeout: 12_000,
        interval: 100,
      });
      expect(chain.rpcSends).toEqual([]);
    }, 20_000);

    it("keeps a Sender refusal a refusal, with no RPC fallback", async () => {
      vi.mocked(sendViaSender).mockImplementation(async () => ({
        ok: false as const,
        refused: true,
        error: "HTTP 400",
      }));
      const app = await instance();
      const t = trade();
      const res = await send(app, {
        transaction: t.first.base64,
        buildToken: tokenFor(t.message),
        mevProtect: false,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ notSent: true });
      // Nothing went out, so nothing is resent, through Sender or the RPC.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(senderCalls(t.first.base64)).toBe(1);
      expect(chain.rpcSends).toEqual([]);
    }, 10_000);

    it("falls back for a resumed row with MEV Protect off, never for a protected one", async () => {
      vi.mocked(sendViaSender).mockImplementation(SENDER_SILENT);
      const open = trade().first;
      const shielded = trade().first;
      await prisma.platformTrade.createMany({
        data: [
          { tx: open, mev: false },
          { tx: shielded, mev: true },
        ].map(({ tx, mev }) => ({
          signature: tx.signature,
          wallet: TRADER.address,
          mint: MINT,
          side: "buy",
          lamports: 20_000_000n,
          networkFeeLamports: 25_000n,
          transaction: tx.base64,
          lastValidBlockHeight: BigInt(chain.height + 100),
          senderSpeed: "eco",
          senderMevProtect: mev,
        })),
      });
      await instance();
      await vi.waitFor(() => expect(chain.rpcSends).toContain(open.base64), {
        timeout: 12_000,
        interval: 100,
      });
      expect(senderCalls(open.base64)).toBeGreaterThanOrEqual(3);
      expect(senderCalls(shielded.base64)).toBeGreaterThanOrEqual(3);
      expect(chain.rpcSends).not.toContain(shielded.base64);
    }, 20_000);
  });
});
