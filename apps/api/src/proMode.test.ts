// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { cachedProStatus, forgetProStatus, PRO_STATUS_STALE_MS, PRO_STATUS_TTL_MS } from "./proMode.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const WALLET = bs58.encode(
  generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32),
);

describe.skipIf(!dbAvailable)("cachedProStatus", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), PRO_TRADING_ENABLED: true, PRO_TRADING_PUBLIC: true }
    : (undefined as never);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (dbAvailable) await prisma.proModeGrant.deleteMany({ where: { walletAddress: WALLET } });
  });

  it("forgets a wallet whose grant changed", async () => {
    await prisma.proModeGrant.upsert({
      where: { walletAddress: WALLET },
      update: {},
      create: { walletAddress: WALLET, grantedBy: "test" },
    });
    forgetProStatus(WALLET);
    expect((await cachedProStatus(env, WALLET)).pro).toBe(true);
    await prisma.proModeGrant.delete({ where: { walletAddress: WALLET } });
    expect((await cachedProStatus(env, WALLET)).pro).toBe(true);
    forgetProStatus(WALLET);
    expect((await cachedProStatus(env, WALLET)).pro).toBe(false);
  });

  it("keeps a wallet's Pro Mode a minute, and through a database blip a while longer", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect((await cachedProStatus(env, WALLET)).pro).toBe(false);
    // Not Pro isn't kept: a grant counts at once.
    await prisma.proModeGrant.create({ data: { walletAddress: WALLET, grantedBy: "test" } });
    expect(await cachedProStatus(env, WALLET)).toMatchObject({ pro: true, source: "grant" });
    // Within the minute, no read at all. (Last in the file: a restored Prisma spy leaves no method.)
    const read = vi.spyOn(prisma.proModeGrant, "findUnique");
    now += PRO_STATUS_TTL_MS - 1_000;
    expect((await cachedProStatus(env, WALLET)).pro).toBe(true);
    expect(read).not.toHaveBeenCalled();
    // Past it, the database is down: the last answer stands, until it's too old to trust.
    read.mockRejectedValue(new Error("too many clients"));
    now += 2_000;
    expect((await cachedProStatus(env, WALLET)).pro).toBe(true);
    now += PRO_STATUS_STALE_MS;
    await expect(cachedProStatus(env, WALLET)).rejects.toThrow("too many clients");
    // The switches are never cached.
    expect((await cachedProStatus({ ...env, PRO_TRADING_ENABLED: false }, WALLET)).pro).toBe(false);
    expect((await cachedProStatus({ ...env, PRO_TRADING_PUBLIC: false }, WALLET)).pro).toBe(false);
  });
});
