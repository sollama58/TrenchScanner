// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { resetBundledSupplyBackfill, runBundledSupplyBackfill } from "./bundledSupplyBackfill.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `bundled-backfill-test-${Date.now()}`;
const ANCHOR = Date.parse("2026-10-15T00:00:00Z");
const NOW = ANCHOR + 3_600_000;
const KOL = `${TAG}-kol`;
const FUNDED = `${TAG}-funded`;
const A = `${TAG}-a`;
const B = `${TAG}-b`;

// A and B share a funder (linked, 3%); the KOL holds 2% and funded FUNDED (1%): KOL Bundled % 3.
const holders = [
  { wallet: A, pct: 2 },
  { wallet: KOL, pct: 2 },
  { wallet: B, pct: 1 },
  { wallet: FUNDED, pct: 1 },
];
const clusters = [{ funder: "f", wallets: [{ wallet: A }, { wallet: B }], pct: 3, creatorLinked: false }];

async function seed(
  label: string,
  kolBundledPct: number,
  opts: { snapshot?: boolean; alert?: boolean } = {},
) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      anchorPriceUsd: 1,
      anchorMcapUsd: 100_000,
      features: { linkedWalletPct: 3, kolBundledPct },
      sampleKind: "event",
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
    },
  });
  const snapshot = opts.snapshot
    ? await prisma.tokenSnapshot.create({
        data: {
          tokenId: token.id,
          takenAt: new Date(ANCHOR - 2_000),
          priceUsd: 1,
          marketCapUsd: 100_000,
          linkedWalletPct: 3,
          linkedWalletCount: 2,
          linkedWalletsChecked: 4,
          kolBundledPct,
          linkedHolders: holders,
          linkedClusters: clusters,
        },
      })
    : null;
  if (opts.alert && snapshot)
    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        confidence: 0.5,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
        snapshotId: snapshot.id,
        createdAt: new Date(ANCHOR),
      },
    });
  return { token, row, snapshot };
}

const featuresOf = async (id: string) =>
  (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id } })).features as Record<string, unknown>;

async function runAll() {
  for (let i = 0; i < 50; i++) {
    const out = await runBundledSupplyBackfill({ now: () => NOW, loadSides: async () => [] });
    if (out === null) return;
  }
  throw new Error("backfill never finished");
}

describe.skipIf(!dbAvailable)("Bundled % backfill", () => {
  beforeEach(() => resetBundledSupplyBackfill());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.kolWallet.deleteMany({ where: { wallet: KOL } });
    await prisma.walletFunder.deleteMany({ where: { wallet: FUNDED } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("takes the linked share where no KOL bundled anyone, and rebuilds the rest when it matches", async () => {
    await prisma.kolWallet.create({ data: { wallet: KOL, seenAt: new Date(ANCHOR) } });
    await prisma.walletFunder.create({ data: { wallet: FUNDED, status: "found", funder: KOL } });
    const none = await seed("none", 0);
    const kol = await seed("kol", 3, { snapshot: true, alert: true });
    // Recorded 5% at the time: today's groups rebuild 3%, so the KOL groups changed since.
    const moved = await seed("moved", 5, { snapshot: true });
    const lost = await seed("lost", 3);

    await runAll();

    expect((await featuresOf(none.row.id)).bundledSupplyPct).toBe(3);
    // Linked A + B (3%) and the KOL with the wallet it funded (3%).
    expect((await featuresOf(kol.row.id)).bundledSupplyPct).toBe(6);
    expect((await featuresOf(moved.row.id)).bundledSupplyPct).toBeUndefined();
    expect((await featuresOf(lost.row.id)).bundledSupplyPct).toBeUndefined();
    // The alert's own snapshot, for the card's Linked tile.
    const snap = await prisma.tokenSnapshot.findUniqueOrThrow({ where: { id: kol.snapshot!.id } });
    expect(snap.bundledSupplyPct).toBe(6);
    expect(snap.bundledSupplyCount).toBe(4);
    // Once through, it never asks again.
    expect(await runBundledSupplyBackfill({ now: () => NOW })).toBeNull();
  });
});
