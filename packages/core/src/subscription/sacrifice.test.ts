import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "../db.js";
import { creditBurnCredits, creditPots } from "./credits.js";
import {
  creditsShort,
  recordPlatformTrade,
  refundSacrifice,
  settleOpenTrades,
  settlePlatformTrade,
  tradeOutcome,
  TRADE_IN_FLIGHT_MS,
  freeBufferRank,
  resetSacrificeSettingsCacheForTests,
  sacrificeFor,
  sacrificeSettings,
  sacrificeTier,
  saveSacrificeSettings,
  updateFreeTiers,
} from "./sacrifice.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const SOL = 1_000_000_000n;

describe("sacrificeFor", () => {
  it("is 0.2% of the SOL value in ASDF base units at the price", () => {
    // 1 SOL at 740,000 ASDF a SOL: 0.002 SOL, 1,480 ASDF, 14.80 credits at 100 ASDF a credit.
    expect(sacrificeFor(SOL, 740_000, 100)).toEqual({
      asdfRaw: 1_480_000_000n,
      credits: 14.8,
      lamports: 2_000_000n,
      asdfRawPerSol: 740_000_000_000n,
    });
  });

  it("rounds up, never down, and is exact on the smallest trades", () => {
    // 0.01 SOL: 14.8 ASDF, 0.148 credits shown as 0.15.
    expect(sacrificeFor(10_000_000n, 740_000, 100)).toMatchObject({ asdfRaw: 14_800_000n, credits: 0.15 });
    // A price with a fraction: 1 lamport still costs at least one base unit.
    expect(sacrificeFor(1n, 740_000.123457, 100)).toMatchObject({ asdfRaw: 2n, lamports: 1n });
    expect(sacrificeFor(0n, 740_000, 100)).toMatchObject({ asdfRaw: 0n, credits: 0, lamports: 0n });
  });

  it("shows fewer credits after a reprice, for the same ASDF", () => {
    expect(sacrificeFor(SOL, 740_000, 200)).toMatchObject({ asdfRaw: 1_480_000_000n, credits: 7.4 });
  });
});

describe("creditsShort", () => {
  it("is the whole credits missing, rounded up", () => {
    expect(creditsShort(1_480_000_000n, 0n, 100)).toBe(15);
    expect(creditsShort(1_480_000_000n, 1_400_000_000n, 100)).toBe(1);
    expect(creditsShort(1_480_000_000n, 1_480_000_000n, 100)).toBe(0);
  });
});

describe("freeBufferRank", () => {
  it("is the cut-off plus 10, capped at 250", () => {
    expect(freeBufferRank(100)).toBe(110);
    expect(freeBufferRank(245)).toBe(250);
    expect(freeBufferRank(250)).toBe(250);
  });
});

