import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../db.js";
import { creditBurn, claimHeldBurns, resolveAccess, extendedExpiry } from "./access.js";
import { SUBSCRIPTION_MINT, SUBSCRIPTION_RAW_PER_MONTH, SUBSCRIPTION_DAYS } from "./constants.js";
import type { BurnCredit } from "./parseBurn.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const RUN = Date.now();
const WALLET = `SubTestWallet${RUN}`;
const NO_ACCOUNT_WALLET = `SubTestUnknown${RUN}`;
const NO_ADMINS = new Set<string>();

const credit = (over: Partial<BurnCredit> = {}): BurnCredit => ({
  burnerWallet: WALLET,
  rawAmount: SUBSCRIPTION_RAW_PER_MONTH,
  months: 1,
  slot: 442_000_000n,
  blockTime: new Date(),
  ...over,
});

describe("extendedExpiry", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;

  it("starts from now when there is no current window", () => {
    expect(extendedExpiry(null, 1, now).getTime()).toBe(now.getTime() + SUBSCRIPTION_DAYS * day);
  });

  it("stacks onto an unexpired window rather than discarding the remainder", () => {
    const current = new Date(now.getTime() + 10 * day);
    expect(extendedExpiry(current, 1, now).getTime()).toBe(current.getTime() + SUBSCRIPTION_DAYS * day);
  });

  it("starts from now when the old window has already lapsed", () => {
    const lapsed = new Date(now.getTime() - 40 * day);
    expect(extendedExpiry(lapsed, 1, now).getTime()).toBe(now.getTime() + SUBSCRIPTION_DAYS * day);
  });
});

describe.skipIf(!dbAvailable)("burn crediting", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.burnEvent.deleteMany({ where: { burnerWallet: { in: [WALLET, NO_ACCOUNT_WALLET] } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: { startsWith: `SubTest` } } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: [WALLET, NO_ACCOUNT_WALLET] } } });
  });

  beforeEach(async () => {
    await prisma.burnEvent.deleteMany({ where: { burnerWallet: { in: [WALLET, NO_ACCOUNT_WALLET] } } });
    await prisma.subscription.deleteMany({ where: { userId } });
  });

  it("credits a burn and grants access", async () => {
    const result = await creditBurn(`sig-${RUN}-a`, credit(), SUBSCRIPTION_MINT, "claim");
    expect(result.status).toBe("credited");

    const access = await resolveAccess(WALLET, NO_ADMINS);
    expect(access.hasAccess).toBe(true);
    expect(access.reason).toBe("subscription");
  });

  it("credits the same signature exactly once, however many times it is submitted", async () => {
    const sig = `sig-${RUN}-b`;
    const first = await creditBurn(sig, credit(), SUBSCRIPTION_MINT, "claim");
    const second = await creditBurn(sig, credit(), SUBSCRIPTION_MINT, "reconciler");
    const third = await creditBurn(sig, credit(), SUBSCRIPTION_MINT, "reconciler");

    expect(first.status).toBe("credited");
    expect(second.status).toBe("already_credited");
    expect(third.status).toBe("already_credited");
    expect(await prisma.burnEvent.count({ where: { signature: sig } })).toBe(1);

    // And crucially: one month of access, not three.
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    const daysGranted = (sub!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysGranted).toBeGreaterThan(SUBSCRIPTION_DAYS - 1);
    expect(daysGranted).toBeLessThan(SUBSCRIPTION_DAYS + 1);
  });

  it("survives the claim and the reconciler racing on the same burn", async () => {
    const sig = `sig-${RUN}-race`;
    const results = await Promise.all([
      creditBurn(sig, credit(), SUBSCRIPTION_MINT, "claim"),
      creditBurn(sig, credit(), SUBSCRIPTION_MINT, "reconciler"),
      creditBurn(sig, credit(), SUBSCRIPTION_MINT, "reconciler"),
    ]);
    expect(results.filter((r) => r.status === "credited")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_credited")).toHaveLength(2);
    expect(await prisma.burnEvent.count({ where: { signature: sig } })).toBe(1);
  });

  it("stacks two separate burns into two months", async () => {
    await creditBurn(`sig-${RUN}-c1`, credit(), SUBSCRIPTION_MINT, "claim");
    const second = await creditBurn(`sig-${RUN}-c2`, credit(), SUBSCRIPTION_MINT, "claim");
    expect(second.status).toBe("credited");

    const sub = await prisma.subscription.findUnique({ where: { userId } });
    const daysGranted = (sub!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysGranted).toBeGreaterThan(2 * SUBSCRIPTION_DAYS - 1);
  });

  it("holds a burn from a wallet that has never signed in, then settles it on first login", async () => {
    const held = await creditBurn(
      `sig-${RUN}-held`,
      credit({ burnerWallet: NO_ACCOUNT_WALLET, months: 2 }),
      SUBSCRIPTION_MINT,
      "reconciler",
    );
    expect(held.status).toBe("held");

    // Nothing to grant yet - there is no account.
    expect((await resolveAccess(NO_ACCOUNT_WALLET, NO_ADMINS)).hasAccess).toBe(false);

    // They sign in for the first time.
    const user = await prisma.user.create({ data: { walletAddress: NO_ACCOUNT_WALLET } });
    const months = await claimHeldBurns(user.id, NO_ACCOUNT_WALLET);
    expect(months).toBe(2);

    const access = await resolveAccess(NO_ACCOUNT_WALLET, NO_ADMINS);
    expect(access.hasAccess).toBe(true);

    // And claiming again is a no-op, not another two months.
    expect(await claimHeldBurns(user.id, NO_ACCOUNT_WALLET)).toBe(0);
  });

  it("denies access once the window has lapsed", async () => {
    await prisma.subscription.create({
      data: { userId, expiresAt: new Date(Date.now() - 1000), source: "BURN" },
    });
    const access = await resolveAccess(WALLET, NO_ADMINS);
    expect(access.hasAccess).toBe(false);
    expect(access.reason).toBe("none");
    // The lapsed date is still reported, so the UI can say "expired on ..." rather than "never".
    expect(access.expiresAt).not.toBeNull();
  });

  it("lets a whitelist entry in free, and an expired one not", async () => {
    await prisma.whitelist.create({ data: { walletAddress: WALLET, addedBy: "admin", expiresAt: null } });
    expect((await resolveAccess(WALLET, NO_ADMINS)).reason).toBe("whitelist");

    await prisma.whitelist.update({
      where: { walletAddress: WALLET },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await resolveAccess(WALLET, NO_ADMINS)).hasAccess).toBe(false);
    await prisma.whitelist.delete({ where: { walletAddress: WALLET } });
  });

  it("always lets an admin in, with no subscription at all", async () => {
    const access = await resolveAccess(WALLET, new Set([WALLET]));
    expect(access.hasAccess).toBe(true);
    expect(access.reason).toBe("admin");
    expect(access.expiresAt).toBeNull();
  });
});
