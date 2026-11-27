// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccessSource, loadEnv, prisma, type Env } from "@trenchscanner/core";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/** A real keypair: the run takes the admin wallet's signature. */
const adminKeys = nacl.sign.keyPair();
const ADMIN_WALLET = bs58.encode(adminKeys.publicKey);
const OTHER_WALLET = "NotAdminExtendAll11111111111111111111111111";
const LIVE_WALLET = "ExtendAllLive111111111111111111111111111111";
const LAPSED_WALLET = "ExtendAllLapsed1111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };
const DAY = 86_400_000;

type Req = { method: "GET" | "POST"; url: string; payload?: Record<string, unknown> };

/** One request as `as`; a POST by the admin is signed as the dashboard does unless `unsigned`. */
async function call(as: "admin" | "other", req: Req, opts: { unsigned?: boolean } = {}) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    const cookies = { [SESSION_COOKIE_NAME]: cookie };
    let payload = req.payload;
    if (as === "admin" && req.method === "POST" && !opts.unsigned) {
      const body = payload ?? {};
      const challenge = await app.inject({
        method: "POST",
        url: "/admin/confirm",
        cookies,
        payload: { method: req.method, path: req.url, body },
      });
      const { nonce, message } = challenge.json<{ nonce: string; message: string }>();
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(message), adminKeys.secretKey),
      );
      payload = { ...body, confirmation: { nonce, signature } };
    }
    return await app.inject({ ...req, cookies, ...(payload ? { payload } : {}) });
  } finally {
    await app.close();
  }
}

const liveCount = () => prisma.subscription.count({ where: { expiresAt: { gt: new Date() } } });
const expiryOf = async (wallet: string) =>
  (await prisma.subscription.findFirstOrThrow({ where: { user: { walletAddress: wallet } } })).expiresAt;

let liveExpiry: Date;
let lapsedExpiry: Date;

describe.skipIf(!dbAvailable)("admin extend every subscription", () => {
  beforeAll(async () => {
    const wallets = [ADMIN_WALLET, OTHER_WALLET, LIVE_WALLET, LAPSED_WALLET];
    await prisma.user.deleteMany({ where: { walletAddress: { in: wallets } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });

  beforeEach(async () => {
    await prisma.subscriptionBulkExtension.deleteMany({});
    await prisma.user.deleteMany({ where: { walletAddress: { in: [LIVE_WALLET, LAPSED_WALLET] } } });
    liveExpiry = new Date(Date.now() + 10 * DAY);
    lapsedExpiry = new Date(Date.now() - 2 * DAY);
    await prisma.user.create({
      data: {
        walletAddress: LIVE_WALLET,
        subscription: { create: { expiresAt: liveExpiry, source: AccessSource.BURN } },
      },
    });
    await prisma.user.create({
      data: {
        walletAddress: LAPSED_WALLET,
        subscription: { create: { expiresAt: lapsedExpiry, source: AccessSource.BURN } },
      },
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.subscriptionBulkExtension.deleteMany({});
    await prisma.user.deleteMany({
      where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET, LIVE_WALLET, LAPSED_WALLET] } },
    });
  });

  const run = async (over: Record<string, unknown> = {}, opts: { unsigned?: boolean } = {}) =>
    call(
      "admin",
      {
        method: "POST",
        url: "/admin/subscriptions/extend-all",
        payload: {
          unit: "weeks",
          amount: 2,
          expectedUsers: await liveCount(),
          confirmWord: "EXTEND",
          requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ...over,
        },
      },
      opts,
    );

  it("refuses a non-admin", async () => {
    const preview = await call("other", {
      method: "GET",
      url: "/admin/subscriptions/extend-all/preview?unit=weeks&amount=1",
    });
    expect(preview.statusCode).toBe(403);
    const res = await call("other", {
      method: "POST",
      url: "/admin/subscriptions/extend-all",
      payload: { unit: "weeks", amount: 1, expectedUsers: 1, confirmWord: "EXTEND", requestId: "abcdefgh1" },
    });
    expect(res.statusCode).toBe(403);
    expect(await expiryOf(LIVE_WALLET)).toEqual(liveExpiry);
  });

  it("previews the live subscriptions and the days added", async () => {
    const res = await call("admin", {
      method: "GET",
      url: "/admin/subscriptions/extend-all/preview?unit=months&amount=3",
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ days: number; affected: number; confirmWord: string }>();
    expect(body.days).toBe(90);
    expect(body.affected).toBe(await liveCount());
    expect(body.confirmWord).toBe("EXTEND");
  });

  it.each([
    ["weeks", 13],
    ["months", 4],
    ["weeks", 0],
    ["days", 5],
  ])("refuses %s=%s past the three-month cap", async (unit, amount) => {
    const preview = await call("admin", {
      method: "GET",
      url: `/admin/subscriptions/extend-all/preview?unit=${unit}&amount=${amount}`,
    });
    expect(preview.statusCode).toBe(400);
    expect((await run({ unit, amount })).statusCode).toBe(400);
    expect(await expiryOf(LIVE_WALLET)).toEqual(liveExpiry);
  });

  it("needs the typed word and the wallet's signature", async () => {
    expect((await run({ confirmWord: "extend please" })).statusCode).toBe(400);
    const unsigned = await run({}, { unsigned: true });
    expect(unsigned.statusCode).toBe(428);
    expect(unsigned.json<{ code: string }>().code).toBe("confirmation_required");
    expect(await expiryOf(LIVE_WALLET)).toEqual(liveExpiry);
    expect(await prisma.subscriptionBulkExtension.count()).toBe(0);
  });

  it("refuses when the live count moved since the preview", async () => {
    const res = await run({ expectedUsers: (await liveCount()) + 1 });
    expect(res.statusCode).toBe(409);
    expect(await expiryOf(LIVE_WALLET)).toEqual(liveExpiry);
  });

  it("extends live subscriptions only, records the run, and adds the time once", async () => {
    const affected = await liveCount();
    const requestId = `once-${Date.now()}`;
    const res = await run({ unit: "months", amount: 1, requestId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      days: 30,
      usersExtended: affected,
      by: ADMIN_WALLET,
      replayed: false,
    });
    expect((await expiryOf(LIVE_WALLET)).getTime()).toBe(liveExpiry.getTime() + 30 * DAY);
    // A lapsed subscription is not revived.
    expect(await expiryOf(LAPSED_WALLET)).toEqual(lapsedExpiry);

    // The same request retried is answered from the first run, not run again.
    const again = await run({ unit: "months", amount: 1, requestId, expectedUsers: affected });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, usersExtended: affected });
    expect((await expiryOf(LIVE_WALLET)).getTime()).toBe(liveExpiry.getTime() + 30 * DAY);

    // A different run straight after is refused by the cooldown.
    const second = await run();
    expect(second.statusCode).toBe(409);
    expect((await expiryOf(LIVE_WALLET)).getTime()).toBe(liveExpiry.getTime() + 30 * DAY);

    expect(await prisma.subscriptionBulkExtension.count()).toBe(1);
    const runs = await call("admin", { method: "GET", url: "/admin/subscriptions/extend-all/runs" });
    expect(runs.json<{ requestId: string }[]>().map((r) => r.requestId)).toEqual([requestId]);
    const logged = await prisma.adminAction.findFirst({
      where: { wallet: ADMIN_WALLET, route: "/admin/subscriptions/extend-all", statusCode: 200 },
    });
    expect(logged).not.toBeNull();
  });
});
