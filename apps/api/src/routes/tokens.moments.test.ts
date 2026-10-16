// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv, saveBubbleMoment } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { BubbleHolders } from "./tokens.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `moments-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 7)) % B58.length]).join(
    "",
  );
const MINT = address(`${TAG}-mint`);
const HOLDER = address(`${TAG}-holder`);

/**
 * The maps kept at the screen pass and at filters' first catches (user ask 2026-10-16): who sees
 * which, and that a public filter's catch stops anyone else's being kept.
 */
describe.skipIf(!dbAvailable)("bubble map moments", () => {
  let app: FastifyInstance;
  const users: Record<"a" | "b" | "c", { id: string; cookie: string; matchId: string }> = {} as never;
  const T0 = Date.now() - 3_600_000;

  beforeAll(async () => {
    const env = loadEnv();
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    const token = await prisma.token.create({ data: { mintAddress: MINT, symbol: "MOMT" } });
    const pass = await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        takenAt: new Date(T0),
        priceUsd: 1,
        marketCapUsd: 50_000,
        rugScreenPassed: true,
        linkedHolders: [{ wallet: HOLDER, pct: 5 }],
        linkedWalletPct: 5,
      },
    });
    // A later scan carries no list of its own: the newest list before it stands (holderListWrites.ts).
    const later = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, takenAt: new Date(T0 + 600_000), priceUsd: 1, marketCapUsd: 60_000 },
    });
    await saveBubbleMoment({
      mintAddress: MINT,
      kind: "screen",
      isPublic: true,
      momentAt: pass.takenAt,
      readAt: pass.takenAt,
      reading: { linkedHolders: [{ wallet: HOLDER, pct: 5 }], linkedWalletPct: 5 },
    });
    for (const key of ["a", "b", "c"] as const) {
      const wallet = `${TAG}-${key}`;
      const user = await prisma.user.create({ data: { walletAddress: wallet } });
      await prisma.whitelist.create({ data: { walletAddress: wallet, addedBy: TAG } });
      const filter = await prisma.userFilter.create({
        data: { userId: user.id, name: `${key} filter`, shareOnLeaderboard: key === "b" },
      });
      const match = await prisma.match.create({
        data: {
          userId: user.id,
          filterId: filter.id,
          tokenId: token.id,
          // a on the pass scan, b and c on the later one.
          snapshotId: key === "a" ? pass.id : later.id,
          matchedAt: key === "a" ? pass.takenAt : later.takenAt,
          score: 50,
        },
      });
      users[key] = {
        id: user.id,
        cookie: await signer.sign({ userId: user.id, walletAddress: wallet }),
        matchId: match.id,
      };
    }
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.bubbleMapMoment.deleteMany({ where: { mintAddress: MINT } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  const read = async (who: "a" | "b" | "c") => {
    const res = await app.inject({
      method: "GET",
      url: `/tokens/${MINT}/bubble-holders`,
      cookies: { [SESSION_COOKIE_NAME]: users[who].cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json<BubbleHolders>().moments;
  };
  const opened = async (who: "a" | "b" | "c", matchId = users[who].matchId) => {
    const res = await app.inject({
      method: "POST",
      url: `/tokens/${MINT}/bubble-moments/filter`,
      cookies: { [SESSION_COOKIE_NAME]: users[who].cookie },
      payload: { matchId },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ result: string }>().result;
  };

  it("shows everyone the screen pass", async () => {
    const moments = await read("c");
    expect(moments.map((m) => m.kind)).toEqual(["screen"]);
    expect(moments[0]!.reading.linkedHolders).toEqual([{ wallet: HOLDER, pct: 5 }]);
  });

  it("keeps a private filter's catch for its owner alone, without a second copy of the same reading", async () => {
    expect(await opened("a", users.b.matchId)).toBe("not_yours");
    expect(await opened("a")).toBe("kept");
    expect(await opened("a")).toBe("already_kept");
    const own = (await read("a")).find((m) => m.kind === "filter");
    expect(own).toMatchObject({ mine: true, isPublic: false, filterName: "a filter" });
    expect(own!.reading.linkedHolders).toEqual([{ wallet: HOLDER, pct: 5 }]);
    expect((await read("b")).map((m) => m.kind)).toEqual(["screen"]);
    const row = await prisma.bubbleMapMoment.findUnique({
      where: { mintAddress_kind_userId: { mintAddress: MINT, kind: "filter", userId: users.a.id } },
    });
    expect(row).toMatchObject({ reading: null });
    expect(row!.sameAsId).not.toBeNull();
  });

  it("shows a public filter's catch to everyone, then keeps no one else's", async () => {
    expect(await opened("b")).toBe("kept");
    const seen = await read("c");
    expect(seen.map((m) => [m.kind, m.isPublic, m.mine])).toEqual([
      ["screen", true, false],
      ["filter", true, false],
    ]);
    // Read on a scan with no list of its own: the newest list before it.
    expect(seen[1]!.reading.linkedHolders).toEqual([{ wallet: HOLDER, pct: 5 }]);
    expect(seen[1]!.at).toBe(new Date(T0 + 600_000).toISOString());
    expect(await opened("c")).toBe("public_kept");
    expect((await read("a")).filter((m) => m.kind === "filter").map((m) => m.mine)).toEqual([true, false]);
  });
});
