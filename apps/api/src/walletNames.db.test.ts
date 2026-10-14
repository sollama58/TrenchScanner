// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, type HeliusIdentity } from "@trenchscanner/core";
import { loadWalletNames } from "./walletNames.js";
import { WalletIdentityReader } from "./walletIdentity.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `names-test-${Date.now()}`;
const SEEN = `${TAG}-seen`;
const FUNDER = `${TAG}-funder`;
const KOL = `${TAG}-kol`;
const RANDOM = `${TAG}-random`;
const SIDE = `${TAG}-side`;

describe.skipIf(!dbAvailable)("loadWalletNames", () => {
  beforeAll(async () => {
    await prisma.walletFunder.create({ data: { wallet: SEEN, status: "found", funder: FUNDER } });
    await prisma.kolWallet.create({ data: { wallet: KOL, name: "Cupsey", seenAt: new Date() } });
    await prisma.kolWallet.create({
      data: { wallet: SIDE, name: "cupseyy", mainWallet: KOL, seenAt: new Date() },
    });
  });

  afterAll(async () => {
    await prisma.walletFunder.deleteMany({ where: { wallet: SEEN } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { in: [KOL, SIDE] } } });
  });

  const reader = (perUserPerMinute = 4) => {
    const batch = vi.fn(async (wallets: readonly string[]) => ({
      status: "found" as const,
      value: new Map<string, HeliusIdentity | null>(
        wallets.map((w) => [w, { type: "wallet", name: `name of ${w}`, category: null, tags: [] }]),
      ),
    }));
    return {
      batch,
      reader: new WalletIdentityReader({ identity: vi.fn(), batchIdentity: batch }, { perUserPerMinute }),
    };
  };

  it("asks Helius only about wallets the database has seen and the KOL roster doesn't name", async () => {
    const { batch, reader: identity } = reader();
    const read = await loadWalletNames([SEEN, FUNDER, KOL, RANDOM], identity, "user-a");
    expect(batch).toHaveBeenCalledTimes(1);
    expect([...batch.mock.calls[0]![0]].sort()).toEqual([FUNDER, SEEN].sort());
    expect(read.names[KOL]).toEqual({ name: "Cupsey", source: "kol" });
    expect(read.names[SEEN]).toEqual({ name: `name of ${SEEN}`, source: "identity" });
    expect(read.names[RANDOM]).toBeUndefined();
    expect(read.unread).toEqual([]);
  });

  it("names a KOL's Known Side after the KOL's main wallet", async () => {
    const read = await loadWalletNames([KOL, SIDE], null);
    expect(read.names[KOL]).toEqual({ name: "Cupsey", source: "kol" });
    expect(read.names[SIDE]).toEqual({ name: "Cupsey Known Side", source: "kol-side" });
  });

  it("reports what one account's spent share left unread, while others still get theirs", async () => {
    const { batch, reader: identity } = reader(0);
    const read = await loadWalletNames([SEEN, RANDOM], identity, "user-b");
    expect(batch).not.toHaveBeenCalled();
    expect(read.unread).toEqual([SEEN]);
    // The same wallets without a user key (no per-account share) are read.
    const other = await loadWalletNames([SEEN], identity);
    expect(other.names[SEEN]?.name).toBe(`name of ${SEEN}`);
  });
});
