// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  enrollInFreeAccess,
  loadEntitledActiveFilters,
  loadEnv,
  prisma,
  runDueFreeAccessCleanup,
  saveFreeAccessPeriod,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const HOUR = 3_600_000;
// Unique per run: the cleanup keeps a deleted account's report with no wallet, so it is found by its text.
const REPORT_TEXT = `free access test ${Date.now()}`;

/**
 * Free Access end to end against a real database: switching it on from the admin routes, a real
 * wallet sign-in enrolling a wallet, the paywall letting it through, the dry run, and the cleanup
 * deleting exactly the accounts the period created that nothing retains. Periods are global (one
 * current period), so this file wipes the two Free Access tables before and after.
 */
describe.skipIf(!dbAvailable)("free access", () => {
  let app: FastifyInstance;
  const wallets: string[] = [];
  const keypair = () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    wallets.push(wallet);
    return { kp, wallet };
  };
  const admin = keypair();
  const env = loadEnv({ ...process.env, ADMIN_WALLET_ADDRESSES: admin.wallet });
  const admins = new Set([admin.wallet]);
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
  let adminCookie = "";

  const wipePeriods = async () => {
    await prisma.freeAccessGrant.deleteMany({});
    await prisma.freeAccessPeriod.deleteMany({});
  };

  beforeAll(async () => {
    await wipePeriods();
    app = await buildServer(env);
    const user = await prisma.user.create({ data: { walletAddress: admin.wallet } });
    adminCookie = await signer.sign({ userId: user.id, walletAddress: admin.wallet, sessionVersion: 0 });
  });

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await wipePeriods();
    await prisma.feedbackReport.deleteMany({
      where: { OR: [{ walletAddress: { in: wallets } }, { message: REPORT_TEXT }] },
    });
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: { in: wallets } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: { in: wallets } } });
    await prisma.authNonce.deleteMany({ where: { walletAddress: { in: wallets } } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: wallets } } });
  });

  /** A real sign-in: GET /auth/nonce, sign the message with the wallet's key, POST /auth/verify. */
  async function signIn(who: { kp: nacl.SignKeyPair; wallet: string }) {
    const nonce = await app.inject({ method: "GET", url: `/auth/nonce?wallet=${who.wallet}` });
    expect(nonce.statusCode).toBe(200);
    const { nonce: value, message } = nonce.json() as { nonce: string; message: string };
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), who.kp.secretKey));
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { method: "signMessage", walletAddress: who.wallet, nonce: value, signature },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; sessionToken: string };
    return { userId: body.id, cookie: body.sessionToken, wallet: who.wallet };
  }

  const as = (cookie: string, method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  const asAdmin = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    as(adminCookie, method, url, payload);

  const grantOf = (wallet: string) => prisma.freeAccessGrant.findFirst({ where: { walletAddress: wallet } });

  const times = (offsetMs = 0) => ({
    signInStartsAt: new Date(Date.now() - 60_000 + offsetMs).toISOString(),
    signInEndsAt: new Date(Date.now() + HOUR + offsetMs).toISOString(),
    accessEndsAt: new Date(Date.now() + 2 * HOUR + offsetMs).toISOString(),
  });

  // Shared across the steps below, in order.
  let freshA: Awaited<ReturnType<typeof signIn>>;
  let existingB: Awaited<ReturnType<typeof signIn>>;
  let paywallC: { userId: string; wallet: string; cookie: string };

  it("is off until an admin turns it on, and says so publicly", async () => {
    const res = await app.inject({ method: "GET", url: "/config/free-access" });
    expect(res.json()).toEqual({ phase: null });
    const signedIn = await signIn(keypair());
    expect(await grantOf(signedIn.wallet)).toBeNull();
    expect((await as(signedIn.cookie, "GET", "/filters")).statusCode).toBe(402);
  });

  it("refuses to turn on without the confirmation, for anyone but an admin, or with times that don't add up", async () => {
    expect((await asAdmin("PUT", "/admin/free-access", times())).statusCode).toBe(400);
    const outsider = await signIn(keypair());
    expect(
      (await as(outsider.cookie, "PUT", "/admin/free-access", { ...times(), confirm: true })).statusCode,
    ).toBe(403);
    const backwards = { ...times(), accessEndsAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    const res = await asAdmin("PUT", "/admin/free-access", { ...backwards, confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/before sign-in closes/);
    const tooLong = { ...times(), accessEndsAt: new Date(Date.now() + 91 * 24 * HOUR).toISOString() };
    expect((await asAdmin("PUT", "/admin/free-access", { ...tooLong, confirm: true })).statusCode).toBe(409);
    expect(await prisma.freeAccessPeriod.count()).toBe(0);
  });

  it("turns on, and enrolls whoever signs in, new account or old", async () => {
    // B has an account from before the period, with no access.
    const b = keypair();
    await prisma.user.create({ data: { walletAddress: b.wallet } });
    // C is signed in already, sitting on the paywall when the window opens.
    const c = keypair();
    const cUser = await prisma.user.create({ data: { walletAddress: c.wallet } });
    paywallC = {
      userId: cUser.id,
      wallet: c.wallet,
      cookie: await signer.sign({ userId: cUser.id, walletAddress: c.wallet, sessionVersion: 0 }),
    };

    const on = await asAdmin("PUT", "/admin/free-access", { ...times(), confirm: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().period.phase).toBe("open");
    expect((await app.inject({ method: "GET", url: "/config/free-access" })).json().phase).toBe("open");

    freshA = await signIn(keypair());
    expect(await grantOf(freshA.wallet)).toMatchObject({ createdAccount: true, userId: freshA.userId });
    expect((await as(freshA.cookie, "GET", "/filters")).statusCode).toBe(200);

    existingB = await signIn(b);
    expect(await grantOf(b.wallet)).toMatchObject({ createdAccount: false });
    expect((await as(existingB.cookie, "GET", "/filters")).statusCode).toBe(200);

    // The paywall's own poll enrolls C, as an existing account.
    const status = await as(paywallC.cookie, "GET", "/subscription");
    expect(status.json()).toMatchObject({ hasAccess: true, reason: "free_access" });
    expect(await grantOf(c.wallet)).toMatchObject({ createdAccount: false });

    const settings = (await as(freshA.cookie, "GET", "/settings")).json();
    expect(settings.account.access).toMatchObject({
      level: "free_access",
      freeAccess: { deletesAccount: true },
    });
    const settingsB = (await as(existingB.cookie, "GET", "/settings")).json();
    expect(settingsB.account.access.freeAccess).toEqual({ deletesAccount: false });
  });

  it("once open, a period can be extended but not shortened, and its opening stays put", async () => {
    const current = await prisma.freeAccessPeriod.findFirstOrThrow({ where: { purgedAt: null } });
    const base = {
      signInStartsAt: current.signInStartsAt.toISOString(),
      signInEndsAt: current.signInEndsAt.toISOString(),
      confirm: true,
    };
    const shorter = await asAdmin("PUT", "/admin/free-access", {
      ...base,
      accessEndsAt: new Date(current.accessEndsAt.getTime() - 60_000).toISOString(),
    });
    expect(shorter.statusCode).toBe(409);
    const moved = await asAdmin("PUT", "/admin/free-access", {
      ...base,
      signInStartsAt: new Date(current.signInStartsAt.getTime() + 1_000).toISOString(),
      accessEndsAt: current.accessEndsAt.toISOString(),
    });
    expect(moved.statusCode).toBe(409);
    const longer = await asAdmin("PUT", "/admin/free-access", {
      ...base,
      accessEndsAt: new Date(current.accessEndsAt.getTime() + HOUR).toISOString(),
    });
    expect(longer.statusCode).toBe(200);
    expect(longer.json().period.phase).toBe("open");
  });

  it("a second sign-in never turns an existing account into one the cleanup deletes", async () => {
    // Enroll again as if the account were new: the first answer stands.
    await enrollInFreeAccess({ id: existingB.userId, walletAddress: existingB.wallet }, true, admins);
    expect(await grantOf(existingB.wallet)).toMatchObject({ createdAccount: false });
  });

  it("matches free users' filters in the scan, as for any user with access", async () => {
    const filters = await loadEntitledActiveFilters(admins);
    expect(filters.some((f) => f.userId === freshA.userId)).toBe(true);
  });

  it("shows the admin what the cleanup would do, keeping every account a retention rule covers", async () => {
    // New accounts that then subscribed, burned for credits, or were whitelisted.
    const subscriber = await signIn(keypair());
    await prisma.subscription.create({
      data: { userId: subscriber.userId, expiresAt: new Date(Date.now() + 30 * 24 * HOUR), source: "BURN" },
    });
    const creditor = await signIn(keypair());
    await prisma.burnCreditEntry.create({ data: { wallet: creditor.wallet, delta: 5, kind: "grant" } });
    const listed = await signIn(keypair());
    await prisma.whitelist.create({
      data: { walletAddress: listed.wallet, addedBy: admin.wallet, expiresAt: new Date(Date.now() - HOUR) },
    });
    // The account to be deleted carries data keyed by wallet as well as by user.
    await prisma.feedbackReport.create({
      data: {
        kind: "bug",
        message: REPORT_TEXT,
        walletAddress: freshA.wallet,
        submitterKey: `w:${freshA.wallet}`,
      },
    });

    const res = await asAdmin("GET", "/admin/free-access");
    expect(res.statusCode).toBe(200);
    const { plan, period } = res.json();
    expect(period.phase).toBe("open");
    expect(plan.deletes).toBe(1);
    const byWallet = new Map<string, { action: string; reason: string | null }>(
      plan.rows.map((r: { walletAddress: string; action: string; reason: string | null }) => [
        r.walletAddress,
        r,
      ]),
    );
    expect(byWallet.get(freshA.wallet)).toMatchObject({ action: "delete", reason: null });
    expect(byWallet.get(existingB.wallet)).toMatchObject({
      action: "keep",
      reason: "account existed before free access",
    });
    expect(byWallet.get(paywallC.wallet)?.action).toBe("keep");
    expect(byWallet.get(subscriber.wallet)).toMatchObject({ action: "keep", reason: "subscriber" });
    expect(byWallet.get(creditor.wallet)).toMatchObject({
      action: "keep",
      reason: "has Burn Credits history",
    });
    expect(byWallet.get(listed.wallet)).toMatchObject({ action: "keep", reason: "whitelisted" });
  });

  it("won't switch off when the accounts it would delete aren't the ones the admin was shown", async () => {
    const shown = (await asAdmin("GET", "/admin/free-access")).json().plan.digest as string;
    expect((await asAdmin("POST", "/admin/free-access/disable", { digest: shown })).statusCode).toBe(400);
    const stale = await asAdmin("POST", "/admin/free-access/disable", { confirm: true, digest: "not-it" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().deletes).toBe(1);
    // Someone new signs in after the admin looked: the same switch-off is now refused.
    const late = await signIn(keypair());
    const res = await asAdmin("POST", "/admin/free-access/disable", { confirm: true, digest: shown });
    expect(res.statusCode).toBe(409);
    expect(res.json().deletes).toBe(2);
    expect((await as(freshA.cookie, "GET", "/filters")).statusCode).toBe(200);
    // The late one subscribes, so the plan is the one shown again.
    await prisma.subscription.create({
      data: { userId: late.userId, expiresAt: new Date(Date.now() + 30 * 24 * HOUR), source: "BURN" },
    });
    expect((await asAdmin("GET", "/admin/free-access")).json().plan.digest).toBe(shown);
  });

  it("switching off ends access at once; an hour on, deletes only the accounts nothing retains", async () => {
    const shown = (await asAdmin("GET", "/admin/free-access")).json().plan.digest as string;
    const res = await asAdmin("POST", "/admin/free-access/disable", { confirm: true, digest: shown });
    expect(res.statusCode).toBe(200);
    const { period: off } = res.json();
    expect(off.phase).toBe("ended");
    expect(new Date(off.cleanupAt).getTime() - new Date(off.disabledAt).getTime()).toBe(HOUR);

    // Access is gone at once; the account stays through the grace.
    expect((await as(freshA.cookie, "GET", "/filters")).statusCode).toBe(402);
    expect(await runDueFreeAccessCleanup(admins)).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: freshA.userId } })).not.toBeNull();

    const result = await runDueFreeAccessCleanup(admins, { now: new Date(Date.now() + HOUR + 60_000) });
    expect(result).toMatchObject({ deleted: 1, kept: 6, failed: 0 });

    // A and everything it owned are gone; its old session no longer works; its bug report stays,
    // cut loose from the wallet.
    expect(await prisma.user.findUnique({ where: { id: freshA.userId } })).toBeNull();
    expect(await prisma.userFilter.count({ where: { userId: freshA.userId } })).toBe(0);
    expect(await prisma.authNonce.count({ where: { walletAddress: freshA.wallet } })).toBe(0);
    expect(await prisma.feedbackReport.count({ where: { walletAddress: freshA.wallet } })).toBe(0);
    expect(
      await prisma.feedbackReport.count({ where: { message: REPORT_TEXT, submitterKey: "deleted" } }),
    ).toBe(1);
    expect((await as(freshA.cookie, "GET", "/filters")).statusCode).toBe(401);
    expect(await grantOf(freshA.wallet)).toMatchObject({ outcome: "deleted" });

    // B kept its account but not the access.
    expect(await prisma.user.findUnique({ where: { id: existingB.userId } })).not.toBeNull();
    expect((await as(existingB.cookie, "GET", "/filters")).statusCode).toBe(402);
    expect(await grantOf(existingB.wallet)).toMatchObject({
      outcome: "kept: account existed before free access",
    });

    const period = await prisma.freeAccessPeriod.findFirstOrThrow();
    expect(period.purgedAt).not.toBeNull();
    const report = (await asAdmin("GET", "/admin/free-access")).json();
    expect(report.period).toBeNull();
    expect(report.history[0]).toMatchObject({ enrolled: 7, deleted: 1 });
    expect(
      (await asAdmin("POST", "/admin/free-access/disable", { confirm: true, digest: shown })).statusCode,
    ).toBe(409);
  });

  it("enrolls nobody before the window opens or after it closes", async () => {
    const saved = await saveFreeAccessPeriod(
      {
        signInStartsAt: new Date(Date.now() + HOUR),
        signInEndsAt: new Date(Date.now() + 2 * HOUR),
        accessEndsAt: new Date(Date.now() + 3 * HOUR),
      },
      admin.wallet,
    );
    expect(saved.ok).toBe(true);
    const early = await signIn(keypair());
    expect(await grantOf(early.wallet)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/config/free-access" })).json().phase).toBe("scheduled");
    // Sign-in closed, access still running.
    const late = new Date(Date.now() + 2.5 * HOUR);
    expect(
      await enrollInFreeAccess({ id: early.userId, walletAddress: early.wallet }, false, admins, late),
    ).toBeNull();
  });

  it("cleans up by itself once the period runs out, and refuses a new period until it has", async () => {
    // Move the scheduled period into the past-but-open state: sign-in open now, access ending soon.
    await prisma.freeAccessPeriod.updateMany({
      where: { purgedAt: null },
      data: {
        signInStartsAt: new Date(Date.now() - HOUR),
        signInEndsAt: new Date(Date.now() + HOUR),
        accessEndsAt: new Date(Date.now() + 2 * HOUR),
      },
    });
    const g = await signIn(keypair());
    expect(await grantOf(g.wallet)).toMatchObject({ createdAccount: true });

    // Not due yet: nothing happens.
    expect(await runDueFreeAccessCleanup(admins)).toBeNull();

    // Access runs out.
    await prisma.freeAccessPeriod.updateMany({
      where: { purgedAt: null },
      data: { signInEndsAt: new Date(Date.now() - 2_000), accessEndsAt: new Date(Date.now() - 1_000) },
    });
    expect((await as(g.cookie, "GET", "/filters")).statusCode).toBe(402);
    const blocked = await asAdmin("PUT", "/admin/free-access", { ...times(), confirm: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/cleanup/);

    // Ended, but inside the grace: nothing yet.
    expect(await runDueFreeAccessCleanup(admins)).toBeNull();
    const after = { now: new Date(Date.now() + HOUR + 60_000) };

    const result = await runDueFreeAccessCleanup(admins, after);
    expect(result).toMatchObject({ deleted: 1, kept: 0, failed: 0 });
    expect(await prisma.user.findUnique({ where: { id: g.userId } })).toBeNull();
    // Nothing left to do on the next pass, and a new period can start.
    expect(await runDueFreeAccessCleanup(admins, after)).toBeNull();
    expect((await asAdmin("PUT", "/admin/free-access", { ...times(), confirm: true })).statusCode).toBe(200);
  });

  it("a deleted wallet that signs in again starts over as a new account", async () => {
    // The current period (from the step above) is open: the returning wallet is enrolled afresh.
    const again = keypair();
    const first = await signIn(again);
    await prisma.freeAccessPeriod.updateMany({ where: { purgedAt: null }, data: { disabledAt: new Date() } });
    await runDueFreeAccessCleanup(admins, { now: new Date(Date.now() + HOUR + 60_000) });
    expect(await prisma.user.findUnique({ where: { id: first.userId } })).toBeNull();
    const second = await signIn(again);
    expect(second.userId).not.toBe(first.userId);
    expect((await as(second.cookie, "GET", "/filters")).statusCode).toBe(402);
  });
});
