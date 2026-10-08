// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { prisma, MATCH_CHANNEL, notifyMatchesCreated } from "@trenchscanner/core";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("notifyMatchesCreated", () => {
  it("delivers one notification per match from a single statement", async () => {
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (msg) => {
      if (msg.channel === MATCH_CHANNEL && msg.payload) got.push(msg.payload);
    });
    await listener.query(`LISTEN ${MATCH_CHANNEL}`);
    try {
      const sent = Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}`, matchId: `notify-test-${i}` }));
      await notifyMatchesCreated(sent);
      await expect.poll(() => got.filter((p) => p.includes("notify-test-")).length).toBe(50);
      expect(got.filter((p) => p.includes("notify-test-")).map((p) => JSON.parse(p))).toEqual(sent);
    } finally {
      await listener.end();
    }
  });

  it("does nothing for no matches", async () => {
    await expect(notifyMatchesCreated([])).resolves.toBeUndefined();
  });
});
