// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, prisma } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { readKolRows } from "../kolRoster.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const tag = Date.now()
  .toString(36)
  .replace(/[0lIO]/g, "x");
const HANDLE = `pic${tag}`;
const WALLET = `Kp1${tag}`.padEnd(40, "z");

describe.skipIf(!dbAvailable)("GET /kol-avatars/:handle", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(loadEnv());
    await prisma.kolAvatar.createMany({
      data: [
        {
          handle: HANDLE,
          status: "ok",
          image: Buffer.from([0xff, 0xd8, 0xff]),
          contentType: "image/jpeg",
          hash: "abc123abc123",
          fetchedAt: new Date(),
        },
        { handle: `none${tag}`, status: "none", fetchedAt: new Date() },
      ],
    });
    await prisma.kolWallet.create({
      data: { wallet: WALLET, name: "Pic", twitter: `@${HANDLE.toUpperCase()}`, seenAt: new Date() },
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.kolAvatar.deleteMany({ where: { handle: { in: [HANDLE, `none${tag}`] } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: WALLET } });
    await app?.close();
  });

  it("serves a stored picture to anyone, cacheable and loadable from the dashboard's origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/kol-avatars/${HANDLE.toUpperCase()}?v=abc123abc123`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("is a 404 for a handle with no picture, none stored, or one that isn't a handle", async () => {
    for (const h of [`none${tag}`, `missing${tag}`, "not-a-handle!"])
      expect((await app.inject({ method: "GET", url: `/kol-avatars/${h}` })).statusCode).toBe(404);
  });

  it("puts the picture's versioned path on the roster row", async () => {
    const rows = await readKolRows([WALLET]);
    expect(rows.get(WALLET)?.avatar).toBe(`/kol-avatars/${HANDLE}?v=abc123abc123`);
  });
});
