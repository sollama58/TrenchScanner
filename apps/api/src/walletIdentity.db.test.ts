// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, type HeliusIdentity } from "@trenchscanner/core";
import { prismaIdentityStore } from "./walletIdentity.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `identity-test-${Date.now()}`;
const NAMED = `${TAG}-named`;
const NOBODY = `${TAG}-nobody`;
const OLD = `${TAG}-old`;

describe.skipIf(!dbAvailable)("prismaIdentityStore", () => {
  afterAll(async () => {
    await prisma.walletIdentity.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("keeps names and no-name answers, and reads only those inside the TTL", async () => {
    const store = prismaIdentityStore(60_000);
    const okx: HeliusIdentity = {
      type: "exchange",
      name: "OKX",
      category: "Centralized Exchange",
      tags: ["Hot Wallet"],
    };
    const now = Date.now();
    await prisma.walletIdentity.create({
      data: { wallet: OLD, identity: { ...okx }, readAt: new Date(now - 120_000) },
    });
    await store.write(
      new Map<string, HeliusIdentity | null>([
        [NAMED, okx],
        [NOBODY, null],
      ]),
      new Date(now),
    );
    const read = await store.read([NAMED, NOBODY, OLD], new Date(now - 60_000));
    expect(read.get(NAMED)).toEqual({ at: now, value: okx });
    expect(read.get(NOBODY)).toEqual({ at: now, value: null });
    // Past the TTL: not read, and pruned by the write that followed it.
    expect(read.has(OLD)).toBe(false);
    expect(await prisma.walletIdentity.count({ where: { wallet: OLD } })).toBe(0);

    await store.write(new Map([[NOBODY, okx]]), new Date(now + 1_000));
    const again = await store.read([NOBODY], new Date(now));
    expect(again.get(NOBODY)?.value).toEqual(okx);
  });
});
