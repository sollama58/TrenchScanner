// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma, type KolEntry, type KolPage } from "@trenchscanner/core";
import { runKolWalletsJob } from "./kolWalletsJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
// Base58 addresses unique to this run.
const tag = Date.now()
  .toString(36)
  .replace(/[0lIO]/g, "x");
const w = (n: string) => `Ko1${tag}${n}`.padEnd(40, "z");

const kol = (wallet: string, name: string): KolEntry => ({
  wallet,
  name,
  twitter: name.toLowerCase(),
  realizedPnlUsd: 1_000,
  winRate: 60,
  lastTradeAt: new Date("2026-10-13T00:00:00Z"),
});

describe.skipIf(!dbAvailable)("kol-wallets job", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: `Ko1${tag}` } } });
  });

  it("reads every page into the table and drops wallets gone from the roster for a week", async () => {
    await prisma.kolWallet.create({
      data: { wallet: w("old"), name: "Gone", seenAt: new Date("2026-10-01T00:00:00Z") },
    });
    const pages: KolPage[] = [
      { kols: [kol(w("a"), "Alpha")], nextCursor: "c1" },
      { kols: [kol(w("b"), "Beta"), kol(w("a"), "Dupe")], nextCursor: null },
    ];
    const kolPage = vi.fn(async () => pages.shift()!);
    const meta = await runKolWalletsJob(
      { kolPage },
      { now: () => Date.parse("2026-10-13T12:00:00Z"), pauseMs: 0 },
    );
    expect(kolPage).toHaveBeenCalledTimes(2);
    expect(kolPage).toHaveBeenLastCalledWith("c1");
    expect(meta).toMatchObject({ pages: 2, kols: 2, complete: true });
    const rows = await prisma.kolWallet.findMany({
      where: { wallet: { startsWith: `Ko1${tag}` } },
      orderBy: { wallet: "asc" },
    });
    expect(rows.map((r) => [r.name, r.twitter])).toEqual([
      ["Alpha", "alpha"],
      ["Beta", "beta"],
    ]);
  });

  it("keeps the table when the roster comes back empty", async () => {
    const meta = await runKolWalletsJob(
      { kolPage: async () => ({ kols: [], nextCursor: null }) },
      { now: () => Date.parse("2026-11-30T00:00:00Z"), pauseMs: 0 },
    );
    expect(meta).toMatchObject({ kols: 0, removed: 0 });
    expect(await prisma.kolWallet.count({ where: { wallet: { startsWith: `Ko1${tag}` } } })).toBe(2);
  });
});
