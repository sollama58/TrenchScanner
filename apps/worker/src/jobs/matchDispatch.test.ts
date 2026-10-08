// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, loadFilterTrackRecords, type ScoredToken } from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import {
  createMatchesForCandidate,
  markFilterPassComplete,
  resetFilterPasses,
  awaitsWalletFigure,
  ALERT_COOLDOWN_HOURS,
  FILTER_ARM_QUIET_MINUTES,
  type FilterWithUser,
} from "./matchDispatch.js";
import { resetAlertWallets } from "./walletPriority.js";
import { snapshotDataFor } from "./snapshotData.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `match-dispatch-test-${Date.now()}`;

/** Armed well before any token here was seen: most tests are about alerting, not settling in. */
const ARMED_LONG_AGO = new Date(Date.now() - 3_600_000);

function scoredFixture(mintAddress: string): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    ageMinutes: 90,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 80 },
  };
}

async function seedUserWithFilter(
  suffix: string,
  armedAt = ARMED_LONG_AGO,
  criteria: { maxEmptyTop10WalletPct?: number } = {},
): Promise<FilterWithUser> {
  const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${suffix}` } });
  return prisma.userFilter.create({
    data: {
      userId: user.id,
      name: suffix,
      mcapMin: 1_000,
      mcapMax: 10_000_000,
      isActive: true,
      armedAt,
      ...criteria,
    },
  });
}

async function seedToken(suffix: string): Promise<{ token: Token; snapshot: TokenSnapshot }> {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scoredFixture(token.mintAddress), "scan"),
  });
  return { token, snapshot };
}

describe.skipIf(!dbAvailable)("createMatchesForCandidate", () => {
  afterEach(async () => {
    resetFilterPasses();
    resetAlertWallets();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("creates a match for every user whose filter the token matches", async () => {
    const { token, snapshot } = await seedToken("all");
    const filters = [
      await seedUserWithFilter("a"),
      await seedUserWithFilter("b"),
      await seedUserWithFilter("c"),
    ];

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
    });

    expect(count).toBe(3);
    const matches = await prisma.match.findMany({ where: { tokenId: token.id } });
    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.deliveredDashboard)).toBe(true);
  });

  it("still alerts everyone else when a filter was deleted or switched off mid-cycle", async () => {
    const { token, snapshot } = await seedToken("stale-filters");
    const [kept, deleted, switchedOff] = [
      await seedUserWithFilter("kept"),
      await seedUserWithFilter("deleted"),
      await seedUserWithFilter("off"),
    ];
    // The cycle loaded all three as active; since then one was deleted and one switched off.
    await prisma.userFilter.delete({ where: { id: deleted.id } });
    await prisma.userFilter.update({ where: { id: switchedOff.id }, data: { isActive: false } });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [kept, deleted, switchedOff],
    });

    expect(count).toBe(1);
    const matches = await prisma.match.findMany({ where: { tokenId: token.id } });
    expect(matches.map((m) => m.filterId)).toEqual([kept.id]);
  });

  it("leaves a user alone for a token their filter already alerted on", async () => {
    const { token, snapshot } = await seedToken("cooldown");
    const filters = [await seedUserWithFilter("e")];
    const args = {
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
    };

    expect(await createMatchesForCandidate(args)).toBe(1);
    expect(await createMatchesForCandidate(args)).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(1);

    // Aged past the cooldown, the same token is a genuinely new call again.
    await prisma.match.updateMany({
      where: { tokenId: token.id },
      data: { matchedAt: new Date(Date.now() - (ALERT_COOLDOWN_HOURS + 1) * 3_600_000) },
    });
    expect(await createMatchesForCandidate(args)).toBe(1);
  });

  it("cools down per filter, so one user's two matching filters both alert", async () => {
    const { token, snapshot } = await seedToken("two-filters");
    const first = await seedUserWithFilter("f");
    const second = await prisma.userFilter.create({
      data: {
        userId: first.userId,
        name: "second",
        mcapMin: 1_000,
        mcapMax: 10_000_000,
        isActive: true,
        armedAt: ARMED_LONG_AGO,
      },
    });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [first, second],
    });
    expect(count).toBe(2);
  });

  it("still alerts everyone else when a just-applied filter was deleted inside its quiet window", async () => {
    const { token, snapshot } = await seedToken("deleted-while-arming");
    const kept = await seedUserWithFilter("kept-arming");
    const deleted = await seedUserWithFilter("deleted-arming", new Date());
    // Loaded as settling in; deleted before the candidate was dispatched. The baseline insert
    // used to hit the filter's FK and fail the whole candidate - every other user's alert with it.
    await prisma.userFilter.delete({ where: { id: deleted.id } });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [kept, deleted],
    });

    expect(count).toBe(1);
    expect((await prisma.match.findMany({ where: { tokenId: token.id } })).map((m) => m.filterId)).toEqual([
      kept.id,
    ]);
    expect(await prisma.filterBaseline.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("doesn't alert on what a just-applied filter already matches, then cools it down", async () => {
    // The token was on the watchlist before the filter was applied: backlog, not news.
    const { token, snapshot } = await seedToken("backlog");
    const filter = await seedUserWithFilter("fresh-filter", new Date());
    const args = {
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [filter],
    };

    expect(await createMatchesForCandidate(args)).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
    expect(await prisma.filterBaseline.count({ where: { filterId: filter.id, tokenId: token.id } })).toBe(1);

    // Past the quiet window the filter alerts normally, but this token is already known to it.
    const settled = await prisma.userFilter.update({
      where: { id: filter.id },
      data: { armedAt: new Date(Date.now() - (FILTER_ARM_QUIET_MINUTES + 1) * 60_000) },
    });
    expect(await createMatchesForCandidate({ ...args, activeFilters: [settled] })).toBe(0);

    // A token that newly matches after that is a real alert.
    const later = await seedToken("after-settling");
    expect(
      await createMatchesForCandidate({
        token: later.token,
        snapshot: later.snapshot,
        scored: scoredFixture(later.token.mintAddress),
        activeFilters: [settled],
      }),
    ).toBe(1);
  });

  it("alerts on a token that starts matching once the scan has passed over the new filter", async () => {
    // Armed a minute ago, inside the quiet bound; the scan has since evaluated the whole
    // watchlist against it. A token (older than the filter) that only now matches is news, not
    // backlog - it used to be baselined and silenced for the cooldown.
    const filter = await seedUserWithFilter("passed", new Date(Date.now() - 60_000));
    const { token, snapshot } = await seedToken("newly-matching");
    markFilterPassComplete([filter]);
    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored: scoredFixture(token.mintAddress),
        activeFilters: [filter],
      }),
    ).toBe(1);
    expect(await prisma.filterBaseline.count({ where: { filterId: filter.id } })).toBe(0);
  });

  it("settles in again when the filter is re-armed after the pass the scan completed", async () => {
    const filter = await seedUserWithFilter("re-armed", new Date(Date.now() - 120_000));
    markFilterPassComplete([filter]);
    const { token, snapshot } = await seedToken("rearm-backlog");
    // Edited since: the cycle that marked the pass loaded the old armedAt.
    const edited = await prisma.userFilter.update({
      where: { id: filter.id },
      data: { armedAt: new Date() },
    });
    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored: scoredFixture(token.mintAddress),
        activeFilters: [edited],
      }),
    ).toBe(0);
    expect(await prisma.filterBaseline.count({ where: { filterId: filter.id, tokenId: token.id } })).toBe(1);
  });

  it("alerts at once on a token first seen after the filter was applied", async () => {
    const filter = await seedUserWithFilter("newer-token", new Date(Date.now() - 5_000));
    const { token, snapshot } = await seedToken("brand-new");
    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored: scoredFixture(token.mintAddress),
        activeFilters: [filter],
      }),
    ).toBe(1);
  });

  it("does nothing at all when the token matches nobody", async () => {
    const { token, snapshot } = await seedToken("nomatch");
    const filter = await seedUserWithFilter("g");
    // Way outside this filter's band.
    const scored = { ...scoredFixture(token.mintAddress), marketCapUsd: 50_000_000 };

    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored,
        activeFilters: [filter],
      }),
    ).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("holds a match back while the token is flushing, without starting the cooldown", async () => {
    const env = { ...loadEnv(), MATCH_ALERT_GUARD: "flush" as const };
    const { token, snapshot } = await seedToken("flush");
    const filter = await seedUserWithFilter("h");
    const flushing = { ...scoredFixture(token.mintAddress), priceChange5mPct: -40 };
    const args = { token, snapshot, activeFilters: [filter], env };

    expect(await createMatchesForCandidate({ ...args, scored: flushing })).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);

    // Once it stops flushing it alerts at once - the held-back match never started a cooldown.
    const recovered = { ...scoredFixture(token.mintAddress), priceChange5mPct: 3 };
    expect(await createMatchesForCandidate({ ...args, scored: recovered })).toBe(1);
  });

  it("holds a Max empty match until the empty-wallet share is in, then judges it on the share", async () => {
    const env = { ...loadEnv(), MATCH_ALERT_GUARD: "off" as const };
    const { token, snapshot } = await seedToken("empty-wait");
    const capped = await seedUserWithFilter("k", ARMED_LONG_AGO, { maxEmptyTop10WalletPct: 60 });
    const plain = await seedUserWithFilter("l");
    const args = { token, snapshot, env };
    const unknown = scoredFixture(token.mintAddress);

    // First sighting, holders not priced yet: the filter without the ceiling alerts, the capped
    // one waits rather than letting the unknown through.
    expect(
      await createMatchesForCandidate({ ...args, scored: unknown, activeFilters: [capped, plain] }),
    ).toBe(1);
    expect(await prisma.match.count({ where: { tokenId: token.id, filterId: capped.id } })).toBe(0);

    // The share lands over the ceiling: never alerted.
    const over = { ...unknown, emptyTop10WalletPct: 80 };
    expect(await createMatchesForCandidate({ ...args, scored: over, activeFilters: [capped] })).toBe(0);
    // Under it: alerted - the wait never started a cooldown.
    const under = { ...unknown, emptyTop10WalletPct: 40 };
    expect(await createMatchesForCandidate({ ...args, scored: under, activeFilters: [capped] })).toBe(1);
  });

  it("alerts with the share unknown once the wait is over", async () => {
    const { token, snapshot } = await seedToken("empty-timeout");
    const capped = await seedUserWithFilter("m", ARMED_LONG_AGO, { maxEmptyTop10WalletPct: 60 });
    const args = { token, snapshot, scored: scoredFixture(token.mintAddress), activeFilters: [capped] };

    const waiting = { ...loadEnv(), MATCH_ALERT_GUARD: "off" as const, FILTER_WALLET_MAX_WAIT_SECONDS: 180 };
    expect(await createMatchesForCandidate({ ...args, env: waiting })).toBe(0);
    // A zero wait is "don't wait": the held match goes out.
    expect(
      await createMatchesForCandidate({ ...args, env: { ...waiting, FILTER_WALLET_MAX_WAIT_SECONDS: 0 } }),
    ).toBe(1);
  });

  it("anchors one graded outcome for every match of the token, and reports filter records", async () => {
    const env = loadEnv();
    const { token, snapshot } = await seedToken("graded");
    const filters = [await seedUserWithFilter("i"), await seedUserWithFilter("j")];
    const scored = scoredFixture(token.mintAddress);

    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored,
        activeFilters: filters,
        env,
      }),
    ).toBe(2);
    const matches = await prisma.match.findMany({ where: { tokenId: token.id } });
    const outcomeIds = new Set(matches.map((m) => m.candidateOutcomeId));
    expect(outcomeIds.size).toBe(1);
    const outcome = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: [...outcomeIds][0]! } });
    expect(outcome.sampleKind).toBe("match");
    expect(outcome.anchorPriceUsd).toBe(scored.priceUsd);

    // Graded later by the watcher; here the verdict is written directly to check the tally.
    await prisma.match.update({
      where: { id: matches.find((m) => m.filterId === filters[0]!.id)!.id },
      data: { hit2xIn1h: true, hit4xIn1h: true, disqualified: false },
    });
    const records = await loadFilterTrackRecords(filters);
    expect(records.get(filters[0]!.id)).toEqual(
      // A clean winner whose 10x hour is still open is not yet in the 10x rate's denominator.
      { graded: 1, won2x: 1, won4x: 1, won10x: 0, tenXGraded: 0 },
    );
    expect(records.get(filters[1]!.id)).toEqual({ graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0 });
  });
});

describe("awaitsWalletFigure", () => {
  const known = { freshTop10WalletPct: 10, emptyTop10WalletPct: 20, sniperTop10WalletPct: 30 };

  it("waits only for a figure the filter caps and the token lacks", () => {
    expect(awaitsWalletFigure({}, {})).toBe(false);
    expect(awaitsWalletFigure({}, { maxEmptyTop10WalletPct: 60 })).toBe(true);
    expect(awaitsWalletFigure({}, { maxFreshTop10WalletPct: 60 })).toBe(true);
    expect(awaitsWalletFigure({}, { maxSniperTop10WalletPct: 60 })).toBe(true);
    expect(awaitsWalletFigure({}, { maxEmptyTop10WalletPct: null })).toBe(false);
    expect(
      awaitsWalletFigure(known, {
        maxFreshTop10WalletPct: 60,
        maxEmptyTop10WalletPct: 60,
        maxSniperTop10WalletPct: 60,
      }),
    ).toBe(false);
    expect(
      awaitsWalletFigure({ ...known, emptyTop10WalletPct: undefined }, { maxFreshTop10WalletPct: 60 }),
    ).toBe(false);
  });
});