describe.skipIf(!dbAvailable)("the fee tier", () => {
  const RUN = Date.now();
  const SCAN = new Date("2001-02-03T04:05:06Z");
  const NEXT = new Date("2001-02-03T04:10:06Z");
  const w = (name: string) => `SacrificeTier${name}${RUN}`;
  const live = (raw: bigint | null) => async () => raw;

  /** One scan's wallets by rank, each holding 1,000 base units less than the one above. */
  async function scan(at: Date, wallets: string[]) {
    for (const [i, walletAddress] of wallets.entries()) {
      const data = { rank: i + 1, lastInTopAt: at, heldRaw: String(1_000_000 - i * 1_000) };
      await prisma.proHolder.upsert({
        where: { walletAddress },
        update: data,
        create: { walletAddress, inTopSince: at, ...data },
      });
    }
    await updateFreeTiers(at);
  }

  beforeEach(async () => {
    await saveSacrificeSettings({ mode: "off", freeRank: 2 }, "test");
  });

  afterAll(async () => {
    await prisma.proHolder.deleteMany({ where: { walletAddress: { startsWith: "SacrificeTier" } } });
    await prisma.sacrificeSettings.deleteMany({});
    resetSacrificeSettingsCacheForTests();
  });

  it("is off with a cut-off of 250 until an admin saves", async () => {
    await prisma.sacrificeSettings.deleteMany({});
    resetSacrificeSettingsCacheForTests();
    expect(await sacrificeSettings()).toEqual({ mode: "off", freeRank: 250 });
  });

  it("is free for admins, grants and the access buy, whatever they hold", async () => {
    expect(await sacrificeTier({ wallet: w("Admin"), source: "admin", liveBalance: live(0n) })).toEqual({
      pays: false,
      reason: "admin",
    });
    expect(await sacrificeTier({ wallet: w("Grant"), source: "grant", liveBalance: live(0n) })).toMatchObject(
      {
        pays: false,
        reason: "grant",
      },
    );
    expect(
      await sacrificeTier({ wallet: w("Buyer"), source: null, access: true, liveBalance: live(0n) }),
    ).toMatchObject({ pays: false, reason: "access" });
  });

  it("frees the top of the scan, keeps the buffer, and charges below it", async () => {
    // Cut-off 2, buffer 12: A and B start free, C doesn't.
    const order = ["A", "B", "C"].map(w);
    await scan(SCAN, order);
    const tier = (name: string, raw: bigint | null = 1_000_000n) =>
      sacrificeTier({ wallet: w(name), source: "holder", liveBalance: live(raw) });
    expect(await tier("A")).toMatchObject({ pays: false, reason: "holder", rank: 1 });
    expect(await tier("B")).toMatchObject({ pays: false, reason: "holder", rank: 2 });
    expect(await tier("C")).toMatchObject({ pays: true, reason: "below_cutoff", rank: 3 });
    // The next scan: B slips to 3, inside the buffer, and keeps its tier; C rises to 2 and gets it.
    await scan(NEXT, ["A", "C", "B"].map(w));
    expect(await tier("B")).toMatchObject({ pays: false, rank: 3 });
    expect(await tier("C")).toMatchObject({ pays: false, rank: 2 });
  });

  it("charges a free wallet that has moved its bag since the scan", async () => {
    await scan(SCAN, ["A", "B", "C"].map(w));
    // The cut-off wallet (rank 2) held 999,000 in the scan.
    const holderA = (raw: bigint | null) =>
      sacrificeTier({ wallet: w("A"), source: "holder", liveBalance: live(raw) });
    expect(await holderA(999_000n)).toMatchObject({ pays: false });
    expect(await holderA(998_999n)).toMatchObject({ pays: true, reason: "moved_bag", rank: 1 });
    // A failed balance read keeps the scan's tier.
    expect(await holderA(null)).toMatchObject({ pays: false });
  });

  it("ends the tier for a wallet that drops out of the scan or past the buffer", async () => {
    await scan(SCAN, ["A", "B"].map(w));
    await scan(NEXT, ["A"].map(w));
    const b = await prisma.proHolder.findUnique({ where: { walletAddress: w("B") } });
    expect(b?.freeTierSince).toBeNull();
    // Grace wallets pay.
    expect(
      await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: true,
      reason: "below_cutoff",
    });
  });

  it("keeps every tier as it was while the scans have stopped", async () => {
    await scan(SCAN, ["A", "B", "C"].map(w));
    // No newer scan is written: the tiers stand, the live balance check still applies.
    expect(
      await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(999_000n) }),
    ).toMatchObject({
      pays: false,
    });
    expect(await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(0n) })).toMatchObject({
      pays: true,
      reason: "moved_bag",
    });
  });

  it("charges a free wallet past a cut-off lowered since its scan", async () => {
    await saveSacrificeSettings({ mode: "off", freeRank: 12 }, "test");
    await scan(SCAN, ["A", "B", "C"].map(w));
    await saveSacrificeSettings({ mode: "off", freeRank: 1 }, "test");
    // Buffer is now 11: C (rank 3) is still inside it, until the cut-off is lowered further.
    expect(
      await sacrificeTier({ wallet: w("C"), source: "holder", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: false,
    });
    await prisma.proHolder.update({ where: { walletAddress: w("C") }, data: { rank: 20 } });
    expect(
      await sacrificeTier({ wallet: w("C"), source: "holder", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: true,
      reason: "below_cutoff",
    });
  });
});

