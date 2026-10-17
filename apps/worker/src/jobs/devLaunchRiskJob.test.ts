// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, KNOWN_EXCHANGE_WALLETS } from "@trenchscanner/core";
import { runDevLaunchRiskJob } from "./devLaunchRiskJob.js";
import { devLaunchReadings, setDevLaunchBook } from "./devLaunchBook.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `dev-launch-test-${Date.now()}`;
const HOUR = 3_600_000;

/** A base58-looking address of its own (Token.creator must look like one to count). */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const stamp = String(Date.now())
  .split("")
  .map((d) => B58[Number(d) + 10])
  .join("");
// Names avoid 0, O, I and l, which base58 leaves out.
const wallet = (name: string) => `${name}${stamp}`.padEnd(40, "1").slice(0, 40);

const wallets: string[] = [];
let n = 0;

async function launch(
  creator: string,
  opts: { hoursAgo?: number; inBand?: boolean; grade?: "win" | "stop" | "fizzle"; finalized?: boolean } = {},
) {
  const firstSeenAt = new Date(Date.now() - (opts.hoursAgo ?? 3) * HOUR);
  const token = await prisma.token.create({
    data: {
      mintAddress: `${TAG}-${n++}`,
      creator,
      firstSeenAt,
      firstInBandAt: opts.inBand || opts.grade ? new Date(firstSeenAt.getTime() + 60_000) : null,
    },
  });
  if (opts.grade) {
    await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        anchorAt: new Date(firstSeenAt.getTime() + 120_000),
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        features: {},
        sampleKind: "event",
        nextCheckAt: new Date(),
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
        finalizedAt: opts.finalized === false ? null : new Date(firstSeenAt.getTime() + 40 * 60_000),
        hit2xIn1h: opts.grade === "win",
        disqualified: false,
        stoppedAt: opts.grade === "stop" ? new Date(firstSeenAt.getTime() + 10 * 60_000) : null,
      },
    });
  }
  return token;
}

describe.skipIf(!dbAvailable)("dev launch risk", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.devLaunchRisk.deleteMany({ where: { wallet: { in: wallets } } });
    await prisma.devFunderRisk.deleteMany({ where: { funder: { in: wallets } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: wallets } } });
    await prisma.funderActivity.deleteMany({ where: { address: { in: wallets } } });
  });

  const serial = wallet("Repeat");
  const once = wallet("Once");
  const farmA = wallet("FarmA");
  const farmB = wallet("FarmB");
  const farmer = wallet("Farmer");
  const viaHot = wallet("ViaHot");
  const viaHot2 = wallet("ViaHotB");
  const hot = wallet("Hot");
  const viaCex = wallet("ViaCex");
  const viaCex2 = wallet("ViaCexB");
  wallets.push(serial, once, farmA, farmB, farmer, viaHot, viaHot2, hot, viaCex, viaCex2);
  const cex = [...KNOWN_EXCHANGE_WALLETS.keys()][0]!;

  it("records each creator's launches, grades and funder family, and the scan takes a coin's own launch out", async () => {
    // Serial: three dead launches, one in the band ungraded, one stopped, one still settling.
    for (let i = 0; i < 3; i++) await launch(serial);
    await launch(serial, { inBand: true });
    const stopped = await launch(serial, { grade: "stop" });
    await launch(serial, { hoursAgo: 0.5 });
    // Once: a single dead launch, no row.
    await launch(once);
    // A farm: two fresh creators, one dead launch each, paid for by one wallet.
    await launch(farmA);
    await launch(farmB);
    // Two creators paid by a busy funder FunderActivity marks hot, and two by an exchange: no family.
    for (const w of [viaHot, viaHot2, viaCex, viaCex2]) await launch(w, { inBand: true });
    await prisma.walletFunder.createMany({
      data: [
        { wallet: farmA, status: "found", funder: farmer },
        { wallet: farmB, status: "found", funder: farmer },
        { wallet: viaHot, status: "found", funder: hot },
        { wallet: viaHot2, status: "found", funder: hot },
        { wallet: viaCex, status: "found", funder: cex },
        { wallet: viaCex2, status: "found", funder: cex },
      ],
    });
    await prisma.funderActivity.create({ data: { address: hot, hot: true } });

    const meta = await runDevLaunchRiskJob();
    expect(typeof meta.builtAt).toBe("string");

    const row = await prisma.devLaunchRisk.findUnique({ where: { wallet: serial } });
    expect(row).toMatchObject({ launches: 5, inBand: 2, graded: 1, wins: 0, stops: 1, funder: null });
    expect(row!.score).toBeGreaterThan(0);
    expect(await prisma.devLaunchRisk.findUnique({ where: { wallet: once } })).toBeNull();
    expect(await prisma.devLaunchRisk.findUnique({ where: { wallet: farmA } })).toMatchObject({
      launches: 1,
      funder: farmer,
    });
    expect(await prisma.devFunderRisk.findUnique({ where: { funder: farmer } })).toMatchObject({
      creators: 2,
      launches: 2,
      inBand: 0,
    });
    expect(await prisma.devFunderRisk.findUnique({ where: { funder: hot } })).toBeNull();
    expect(await prisma.devFunderRisk.findUnique({ where: { funder: cex } })).toBeNull();
    expect((await prisma.devLaunchRisk.findUnique({ where: { wallet: viaHot } }))!.funder).toBeNull();

    // The scan's reading, against the same rebuild.
    const devs = await prisma.devLaunchRisk.findMany({ where: { wallet: { in: wallets } } });
    const families = await prisma.devFunderRisk.findMany({ where: { funder: { in: wallets } } });
    setDevLaunchBook(
      devs.map(({ wallet: w, score: _s, lastLaunchAt: _l, computedAt: _c, ...r }) => [w, r]),
      families.map(({ funder, score: _s, computedAt: _c, ...r }) => [funder, r]),
      {
        bandRate: meta.bandRate as number,
        winRate: meta.winRate as number,
        stopRate: meta.stopRate as number,
      },
      new Date(meta.builtAt as string),
    );
    const fresh = await launch(wallet("Fresh"), { hoursAgo: 0.1 });
    wallets.push(fresh.creator!);
    await prisma.walletFunder.create({ data: { wallet: fresh.creator!, status: "found", funder: farmer } });
    const readings = await devLaunchReadings([
      { mintAddress: stopped.mintAddress, token: stopped },
      { mintAddress: "new-coin", token: null, creator: serial },
      { mintAddress: fresh.mintAddress, token: fresh },
      { mintAddress: "unknown", token: null },
    ]);
    // The stopped coin's own launch and grade are taken out of its creator's record.
    expect(readings.get(stopped.mintAddress)).toMatchObject({
      devLaunchPrior: 4,
      devLaunchPriorInBand: 1,
      devLaunchPriorGraded: 0,
      devLaunchPriorWins: 0,
      devLaunchFamilyCreators: 0,
    });
    // A coin the rebuild never saw reads the whole record.
    expect(readings.get("new-coin")).toMatchObject({ devLaunchPrior: 5, devLaunchPriorGraded: 1 });
    // A brand-new creator from the farm's funder reads the farm's launches.
    expect(readings.get(fresh.mintAddress)).toMatchObject({
      devLaunchPrior: 0,
      devLaunchFamilyCreators: 2,
      devLaunchFamilyLaunches: 2,
    });
    expect(readings.get(fresh.mintAddress)!.devLaunchRisk).not.toBeNull();
    expect(readings.has("unknown")).toBe(false);
  });
});
