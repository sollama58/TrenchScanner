// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type CandidateToken } from "@trenchscanner/core";
import {
  fillMissingSocials,
  mergeSocials,
  recordSocialLinks,
  resetSocialsFill,
  takeSocialsFillStats,
} from "./socialsFill.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `socials-fill-test-${Date.now()}`;
const jupToken = (mint: string, extra: Partial<CandidateToken> = {}): CandidateToken => ({
  mintAddress: mint,
  priceUsd: 0.0001,
  marketCapUsd: 20_000,
  ...extra,
});

describe("mergeSocials", () => {
  it("takes each link from the first source that has one", () => {
    expect(
      mergeSocials({ twitterUrl: "https://x.com/a" }, undefined, {
        twitterUrl: "https://x.com/b",
        websiteUrl: "https://b.xyz/",
      }),
    ).toEqual({ twitterUrl: "https://x.com/a", websiteUrl: "https://b.xyz/" });
    expect(mergeSocials()).toEqual({});
  });
});

describe("fillMissingSocials", () => {
  beforeEach(() => resetSocialsFill());

  it("asks Jupiter, then TokenSage, records what either had, and marks the answered coins checked", async () => {
    const getTokensByAddresses = vi.fn(
      async (_mints: string[], _c?: number, o?: { failed?: Set<string> }) => {
        o?.failed?.add("down");
        return [
          jupToken("jup", { twitterUrl: "https://x.com/jup", hasTwitter: true }),
          jupToken("none"),
          jupToken("sage"),
        ];
      },
    );
    const record = vi.fn(async (coins: readonly unknown[]) => coins.length);
    const markChecked = vi.fn(async () => undefined);
    await fillMissingSocials(
      {
        jupiter: { getTokensByAddresses },
        due: async () => ["jup", "none", "sage", "down"],
        sage: async () => [
          { mintAddress: "sage", telegramUrl: "https://t.me/sage" },
          { mintAddress: "jup", twitterUrl: "https://x.com/other", websiteUrl: "https://jup.xyz/" },
        ],
        record,
        markChecked,
      },
      Date.parse("2026-10-23T20:00:00Z"),
    );
    expect(record).toHaveBeenCalledWith([
      // Jupiter's X link wins; TokenSage fills the website Jupiter didn't list.
      { mintAddress: "jup", twitterUrl: "https://x.com/jup", websiteUrl: "https://jup.xyz/" },
      { mintAddress: "sage", telegramUrl: "https://t.me/sage" },
    ]);
    // "down" got no answer: asked again next run rather than put on the backoff.
    expect(markChecked).toHaveBeenCalledWith(["jup", "none", "sage"], new Date("2026-10-23T20:00:00Z"));
    expect(takeSocialsFillStats()).toEqual({
      asked: 4,
      fromJupiter: 1,
      fromTokenSage: 1,
      recorded: 2,
      failed: 1,
    });
  });

  it("runs at most once a minute", async () => {
    const due = vi.fn(async () => [] as string[]);
    const now = Date.parse("2026-10-23T20:00:00Z");
    await fillMissingSocials({ due, sage: async () => [] }, now);
    await fillMissingSocials({ due, sage: async () => [] }, now + 30_000);
    await fillMissingSocials({ due, sage: async () => [] }, now + 61_000);
    expect(due).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!dbAvailable)("socials on the Token table", () => {
  const mint = (s: string) => `${TAG}-${s}`;
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("fills only the links a row is missing, and never replaces one", async () => {
    await prisma.token.create({
      data: {
        mintAddress: mint("rec"),
        twitterUrl: "https://x.com/kept",
        hasTwitter: true,
        hasWebsite: null,
      },
    });
    const written = await recordSocialLinks([
      {
        mintAddress: mint("rec"),
        twitterUrl: "https://x.com/new",
        telegramUrl: "https://t.me/new",
        websiteUrl: "https://new.xyz/",
      },
      { mintAddress: mint("missing-row"), twitterUrl: "https://x.com/none" },
    ]);
    expect(written).toBe(1);
    const row = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint("rec") } });
    expect(row).toMatchObject({
      twitterUrl: "https://x.com/kept",
      telegramUrl: "https://t.me/new",
      websiteUrl: "https://new.xyz/",
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
    });
    // Nothing new: no write.
    expect(await recordSocialLinks([{ mintAddress: mint("rec"), twitterUrl: "https://x.com/new" }])).toBe(0);
  });

  it("asks about band coins with no link, on a backoff, and stamps them checked", async () => {
    resetSocialsFill();
    const now = Date.parse("2026-10-23T20:00:00Z");
    const minsAgo = (m: number) => new Date(now - m * 60_000);
    await prisma.token.createMany({
      data: [
        // In the band 2 hours ago, never asked: due.
        { mintAddress: mint("new"), firstInBandAt: minsAgo(120) },
        // Asked 20 minutes ago, 2 hours in the band (backoff 30 minutes): not due.
        { mintAddress: mint("recent"), firstInBandAt: minsAgo(120), socialsCheckedAt: minsAgo(20) },
        // Asked 40 minutes ago: due.
        { mintAddress: mint("stale"), firstInBandAt: minsAgo(120), socialsCheckedAt: minsAgo(40) },
        // Has a link: never asked.
        { mintAddress: mint("linked"), firstInBandAt: minsAgo(120), telegramUrl: "https://t.me/x" },
        // In the band three days ago: past the window.
        { mintAddress: mint("old"), firstInBandAt: minsAgo(3 * 24 * 60) },
      ],
    });
    const asked: string[] = [];
    await fillMissingSocials(
      {
        jupiter: {
          getTokensByAddresses: async (mints: string[]) => {
            asked.push(...mints.filter((m) => m.startsWith(TAG)));
            return mints
              .filter((m) => m === mint("new"))
              .map((m) => jupToken(m, { websiteUrl: "https://found.xyz/", hasWebsite: true }));
          },
        },
        sage: async () => [],
      },
      now,
    );
    expect(asked.sort()).toEqual([mint("new"), mint("stale")].sort());
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: [mint("new"), mint("stale"), mint("recent")] } },
      select: { mintAddress: true, websiteUrl: true, socialsCheckedAt: true },
      orderBy: { mintAddress: "asc" },
    });
    expect(rows).toEqual([
      { mintAddress: mint("new"), websiteUrl: "https://found.xyz/", socialsCheckedAt: new Date(now) },
      { mintAddress: mint("recent"), websiteUrl: null, socialsCheckedAt: minsAgo(20) },
      { mintAddress: mint("stale"), websiteUrl: null, socialsCheckedAt: new Date(now) },
    ]);
  });
});