describe.skipIf(!dbAvailable)("taking the Sacrifice at send", () => {
  const RUN = Date.now();
  const W = `SacrificeSendWallet${RUN}`;
  const PACE = `SacrificePace${RUN}`;
  const TOKENS = 10n ** 6n;
  const trade = (n: number, mode: "on" | "shadow" | "off", asdfRaw: bigint | null = 1_000n * TOKENS) => ({
    signature: `SacrificeSendSig${RUN}-${n}`,
    wallet: W,
    mint: "So11111111111111111111111111111111111111112",
    side: "buy" as const,
    lamports: SOL,
    networkFeeLamports: 10_000n,
    sacrifice: {
      mode,
      tier: "below_cutoff" as const,
      pays: true,
      asdfRaw,
      lamports: 2_000_000n,
      asdfPerSol: 740_000,
    },
  });

  afterAll(async () => {
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: W } });
    await prisma.platformTrade.deleteMany({
      where: { OR: [{ wallet: W }, { wallet: { startsWith: PACE } }] },
    });
  });

  it("lets only one of two sends spend the same credits, and records each charge with its trade", async () => {
    await creditBurnCredits(
      `SacrificeSendBurn${RUN}`,
      { burnerWallet: W, rawAmount: 1_500n * TOKENS },
      "claim",
    );
    const outcomes = await Promise.all([
      recordPlatformTrade(trade(1, "on")),
      recordPlatformTrade(trade(2, "on")),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["recorded", "short"]);
    expect((await creditPots(W, prisma, 100)).burnedRaw).toBe(500n * TOKENS);
    // The short one wrote nothing: no trade row, so nothing went on chain for it either.
    expect(await prisma.platformTrade.count({ where: { wallet: W } })).toBe(1);
    const row = await prisma.platformTrade.findFirst({ where: { wallet: W } });
    expect(row).toMatchObject({
      platformFeeLamports: 2_000_000n,
      sacrificeAsdfRaw: 1_000n * TOKENS,
      sacrificeMode: "on",
      feeTier: "below_cutoff",
      asdfPerSol: "740000",
    });
  });

  it("records the Sacrifice in shadow mode but takes nothing", async () => {
    const before = (await creditPots(W, prisma, 100)).burnedRaw;
    expect(await recordPlatformTrade(trade(3, "shadow", 9_000n * TOKENS))).toEqual({
      status: "recorded",
      taken: 0n,
    });
    expect((await creditPots(W, prisma, 100)).burnedRaw).toBe(before);
    expect(
      await prisma.platformTrade.findUnique({ where: { signature: trade(3, "shadow").signature } }),
    ).toMatchObject({
      platformFeeLamports: 0n,
      sacrificeAsdfRaw: 9_000n * TOKENS,
      sacrificeMode: "shadow",
    });
    expect(await refundSacrifice(trade(3, "shadow").signature)).toBe(0n);
  });

  it("lets one paced send through and refuses the next until the window has passed", async () => {
    const wallet = `${PACE}-window`;
    const paceMs = 60_000;
    const opened = await recordPlatformTrade({ ...trade(10, "off"), wallet, paceMs, now: Date.now() });
    expect(opened).toMatchObject({ status: "recorded" });
    const row = await prisma.platformTrade.findUniqueOrThrow({
      where: { signature: trade(10, "off").signature },
    });
    // Landed: the pace alone holds the next one.
    await settlePlatformTrade(trade(10, "off").signature, "confirmed");
    const again = await recordPlatformTrade({
      ...trade(11, "off"),
      wallet,
      paceMs,
      now: row.sentAt.getTime() + 1_000,
    });
    expect(again.status).toBe("too-soon");
    if (again.status === "too-soon") expect(again.retryAfterMs).toBeGreaterThan(0);
    expect(
      await recordPlatformTrade({
        ...trade(12, "off"),
        wallet,
        paceMs,
        now: row.sentAt.getTime() + paceMs,
      }),
    ).toMatchObject({ status: "recorded" });
  });

  it("does not let a trade Sender refused hold the next one", async () => {
    const wallet = `${PACE}-refused`;
    const now = Date.now();
    expect(await recordPlatformTrade({ ...trade(17, "off"), wallet, paceMs: 60_000, now })).toMatchObject({
      status: "recorded",
    });
    expect(await settlePlatformTrade(trade(17, "off").signature, "failed")).toBe(true);
    expect(
      await recordPlatformTrade({ ...trade(18, "off"), wallet, paceMs: 60_000, now: now + 1_000 }),
    ).toMatchObject({ status: "recorded" });
  });

  it("lets only one of two paced sends at the same moment through", async () => {
    const wallet = `${PACE}-race`;
    const now = Date.now();
    const outcomes = await Promise.all([
      recordPlatformTrade({ ...trade(13, "off"), wallet, paceMs: 60_000, now }),
      recordPlatformTrade({ ...trade(14, "off"), wallet, paceMs: 60_000, now }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["recorded", "too-soon"]);
  });

  it("counts a closing sale toward the next paced trade", async () => {
    const wallet = `${PACE}-close`;
    expect(await recordPlatformTrade({ ...trade(15, "off"), wallet })).toMatchObject({ status: "recorded" });
    const row = await prisma.platformTrade.findUniqueOrThrow({
      where: { signature: trade(15, "off").signature },
    });
    expect(
      await recordPlatformTrade({
        ...trade(16, "off"),
        wallet,
        paceMs: 60_000,
        now: row.sentAt.getTime() + 1_000,
      }),
    ).toMatchObject({ status: "too-soon" });
  });

  it("refuses a paced trade while another from the wallet is still in flight, for its blockhash's life", async () => {
    const wallet = `${PACE}-flight`;
    expect(await recordPlatformTrade({ ...trade(20, "off"), wallet, paceMs: 1_000 })).toMatchObject({
      status: "recorded",
    });
    const sentAt = (
      await prisma.platformTrade.findUniqueOrThrow({ where: { signature: trade(20, "off").signature } })
    ).sentAt.getTime();
    // Past the pace, the first still "sent": another tab's or device's trade is refused.
    const held = await recordPlatformTrade({
      ...trade(21, "off"),
      wallet,
      paceMs: 1_000,
      now: sentAt + 5_000,
    });
    expect(held).toEqual({ status: "in-flight", retryAfterMs: TRADE_IN_FLIGHT_MS - 5_000 });
    expect(await prisma.platformTrade.count({ where: { wallet } })).toBe(1);
    // A closing sale is never refused.
    expect(await recordPlatformTrade({ ...trade(22, "off"), wallet, now: sentAt + 5_000 })).toMatchObject({
      status: "recorded",
    });
    // A row nobody settled stops holding the wallet once its blockhash is done.
    expect(
      await recordPlatformTrade({
        ...trade(23, "off"),
        wallet,
        paceMs: 1_000,
        now: sentAt + TRADE_IN_FLIGHT_MS + 60_000,
      }),
    ).toMatchObject({ status: "recorded" });
  });

  it("does not let a confirmed, failed or expired trade hold the next one", async () => {
    for (const [n, outcome] of [
      [30, "confirmed"],
      [32, "failed"],
      [34, "expired"],
    ] as const) {
      const wallet = `${PACE}-settled-${outcome}`;
      expect(await recordPlatformTrade({ ...trade(n, "off"), wallet, paceMs: 1_000 })).toMatchObject({
        status: "recorded",
      });
      const sentAt = (
        await prisma.platformTrade.findUniqueOrThrow({ where: { signature: trade(n, "off").signature } })
      ).sentAt.getTime();
      await settlePlatformTrade(trade(n, "off").signature, outcome);
      expect(
        await recordPlatformTrade({ ...trade(n + 1, "off"), wallet, paceMs: 1_000, now: sentAt + 2_000 }),
      ).toMatchObject({ status: "recorded" });
    }
  });

  it("refunds a trade's Sacrifice once, however many times it is asked", async () => {
    // Either send can win the race above: refund the one that was recorded.
    const sig = (await prisma.platformTrade.findFirstOrThrow({ where: { wallet: W, sacrificeMode: "on" } }))
      .signature;
    const before = (await creditPots(W, prisma, 100)).burnedRaw;
    const refunds = await Promise.all([refundSacrifice(sig), refundSacrifice(sig)]);
    expect(refunds.sort()).toEqual([0n, 1_000n * TOKENS]);
    expect((await creditPots(W, prisma, 100)).burnedRaw).toBe(before + 1_000n * TOKENS);
    expect(await refundSacrifice(sig)).toBe(0n);
  });
});

describe("tradeOutcome", () => {
  const sent = new Date("2026-10-18T21:00:00Z");
  const at = (ms: number) => new Date(sent.getTime() + ms);
  it("follows the chain, and calls a trade unseen past 5 minutes expired", () => {
    expect(tradeOutcome({ seen: true, confirmed: true, error: null }, sent, at(1_000))).toBe("confirmed");
    expect(tradeOutcome({ seen: true, confirmed: false, error: "{}" }, sent, at(1_000))).toBe("failed");
    expect(tradeOutcome({ seen: true, confirmed: false, error: null }, sent, at(10 * 60_000))).toBeNull();
    expect(tradeOutcome({ seen: false }, sent, at(4 * 60_000))).toBeNull();
    expect(tradeOutcome({ seen: false }, sent, at(5 * 60_000 + 1))).toBe("expired");
    expect(tradeOutcome(null, sent, at(60 * 60_000))).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("settling trades", () => {
  const RUN = Date.now();
  const W = `SacrificeSettleWallet${RUN}`;
  const TOKENS = 10n ** 6n;
  const sig = (n: number) => `SacrificeSettleSig${RUN}-${n}`;
  const send = (n: number) =>
    recordPlatformTrade({
      signature: sig(n),
      wallet: W,
      mint: "So11111111111111111111111111111111111111112",
      side: "sell",
      lamports: SOL,
      networkFeeLamports: 10_000n,
      sacrifice: {
        mode: "on",
        tier: "below_cutoff",
        pays: true,
        asdfRaw: 100n * TOKENS,
        lamports: 2_000_000n,
        asdfPerSol: 740_000,
      },
    });

  afterAll(async () => {
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: W } });
    await prisma.platformTrade.deleteMany({ where: { wallet: W } });
  });

  it("refunds a failed trade once and leaves a confirmed one charged", async () => {
    await creditBurnCredits(
      `SacrificeSettleBurn${RUN}`,
      { burnerWallet: W, rawAmount: 1_000n * TOKENS },
      "claim",
    );
    await send(1);
    await send(2);
    expect((await creditPots(W, prisma, 100)).burnedRaw).toBe(800n * TOKENS);
    // The panel and the job race on the failed one: one settles it, the refund lands once.
    const raced = await Promise.all([
      settlePlatformTrade(sig(1), "failed"),
      settlePlatformTrade(sig(1), "failed"),
    ]);
    expect(raced.sort()).toEqual([false, true]);
    expect(await settlePlatformTrade(sig(2), "confirmed")).toBe(true);
    // A later "expired" can't move a confirmed trade or refund it.
    expect(await settlePlatformTrade(sig(2), "expired")).toBe(false);
    expect((await creditPots(W, prisma, 100)).burnedRaw).toBe(900n * TOKENS);
  });

  it("settles open trades nobody watched, only once they're 2 minutes old", async () => {
    await send(3);
    await send(4);
    const old = new Date(Date.now() - 10 * 60_000);
    await prisma.platformTrade.updateMany({
      where: { signature: { in: [sig(3), sig(4)] } },
      data: { sentAt: old },
    });
    await send(5);
    const looked: string[] = [];
    const rpc = {
      getSignatureStatus: async (s: string) => {
        looked.push(s);
        return s === sig(3)
          ? ({ seen: true, confirmed: true, error: null } as const)
          : ({ seen: false } as const);
      },
    };
    const result = await settleOpenTrades(rpc);
    expect(looked).not.toContain(sig(5));
    expect(result).toMatchObject({ settled: 2, refunded: 1 });
    const rows = await prisma.platformTrade.findMany({
      where: { signature: { in: [sig(3), sig(4), sig(5)] } },
      orderBy: { signature: "asc" },
      select: { status: true },
    });
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "expired", "sent"]);
  });
});
