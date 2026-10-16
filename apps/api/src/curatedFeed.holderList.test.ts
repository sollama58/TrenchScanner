// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { latestSnapshotsByToken, withCarriedHolderList, withCarriedHolderLists } from "./curatedFeed.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `holder-list-test-${process.pid}-${Date.now()}`;

const listA = [{ wallet: "A".repeat(44), pct: 4.2, cexFunder: "Binance" }];
const listB = [{ wallet: "B".repeat(44), pct: 2.5 }];
// The reading's clusters and same-minute groups ride the same rows as its list.
const clustersB = [
  { funder: "F".repeat(44), wallets: [{ wallet: "B".repeat(44), pct: 2.5 }], pct: 2.5, creatorLinked: false },
];
const groupsB = [
  {
    atMs: 1_760_000_000_000,
    spanMs: 1_000,
    wallets: [{ wallet: "B".repeat(44), pct: 2.5, fundedAtMs: 1_760_000_000_000, funder: null }],
    pct: 2.5,
  },
];

/**
 * The scan writes the holder list only on a new reading or every ten minutes (worker
 * holderListWrites.ts); a card's latest snapshot gets the newest list before it.
 */
describe.skipIf(!dbAvailable)("latestSnapshotsByToken and withCarriedHolderList: the holder list", () => {
  const tokens: Record<string, string> = {};
  const T0 = Date.now() - 6 * 3_600_000;
  const at = (minutes: number) => new Date(T0 + minutes * 60_000);
  const row = (tokenId: string, minutes: number, linkedHolders?: unknown, lists: object = {}) => ({
    tokenId,
    takenAt: at(minutes),
    priceUsd: 0.001,
    marketCapUsd: 50_000 + minutes,
    source: "scan",
    ...(linkedHolders === undefined ? {} : { linkedHolders: linkedHolders as object }),
    ...lists,
  });
  const withB = { linkedClusters: clustersB, sameTimeClusters: groupsB };

  beforeAll(async () => {
    for (const key of ["carried", "own", "stale", "none"]) {
      tokens[key] = (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    }
    await prisma.tokenSnapshot.createMany({
      data: [
        // The newest row has no list; the newest list before it is listB, not the older listA.
        row(tokens.carried!, 0, listA),
        row(tokens.carried!, 5, listB, withB),
        row(tokens.carried!, 6),
        row(tokens.carried!, 7),
        // The newest row carries its own list: nothing is carried over it.
        row(tokens.own!, 0, listA),
        row(tokens.own!, 1, listB, withB),
        // The only list is older than the two-hour bound: the newest row stays without one.
        row(tokens.stale!, 0, listA),
        row(tokens.stale!, 150),
        // Never had a list.
        row(tokens.none!, 0),
        row(tokens.none!, 1),
      ],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("carries the newest earlier list onto a latest snapshot that has none", async () => {
    const latest = await latestSnapshotsByToken([tokens.carried!, tokens.own!, tokens.stale!, tokens.none!]);
    expect(latest.get(tokens.carried!)?.takenAt).toEqual(at(7));
    expect(latest.get(tokens.carried!)?.linkedHolders).toEqual(listB);
    expect(latest.get(tokens.carried!)?.linkedClusters).toEqual(clustersB);
    expect(latest.get(tokens.carried!)?.sameTimeClusters).toEqual(groupsB);
    expect(latest.get(tokens.own!)?.takenAt).toEqual(at(1));
    expect(latest.get(tokens.own!)?.linkedHolders).toEqual(listB);
    expect(latest.get(tokens.own!)?.linkedClusters).toEqual(clustersB);
    expect(latest.get(tokens.stale!)?.takenAt).toEqual(at(150));
    expect(latest.get(tokens.stale!)?.linkedHolders).toBeNull();
    expect(latest.get(tokens.stale!)?.linkedClusters).toBeNull();
    expect(latest.get(tokens.none!)?.linkedHolders).toBeNull();
    // The carrier columns never reach a card.
    const keys = Object.keys(latest.get(tokens.carried!)!);
    expect(keys).not.toContain("carriedHolders");
    expect(keys).not.toContain("carriedClusters");
    expect(keys).not.toContain("carriedSameTime");
  });

  it("does the same for one snapshot", async () => {
    const newest = await prisma.tokenSnapshot.findFirst({
      where: { tokenId: tokens.carried! },
      orderBy: { takenAt: "desc" },
    });
    const carried = await withCarriedHolderList(newest);
    expect(carried?.takenAt).toEqual(at(7));
    expect(carried?.linkedHolders).toEqual(listB);
    expect(carried?.linkedClusters).toEqual(clustersB);
    expect(carried?.sameTimeClusters).toEqual(groupsB);
    const own = await withCarriedHolderList(
      await prisma.tokenSnapshot.findFirst({ where: { tokenId: tokens.own! }, orderBy: { takenAt: "desc" } }),
    );
    expect(own?.linkedHolders).toEqual(listB);
    const stale = await withCarriedHolderList(
      await prisma.tokenSnapshot.findFirst({
        where: { tokenId: tokens.stale! },
        orderBy: { takenAt: "desc" },
      }),
    );
    expect(stale?.linkedHolders).toBeNull();
    expect(await withCarriedHolderList(null)).toBeNull();
  });

  it("does the same for a page of rows read by id (the Stream's entry rows)", async () => {
    const rows = await prisma.tokenSnapshot.findMany({
      where: { tokenId: { in: [tokens.carried!, tokens.own!, tokens.stale!] } },
      orderBy: { takenAt: "desc" },
    });
    const byKey = (key: string, minutes: number) =>
      rows.find((r) => r.tokenId === tokens[key] && r.takenAt.getTime() === at(minutes).getTime())!;
    const page = [byKey("carried", 6), byKey("own", 0), byKey("stale", 150)];
    const out = await withCarriedHolderLists(page);
    expect(out.map((r) => r.id)).toEqual(page.map((r) => r.id));
    expect(out[0]!.linkedHolders).toEqual(listB);
    expect(out[0]!.linkedClusters).toEqual(clustersB);
    expect(out[0]!.sameTimeClusters).toEqual(groupsB);
    expect(out[1]!.linkedHolders).toEqual(listA);
    expect(out[2]!.linkedHolders).toBeNull();
  });
});
