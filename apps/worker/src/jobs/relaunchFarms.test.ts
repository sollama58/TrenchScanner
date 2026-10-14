// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { resolveRelaunchSiblings } from "./relaunchFarms.js";

/** Reads the Token table, so it runs against the real schema; skips on a machine without one. */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `relaunch-${Date.now()}`;
const MINUTE = 60_000;
const t0 = Date.now() - 60 * MINUTE;

async function token(n: string, symbol: string | null, minutesAfter: number, lastMcapUsd?: number) {
  return prisma.token.create({
    data: {
      mintAddress: `${TAG}-${n}`,
      symbol,
      firstSeenAt: new Date(t0 + minutesAfter * MINUTE),
      lastMcapUsd,
    },
  });
}

describe.skipIf(!dbAvailable)("resolveRelaunchSiblings", () => {
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("counts same-ticker launches in the 15 minutes before a mint, with their peak once at the cut", async () => {
    const sym = `F${Date.now() % 100000}`;
    // Outside the window, then four inside it (ticker case and spacing vary), then the mint itself.
    await token("old", sym, 0, 90_000);
    await token("a", sym, 20, 3_000);
    await token("b", sym.toLowerCase(), 22, 2_900);
    const c = await token("c", ` ${sym} `, 25);
    await prisma.tokenSnapshot.create({ data: snapshot(c.id, 14_700) });
    await token("d", sym, 30, 3_100);
    await token("other", `${sym}X`, 31, 50_000);
    await token("me", sym, 33);
    await token("first", sym, 19.5);

    const read = await resolveRelaunchSiblings([`${TAG}-me`, `${TAG}-first`, `${TAG}-missing`]);
    // a, b, c, d; "first" is also within 15 min before "me".
    expect(read.get(`${TAG}-me`)).toEqual({ siblings: 5, peakMcapUsd: 14_700 });
    // Only "old" is before "first", and it sits outside the window.
    expect(read.get(`${TAG}-first`)).toEqual({ siblings: 0, peakMcapUsd: 0 });
    expect(read.has(`${TAG}-missing`)).toBe(false);
  });

  it("leaves out a mint with no ticker", async () => {
    await token("nosym", null, 40);
    expect((await resolveRelaunchSiblings([`${TAG}-nosym`])).size).toBe(0);
  });
});

function snapshot(tokenId: string, marketCapUsd: number) {
  return { tokenId, priceUsd: marketCapUsd / 1e9, marketCapUsd, rugScreenPassed: false };
}
