// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  RELAUNCH_PEAK_REREAD_MS,
  resetRelaunchSiblingsForTests,
  resolveRelaunchSiblings,
} from "./relaunchFarms.js";

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
  beforeEach(() => resetRelaunchSiblingsForTests());
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

  it("asks about a mint once, reads a farm's peak again after a pause, and a mint below the cut never", async () => {
    const sym = `G${Date.now() % 100000}`;
    const now = Date.now();
    for (const [n, min] of [
      ["g1", 0],
      ["g2", 1],
      ["g3", 2],
      ["g4", 3],
    ] as const) {
      await token(`${sym}-${n}`, sym, 40 + min, 1_000);
    }
    await token(`${sym}-farm`, sym, 45);
    await token(`${sym}-lone`, `${sym}L`, 45);
    const farm = `${TAG}-${sym}-farm`;
    const lone = `${TAG}-${sym}-lone`;

    const first = await resolveRelaunchSiblings([farm, lone], now);
    expect(first.get(farm)).toEqual({ siblings: 4, peakMcapUsd: 1_000 });
    expect(first.get(lone)).toEqual({ siblings: 0, peakMcapUsd: 0 });

    // The table changes under it: a sibling's peak rises and the lone mint gains a sibling.
    await prisma.token.updateMany({
      where: { mintAddress: `${TAG}-${sym}-g1` },
      data: { lastMcapUsd: 9_000 },
    });
    await token(`${sym}-late`, `${sym}L`, 44);
    // Within the pause both come from memory...
    const again = await resolveRelaunchSiblings([farm, lone], now + RELAUNCH_PEAK_REREAD_MS - 1);
    expect(again.get(farm)).toEqual({ siblings: 4, peakMcapUsd: 1_000 });
    expect(again.get(lone)).toEqual({ siblings: 0, peakMcapUsd: 0 });
    // ...and after it only the farm is read again: its peak moves, the lone mint's count is fixed
    // by its first sighting as far as this process is concerned.
    const later = await resolveRelaunchSiblings([farm, lone], now + RELAUNCH_PEAK_REREAD_MS);
    expect(later.get(farm)).toEqual({ siblings: 4, peakMcapUsd: 9_000 });
    expect(later.get(lone)).toEqual({ siblings: 0, peakMcapUsd: 0 });

    // A mint the table has no ticker for is asked about again after the pause, in case one arrived.
    await token(`${sym}-quiet`, null, 46);
    const quiet = `${TAG}-${sym}-quiet`;
    expect((await resolveRelaunchSiblings([quiet], now)).has(quiet)).toBe(false);
    await prisma.token.update({ where: { mintAddress: quiet }, data: { symbol: `${sym}Q` } });
    expect((await resolveRelaunchSiblings([quiet], now + 1_000)).has(quiet)).toBe(false);
    expect((await resolveRelaunchSiblings([quiet], now + RELAUNCH_PEAK_REREAD_MS)).get(quiet)).toEqual({
      siblings: 0,
      peakMcapUsd: 0,
    });
  });
});

function snapshot(tokenId: string, marketCapUsd: number) {
  return { tokenId, priceUsd: marketCapUsd / 1e9, marketCapUsd, rugScreenPassed: false };
}
