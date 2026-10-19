// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { clearTokenDetailCache, pickReadingTraits } from "./tokens.js";

/**
 * GET /tokens/:mint?reading=1, the token view's poll: the newest scan and the one its holder reading
 * draws, chosen here as the web's pickReading chooses among the 50 rows (API audit 2026-10-19 F5),
 * and every scan's safety verdict for the safety flip.
 */

type Row = {
  id: string;
  takenAt: string;
  rugScreenPassed: boolean;
  linkedWalletPct: number | null;
  linkedClusters: unknown[] | null;
  linkedHolders: unknown[] | null;
};

/** web bubbleMap.ts hasHolderList and pickReading, as the view ran them over the 50 full rows. */
const hasHolderList = (s: Row) => (s.linkedHolders?.length ?? 0) > 0 || (s.linkedClusters?.length ?? 0) > 0;
const webPick = (rows: readonly Row[]) =>
  rows.find((s) => s.linkedWalletPct != null && hasHolderList(s)) ??
  rows.find(hasHolderList) ??
  rows.find((s) => s.linkedWalletPct != null) ??
  null;

describe("pickReadingTraits", () => {
  const r = (id: number, linked: boolean, hasList: boolean) => ({ id, linked, hasList });
  it("makes web pickReading's choice", () => {
    expect(pickReadingTraits([r(1, false, false), r(2, true, false), r(3, true, true)])?.id).toBe(3);
    expect(pickReadingTraits([r(1, false, false), r(2, true, false)])?.id).toBe(2);
    expect(pickReadingTraits([])).toBeNull();
    expect(pickReadingTraits([r(1, false, false), r(2, false, true), r(3, true, false)])?.id).toBe(2);
    expect(pickReadingTraits([r(1, true, true), r(2, true, true)])?.id).toBe(1);
    expect(pickReadingTraits([r(1, false, true), r(2, true, true)])?.id).toBe(2);
    expect(pickReadingTraits([r(1, false, false)])).toBeNull();
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `reading-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mint = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 11)) % B58.length]).join(
    "",
  );

const HOLDERS = [{ wallet: "W1", pct: 12 }];
const CLUSTERS = [{ funder: "F", wallets: ["W1", "W2"], pct: 20 }];

/** One scan, newest first by its place: what it kept of the holder reading. */
type Spec = {
  linked?: number;
  holders?: unknown[];
  clusters?: unknown[];
  passed?: boolean;
};

/** Each coin's scans, newest first. */
const CASES: Record<string, Spec[]> = {
  // The newest checked list wins over an older one's clusters.
  newestChecked: [
    { linked: 0, holders: HOLDERS },
    { linked: 20, holders: HOLDERS, clusters: CLUSTERS },
  ],
  // A newer list whose funders weren't read loses to an earlier checked one.
  earlierChecked: [{ holders: HOLDERS, passed: false }, {}, { linked: 0, holders: HOLDERS }, {}],
  // Only a list, no funders read anywhere.
  listOnly: [{}, { linked: 0 }, { holders: HOLDERS }, { linked: 5 }],
  // A linked reading without any list; an empty list counts as none.
  linkedOnly: [{ holders: [] }, { clusters: [] }, { linked: 3 }, { linked: 7 }],
  // Nothing to draw.
  none: [{}, { holders: [] }, {}],
  // The checked list at the 50th row is in reach; the one past it isn't.
  deep: [
    ...Array.from({ length: 49 }, (_, i): Spec =>
      i === 10 ? { holders: HOLDERS } : { passed: i % 7 !== 0 },
    ),
    { linked: 1, holders: HOLDERS },
    { linked: 2, holders: HOLDERS, clusters: CLUSTERS },
  ],
  // Past the 50th row only: the list-only row at 10 is the choice.
  pastFifty: [
    ...Array.from({ length: 50 }, (_, i): Spec => (i === 10 ? { holders: HOLDERS } : {})),
    { linked: 1, holders: HOLDERS },
  ],
};

describe.skipIf(!dbAvailable)("GET /tokens/:mint?reading=1", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;
  const mints = Object.fromEntries(Object.keys(CASES).map((k) => [k, mint(`${TAG}-${k}`)]));

  beforeAll(async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    const now = Date.now();
    for (const [name, specs] of Object.entries(CASES)) {
      const token = await prisma.token.create({
        data: { mintAddress: mints[name]!, symbol: "RDG", discoverySource: "pumpportal" },
      });
      await prisma.tokenSnapshot.createMany({
        data: specs.map((s, i) => ({
          tokenId: token.id,
          takenAt: new Date(now - (i + 1) * 15_000),
          priceUsd: 1,
          marketCapUsd: 10_000 + i,
          rugScreenPassed: s.passed ?? true,
          linkedWalletPct: s.linked ?? null,
          ...(s.holders ? { linkedHolders: s.holders as object[] } : {}),
          ...(s.clusters ? { linkedClusters: s.clusters as object[] } : {}),
          flaggedTrades: [{ wallet: "W", side: 1, sol: 1, atMs: 1 }],
        })),
      });
    }
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
    clearTokenDetailCache();
  });

  afterAll(async () => {
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { in: Object.values(mints) } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  it.each(Object.keys(CASES))("sends the newest scan and the one the view would pick: %s", async (name) => {
    const m = mints[name]!;
    const full = (await get(`/tokens/${m}`)).json() as { symbol: string; snapshots: Row[] };
    const res = await get(`/tokens/${m}?reading=1`);
    expect(res.statusCode).toBe(200);
    const reading = res.json() as {
      symbol: string;
      snapshots: Row[];
      verdicts: { takenAt: string; rugScreenPassed: boolean }[];
    };
    expect(reading.symbol).toBe("RDG");
    expect(full.snapshots).toHaveLength(Math.min(50, CASES[name]!.length));

    const picked = webPick(full.snapshots);
    const expected = [...new Set([full.snapshots[0]!.id, ...(picked ? [picked.id] : [])])];
    expect(reading.snapshots.map((s) => s.id)).toEqual(expected);
    // Each sent row is the full row the old answer had for it.
    for (const s of reading.snapshots) expect(s).toEqual(full.snapshots.find((f) => f.id === s.id));
    // The view, picking again over what it got, draws the same reading; its card's scan is the same.
    expect(webPick(reading.snapshots)?.id ?? null).toBe(picked?.id ?? null);
    expect(reading.snapshots[0]!.id).toBe(full.snapshots[0]!.id);
    // The safety flip reads the same history.
    expect(reading.verdicts).toEqual(
      full.snapshots.map((s) => ({ takenAt: s.takenAt, rugScreenPassed: s.rugScreenPassed })),
    );
    expect(res.body).not.toContain("flaggedTrades");
    expect(res.body).not.toContain("aiTextScores");
  });

  it("picks the expected rows", async () => {
    const pickedIndex = async (name: string) => {
      const full = (await get(`/tokens/${mints[name]}`)).json() as { snapshots: Row[] };
      const reading = (await get(`/tokens/${mints[name]}?reading=1`)).json() as { snapshots: Row[] };
      const last = reading.snapshots[reading.snapshots.length - 1]!;
      return webPick(reading.snapshots) ? full.snapshots.findIndex((s) => s.id === last.id) : null;
    };
    expect(await pickedIndex("newestChecked")).toBe(0);
    expect(await pickedIndex("earlierChecked")).toBe(2);
    expect(await pickedIndex("listOnly")).toBe(2);
    expect(await pickedIndex("linkedOnly")).toBe(2);
    expect(await pickedIndex("none")).toBeNull();
    expect(await pickedIndex("deep")).toBe(49);
    expect(await pickedIndex("pastFifty")).toBe(10);
  });

  it("answers a mint not on Token with a 404", async () => {
    const admin = `${TAG}-admin`;
    const env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: admin };
    const adminUser = await prisma.user.create({ data: { walletAddress: admin } });
    const adminApp = await buildServer(env);
    try {
      const adminCookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
        userId: adminUser.id,
        walletAddress: admin,
      });
      const res = await adminApp.inject({
        method: "GET",
        url: `/tokens/${mint(`${TAG}-missing`)}?reading=1`,
        cookies: { [SESSION_COOKIE_NAME]: adminCookie },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await adminApp.close();
      await prisma.user.delete({ where: { id: adminUser.id } });
    }
  });
});
