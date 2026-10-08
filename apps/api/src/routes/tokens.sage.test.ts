// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { SageView } from "../tokenSageView.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `sage-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mint = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 7)) % B58.length]).join(
    "",
  );
const READ = mint(`${TAG}-read`);
const NONE = mint(`${TAG}-none`);
const full = JSON.parse(
  readFileSync(
    new URL("../../../../packages/core/src/datasources/fixtures/tokensage/full.json", import.meta.url),
    "utf8",
  ),
) as { analysis: object };

describe.skipIf(!dbAvailable)("GET /tokens/:mint/sage", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    const token = await prisma.token.create({
      data: { mintAddress: READ, symbol: "PNUT2", name: "Peanut 2.0" },
    });
    await prisma.tokenSnapshot.createMany({
      data: [1, 2, 3].map((i) => ({
        tokenId: token.id,
        takenAt: new Date(Date.now() - (4 - i) * 60_000),
        priceUsd: i,
        marketCapUsd: 10_000 * i,
      })),
    });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: READ,
        depth: "full",
        status: "complete",
        categories: [{ label: "animal/squirrel", confidence: 0.97 }],
        analysis: full.analysis,
      },
    });
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
  });

  afterAll(async () => {
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await app?.close();
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: READ } });
    await prisma.token.deleteMany({ where: { mintAddress: READ } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (m: string, withCookie = true) =>
    app.inject({
      method: "GET",
      url: `/tokens/${m}/sage`,
      cookies: withCookie ? { [SESSION_COOKIE_NAME]: cookie } : {},
    });

  it("answers a subscriber with the read, the market cap path and no raw document", async () => {
    const res = await get(READ);
    expect(res.statusCode).toBe(200);
    const view = res.json() as SageView;
    expect(view.status).toBe("ok");
    expect(view.token).toMatchObject({ symbol: "PNUT2" });
    expect(view.read!.referent!.label).toBe("Peanut (squirrel)");
    expect(view.marketCap.map((p) => p.usd)).toEqual([10_000, 20_000, 30_000]);
    expect(res.body).not.toContain("CTfBTtxhtAyGEysdjp9owVQvjSwPjtrzEGB9ZgAKewsY");
  });

  it("says when there is no read, and turns away bad mints and visitors", async () => {
    const none = (await get(NONE)).json() as SageView;
    expect(none).toMatchObject({ status: "none", read: null, token: null, marketCap: [] });
    expect((await get("not-a-mint")).statusCode).toBe(400);
    expect((await get(READ, false)).statusCode).toBe(401);
  });
});
