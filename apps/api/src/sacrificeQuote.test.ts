// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  creditBurnCredits,
  prisma,
  resetAsdfPriceCacheForTests,
  saveSacrificeSettings,
  resetSacrificeSettingsCacheForTests,
  type SacrificeMode,
} from "@trenchscanner/core";
import { quoteSacrifice, sacrificeRefusal, sacrificeView } from "./sacrificeQuote.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const RUN = Date.now();
const PAYER = `SacrificeQuotePayer${RUN}`;
const FREE = `SacrificeQuoteFree${RUN}`;
const SOL = 1_000_000_000n;
const TOKENS = 10n ** 6n;

describe.skipIf(!dbAvailable)("quoteSacrifice", () => {
  const quote = (
    wallet: string,
    source: "holder" | "grace" | "admin" | null,
    opts: { access?: boolean } = {},
  ) =>
    quoteSacrifice({
      wallet,
      source,
      access: opts.access ?? false,
      lamports: SOL,
      liveBalance: async () => 10n ** 15n,
    });
  const mode = async (m: SacrificeMode) => saveSacrificeSettings({ mode: m, freeRank: 250 }, "test");

  /** A steady ASDF price of 740,000 a SOL from both sources over the last 5 minutes. */
  async function steadyPrice() {
    const now = Date.now();
    const rows = [];
    for (let ms = 0; ms < 5 * 60_000; ms += 15_000)
      for (const source of ["quote", "price"])
        rows.push({ at: new Date(now - ms), source, asdfPerSol: 740_000 });
    await prisma.asdfPriceSample.createMany({ data: rows });
    resetAsdfPriceCacheForTests();
  }

  beforeEach(async () => {
    await prisma.asdfPriceSample.deleteMany({});
    resetAsdfPriceCacheForTests();
  });

  afterAll(async () => {
    await prisma.asdfPriceSample.deleteMany({});
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: { in: [PAYER, FREE] } } });
    await prisma.proHolder.deleteMany({ where: { walletAddress: FREE } });
    await prisma.sacrificeSettings.deleteMany({});
    resetSacrificeSettingsCacheForTests();
  });

  it("works nothing out while off", async () => {
    await mode("off");
    const q = await quote(PAYER, "grace");
    expect(q).toMatchObject({ mode: "off", tier: null, credits: null });
    expect(sacrificeRefusal(q)).toBeNull();
  });

  it("charges a grace wallet 0.2% in burned credits, and refuses it short of them only when on", async () => {
    await steadyPrice();
    await mode("shadow");
    const shadow = await quote(PAYER, "grace");
    expect(shadow).toMatchObject({
      credits: 14.8,
      asdfRaw: 1_480n * TOKENS,
      lamports: 2_000_000n,
      needCredits: 15,
    });
    // Shadow never refuses.
    expect(sacrificeRefusal(shadow)).toBeNull();
    await mode("on");
    const refused = sacrificeRefusal(await quote(PAYER, "grace"));
    expect(refused).toMatchObject({ code: 422, body: { needCredits: 15, topUp: true, notSent: true } });
    expect(refused!.body.error).toMatch(/Sacrifice is 14\.80 credits/);
    // Burned credits cover it: no refusal.
    await creditBurnCredits(
      `SacrificeQuoteSig${RUN}`,
      { burnerWallet: PAYER, rawAmount: 1_500n * TOKENS },
      "claim",
    );
    const covered = await quote(PAYER, "grace");
    expect(covered).toMatchObject({ needCredits: 0, burnedCredits: 15 });
    expect(sacrificeRefusal(covered)).toBeNull();
    expect(sacrificeView(covered)).toMatchObject({
      mode: "on",
      pays: true,
      credits: 14.8,
      lamports: "2000000",
      bps: 20,
    });
  });

  it("refuses a fee payer with a plain message when the price can't be used, only when on", async () => {
    await mode("shadow");
    const shadow = await quote(PAYER, "grace");
    expect(shadow.priceRefusal).toMatch(/too few recent readings/);
    expect(sacrificeRefusal(shadow)).toBeNull();
    await mode("on");
    expect(sacrificeRefusal(await quote(PAYER, "grace"))).toMatchObject({
      code: 503,
      body: { notSent: true },
    });
  });

  it("leaves admins, the access buy and free-tier holders untouched", async () => {
    await mode("on");
    const at = new Date();
    await prisma.proHolder.create({
      data: {
        walletAddress: FREE,
        rank: 5,
        lastInTopAt: at,
        inTopSince: at,
        heldRaw: "1",
        freeTierSince: at,
      },
    });
    for (const q of [
      await quote(PAYER, "admin"),
      await quote(PAYER, null, { access: true }),
      await quote(FREE, "holder"),
    ]) {
      expect(q.tier?.pays).toBe(false);
      expect(q.credits).toBeNull();
      expect(sacrificeRefusal(q)).toBeNull();
    }
  });
});
