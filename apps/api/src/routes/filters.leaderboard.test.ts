// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { MAX_FILTERS_PER_USER } from "./filters.js";
import { FILTER_CRITERIA_KEYS, filterLeaderboardCache, MIN_GRADED_TO_RANK } from "../filterLeaderboard.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `filters-board-test-${Date.now()}`;
const OWNER = `${TAG}-owner`;
const READER = `${TAG}-reader`;

describe.skipIf(!dbAvailable)("filter leaderboard and copy", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let readerCookie: string;
  let ownerId: string;
  let readerId: string;
  let tokenId: string;
  let snapshotId: string;

  beforeAll(async () => {
    const env = loadEnv();
    app = await buildServer(env);
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    ownerId = (await prisma.user.create({ data: { walletAddress: OWNER } })).id;
    readerId = (await prisma.user.create({ data: { walletAddress: READER } })).id;
    await prisma.whitelist.createMany({
      data: [OWNER, READER].map((walletAddress) => ({ walletAddress, addedBy: TAG })),
    });
    ownerCookie = await signer.sign({ userId: ownerId, walletAddress: OWNER, sessionVersion: 0 });
    readerCookie = await signer.sign({ userId: readerId, walletAddress: READER, sessionVersion: 0 });
    tokenId = (await prisma.token.create({ data: { mintAddress: `${TAG}-mint` } })).id;
    snapshotId = (await prisma.tokenSnapshot.create({ data: { tokenId, priceUsd: 1, marketCapUsd: 50_000 } }))
      .id;
  });

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await prisma.whitelist.deleteMany({ where: { walletAddress: { in: [OWNER, READER] } } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: [OWNER, READER] } } });
    await prisma.token.deleteMany({ where: { mintAddress: `${TAG}-mint` } });
  });

  function call(cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) {
    return app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  }

  /** `graded` graded alerts for a filter, `wins` of them clean 2x (half of those also 4x). */
  async function grade(filterId: string, graded: number, wins: number, ageMs = 60_000, runPct = 100) {
    // The filter was created a moment ago; its record has to reach back over these alerts.
    await prisma.userFilter.update({
      where: { id: filterId },
      data: { criteriaChangedAt: new Date(Date.now() - 3_600_000) },
    });
    await prisma.match.createMany({
      data: Array.from({ length: graded }, (_, i) => ({
        userId: ownerId,
        filterId,
        tokenId,
        snapshotId,
        score: 50,
        matchedAt: new Date(Date.now() - ageMs - i * 1000),
        hit2xIn1h: i < wins,
        hit4xIn1h: i < wins / 2,
        disqualified: false,
        peak1hReturnPct: i < wins ? 100 : 10,
        maxDrawdown1hPct: -60,
        peak24hReturnPct: i < wins ? runPct : 10,
      })),
    });
  }

  async function board(cookie = readerCookie) {
    filterLeaderboardCache.clear();
    const res = await call(cookie, "GET", "/filters/leaderboard");
    expect(res.statusCode).toBe(200);
    return res.json() as {
      ranked: { id: string; rank: number; score: number; graded: number; mine: boolean; criteria: object }[];
      warmingUp: { id: string; graded: number }[];
    };
  }

  it("ranks only shared filters with enough graded alerts, best score first, and never names owners", async () => {
    const mk = async (name: string, share: boolean) =>
      (
        (
          await call(ownerCookie, "POST", "/filters", {
            name,
            isActive: false,
            shareOnLeaderboard: share,
            maxFreshTop10WalletPct: 40,
            narrativeKeywords: ["cat"],
          })
        ).json() as { id: string }
      ).id;
    const strong = await mk("strong", true);
    const weak = await mk("weak", true);
    const young = await mk("young", true);
    const hidden = await mk("hidden", false);
    await grade(strong, 40, 30);
    await grade(weak, 40, 4);
    await grade(young, MIN_GRADED_TO_RANK - 1, 20);
    await grade(hidden, 40, 40);

    const b = await board();
    expect(b.ranked.map((e) => e.id)).toEqual([strong, weak]);
    expect(b.ranked[0]!.rank).toBe(1);
    expect(b.ranked[0]!.score).toBeGreaterThan(b.ranked[1]!.score);
    expect(b.ranked.every((e) => !e.mine)).toBe(true);
    expect(b.warmingUp.map((e) => e.id)).toEqual([young]);
    const raw = JSON.stringify(b);
    expect(raw).not.toContain(OWNER);
    expect(raw).not.toContain(ownerId);
    // The owner sees their own entries flagged.
    expect((await board(ownerCookie)).ranked.every((e) => e.mine)).toBe(true);
  });

  it("ranks bigger runs higher when the 2x and 4x records are the same", async () => {
    const mk = async (name: string) =>
      (
        (
          await call(ownerCookie, "POST", "/filters", { name, isActive: false, shareOnLeaderboard: true })
        ).json() as { id: string }
      ).id;
    const runner = await mk("runner");
    const flat = await mk("flat");
    await grade(runner, 40, 10, 60_000, 4900); // winners ran to 50x
    await grade(flat, 40, 10, 60_000, 100); // winners stopped at 2x
    const b = await board();
    const at = (id: string) => b.ranked.find((e) => e.id === id)!;
    expect(at(runner).score).toBeGreaterThan(at(flat).score);
    expect(b.ranked.findIndex((e) => e.id === runner)).toBeLessThan(b.ranked.findIndex((e) => e.id === flat));
    await prisma.userFilter.deleteMany({ where: { id: { in: [runner, flat] } } });
  });

  it("starts a filter's record over when its criteria change, but not on a rename", async () => {
    const strong = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "strong" } });
    expect((await call(ownerCookie, "PATCH", `/filters/${strong.id}`, { name: "strong!" })).statusCode).toBe(
      200,
    );
    expect((await board()).ranked.map((e) => e.id)).toContain(strong.id);
    // The same value again is not a change either.
    await call(ownerCookie, "PATCH", `/filters/${strong.id}`, { maxFreshTop10WalletPct: 40 });
    expect((await board()).ranked.map((e) => e.id)).toContain(strong.id);

    await call(ownerCookie, "PATCH", `/filters/${strong.id}`, { maxFreshTop10WalletPct: 30 });
    const b = await board();
    expect(b.ranked.map((e) => e.id)).not.toContain(strong.id);
    expect(b.warmingUp.find((e) => e.id === strong.id)?.graded).toBe(0);
  });

  it("copies a shared filter's criteria into a new inactive, unshared filter of the reader's", async () => {
    const weak = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "weak" } });
    const res = await call(readerCookie, "POST", `/filters/leaderboard/${weak.id}/copy`);
    expect(res.statusCode).toBe(201);
    const copy = await prisma.userFilter.findUniqueOrThrow({
      where: { id: (res.json() as { id: string }).id },
    });
    expect(copy.userId).toBe(readerId);
    expect(copy.name).toBe("Copy of weak");
    expect(copy.isActive).toBe(false);
    expect(copy.shareOnLeaderboard).toBe(false);
    for (const k of FILTER_CRITERIA_KEYS) expect(copy[k]).toEqual(weak[k]);
  });

  it("refuses to copy an unshared filter, and past the reader's filter cap", async () => {
    const hidden = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "hidden" } });
    expect((await call(readerCookie, "POST", `/filters/leaderboard/${hidden.id}/copy`)).statusCode).toBe(404);

    const weak = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "weak" } });
    const have = await prisma.userFilter.count({ where: { userId: readerId } });
    for (let i = have; i < MAX_FILTERS_PER_USER; i++) {
      expect((await call(readerCookie, "POST", `/filters/leaderboard/${weak.id}/copy`)).statusCode).toBe(201);
    }
    expect((await call(readerCookie, "POST", `/filters/leaderboard/${weak.id}/copy`)).statusCode).toBe(409);
    expect(await prisma.userFilter.count({ where: { userId: readerId } })).toBe(MAX_FILTERS_PER_USER);
  });

  it("deleting a filter that ever ranked in the top few retires it; any other is gone with its alerts", async () => {
    // "strong" led the board when it was built above, so its best rank is recorded; "weak" was
    // second on a board of two, so it also qualifies - give it a rank it never had instead.
    const strong = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "strong!" } });
    expect(strong.bestRank).toBe(1);
    const weak = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId, name: "weak" } });
    await prisma.userFilter.update({ where: { id: weak.id }, data: { bestRank: 7 } });
    const weakAlerts = await prisma.match.count({ where: { filterId: weak.id } });
    expect(weakAlerts).toBeGreaterThan(0);

    expect((await call(ownerCookie, "DELETE", `/filters/${strong.id}`)).statusCode).toBe(204);
    expect((await call(ownerCookie, "DELETE", `/filters/${weak.id}`)).statusCode).toBe(204);

    // Retired: hidden from its owner, off, out of their cap, but still on the board with its record.
    const retired = await prisma.userFilter.findUniqueOrThrow({ where: { id: strong.id } });
    expect(retired.deletedAt).not.toBeNull();
    expect(retired.isActive).toBe(false);
    const mine = (await call(ownerCookie, "GET", "/filters")).json() as { id: string }[];
    expect(mine.map((f) => f.id)).not.toContain(strong.id);
    expect((await call(ownerCookie, "PATCH", `/filters/${strong.id}`, { name: "x" })).statusCode).toBe(404);
    expect((await call(ownerCookie, "DELETE", `/filters/${strong.id}`)).statusCode).toBe(404);
    const b = await board();
    // Its record restarted when its criteria changed above, so it is warming up again - still listed.
    const entry = [...b.ranked, ...b.warmingUp].find((e) => e.id === strong.id) as
      { retired?: boolean } | undefined;
    expect(entry?.retired).toBe(true);
    expect((await call(readerCookie, "POST", `/filters/leaderboard/${strong.id}/copy`)).statusCode).toBe(409);

    // Gone, alerts and all.
    expect(await prisma.userFilter.findUnique({ where: { id: weak.id } })).toBeNull();
    expect(await prisma.match.count({ where: { filterId: weak.id } })).toBe(0);
    expect(b.ranked.map((e) => e.id)).not.toContain(weak.id);
  });

  it("covers every criterion column of UserFilter in FILTER_CRITERIA_KEYS", async () => {
    // A new filter field must be added to the copy list too, or copies would silently drop it.
    const row = await prisma.userFilter.findFirstOrThrow({ where: { userId: ownerId } });
    const notCriteria = new Set([
      "id",
      "userId",
      "name",
      "isActive",
      "shareOnLeaderboard",
      "createdAt",
      "updatedAt",
      "criteriaChangedAt",
      "armedAt",
      "bestRank",
      "deletedAt",
    ]);
    const criteria = Object.keys(row).filter((k) => !notCriteria.has(k));
    expect(criteria.sort()).toEqual([...FILTER_CRITERIA_KEYS].sort());
  });
});
