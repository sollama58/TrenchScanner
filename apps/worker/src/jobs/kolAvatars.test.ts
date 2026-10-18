// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma, type XAvatar } from "@trenchscanner/core";
import { AVATAR_REFRESH_MS, dueHandles, refreshKolAvatars } from "./kolAvatars.js";

describe("dueHandles", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms);

  it("reads handles never read first, then the oldest, and skips any read within a week", () => {
    const stored = new Map([
      ["fresh", ago(AVATAR_REFRESH_MS - 60_000)],
      ["old", ago(AVATAR_REFRESH_MS + 60_000)],
      ["older", ago(AVATAR_REFRESH_MS * 2)],
    ]);
    expect(dueHandles(["fresh", "old", "new", "older"], stored, now)).toEqual(["new", "older", "old"]);
  });

  it("stops at the run's cap", () => {
    expect(dueHandles(["c", "a", "b"], new Map(), now, 2)).toEqual(["a", "b"]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const tag = Date.now()
  .toString(36)
  .replace(/[0lIO]/g, "x");
const w = (n: string) => `Ka1${tag}${n}`.padEnd(40, "z");

describe.skipIf(!dbAvailable)("refreshKolAvatars", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: `Ka1${tag}` } } });
    await prisma.kolAvatar.deleteMany({ where: { handle: { startsWith: `t${tag}` } } });
  });

  it("stores pictures and no-picture answers, keeps failures for next run, and drops handles gone from the roster", async () => {
    const seenAt = new Date();
    await prisma.kolWallet.createMany({
      data: [
        { wallet: w("a"), name: "A", twitter: `@T${tag}pic`, seenAt },
        { wallet: w("b"), name: "B", twitter: `t${tag}none`, seenAt },
        { wallet: w("c"), name: "C", twitter: `t${tag}fail`, seenAt },
      ],
    });
    await prisma.kolAvatar.create({ data: { handle: `t${tag}gone`, status: "none", fetchedAt: seenAt } });
    const fetchAvatar = vi.fn(async (h: string): Promise<XAvatar> => {
      if (h.endsWith("pic"))
        return {
          status: "ok",
          image: Buffer.from([1, 2, 3]),
          contentType: "image/jpeg",
          hash: "abc123abc123",
        };
      if (h.endsWith("fail")) throw new Error("429");
      return { status: "none" };
    });
    await refreshKolAvatars({ fetchAvatar, pauseMs: 0 });
    const rows = await prisma.kolAvatar.findMany({
      where: { handle: { startsWith: `t${tag}` } },
      orderBy: { handle: "asc" },
    });
    expect(rows.map((r) => [r.handle, r.status, r.hash])).toEqual([
      [`t${tag}none`, "none", null],
      [`t${tag}pic`, "ok", "abc123abc123"],
    ]);
    expect(Buffer.from(rows[1]!.image!)).toEqual(Buffer.from([1, 2, 3]));
    // Read again within the week: only the failed handle is asked about.
    fetchAvatar.mockClear();
    await refreshKolAvatars({ fetchAvatar, pauseMs: 0 });
    expect(fetchAvatar.mock.calls.map((c) => c[0]).filter((h) => h.startsWith(`t${tag}`))).toEqual([
      `t${tag}fail`,
    ]);
  });
});
