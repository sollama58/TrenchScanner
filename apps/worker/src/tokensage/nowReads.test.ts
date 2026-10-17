// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, type Env, type TokenSageClient } from "@trenchscanner/core";
import { flushNowReads, noteNowWanted, resetNowReads, takeNowStats } from "./nowReads.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ts-now-${Date.now()}`;

function fakeClient() {
  const now = vi.fn();
  return { client: { now } as unknown as TokenSageClient, now };
}

const item = (ca: string, asOf: string, status = "complete") => ({
  ca,
  status,
  as_of: asOf,
  trend: { matched: true, score: 0.4, novelty: 0.9, terms: [] },
  story_heat: {
    story: "Moo Deng",
    story_kind: "referent",
    status: "ok",
    as_of: asOf,
    coins: 2,
    leader: { mint: "LEADER", mcap_usd: 9e7, change_1h_pct: -4, peak_minutes_ago: 30 },
    wave_volume_1h_usd: 1e6,
  },
});

describe.skipIf(!dbAvailable)("TokenSage decision-time refresh", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable
    ? { ...base, TOKENSAGE_ENABLED: true, TOKENSAGE_API_URL: "https://ts.test", TOKENSAGE_API_KEY: "k" }
    : base;
  const full = `${TAG}-full`;
  const basic = `${TAG}-basic`;

  beforeEach(async () => {
    resetNowReads();
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: { mintAddress: full, depth: "full", status: "complete", checkedAt: new Date() },
    });
    await prisma.tokenNarrative.create({
      data: { mintAddress: basic, depth: "basic", status: "complete", checkedAt: new Date() },
    });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("does nothing while switched off or with nothing noted", async () => {
    const { client, now } = fakeClient();
    noteNowWanted(full, { ...env, TOKENSAGE_ENABLED: false });
    expect(await flushNowReads(env, client)).toBe(0);
    expect(now).not.toHaveBeenCalled();
  });

  it("asks only for noted coins with a full read, stores the refresh, and waits before asking again", async () => {
    const { client, now } = fakeClient();
    const t0 = Date.parse("2026-10-13T21:00:00Z");
    now.mockResolvedValueOnce([item(full, "2026-10-13T21:00:00Z")]);
    noteNowWanted(full, env, t0);
    noteNowWanted(basic, env, t0);
    expect(await flushNowReads(env, client, t0)).toBe(1);
    expect(now).toHaveBeenCalledWith([full]);
    const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: full } });
    expect(row).toMatchObject({
      nowTrendMatched: true,
      nowTrendNovelty: 0.9,
      heatCoins: 2,
      heatLeaderMcapUsd: 9e7,
      heatPeakMinutesAgo: 30,
      heatIsLeader: false,
    });
    expect(row.nowAt?.toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(row.nowRead).toMatchObject({ story_heat: { story: "Moo Deng" } });
    // Fresh: not asked again within the refresh interval.
    noteNowWanted(full, env, t0 + 60_000);
    expect(await flushNowReads(env, client, t0 + 60_000)).toBe(0);
    expect(now).toHaveBeenCalledTimes(1);
    expect(takeNowStats()).toMatchObject({ asked: 1, stored: 1 });
  });

  it("keeps the newer stored refresh when a pending item carries an older one", async () => {
    const { client, now } = fakeClient();
    const t0 = Date.parse("2026-10-13T21:00:00Z");
    await prisma.tokenNarrative.update({
      where: { mintAddress: full },
      data: { nowAt: new Date("2026-10-13T20:50:00Z"), heatCoins: 7 },
    });
    now.mockResolvedValueOnce([item(full, "2026-10-13T20:50:00Z", "pending")]);
    noteNowWanted(full, env, t0);
    expect(await flushNowReads(env, client, t0)).toBe(0);
    const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: full } });
    expect(row.heatCoins).toBe(7);
  });

  it("forgets a coin not noted for a while (it left the band)", async () => {
    const { client, now } = fakeClient();
    const t0 = Date.parse("2026-10-13T21:00:00Z");
    noteNowWanted(full, env, t0);
    expect(await flushNowReads(env, client, t0 + 11 * 60_000)).toBe(0);
    expect(now).not.toHaveBeenCalled();
  });

  it("survives TokenSage failing", async () => {
    const { client, now } = fakeClient();
    now.mockRejectedValueOnce(new Error("boom"));
    noteNowWanted(full, env);
    expect(await flushNowReads(env, client)).toBe(0);
    expect(takeNowStats().errors).toBe(1);
  });
});
