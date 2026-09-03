// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma, type ScoredToken } from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import { createMatchesForCandidate, ALERT_COOLDOWN_HOURS, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import type { AlertBot } from "../telegram/bot.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `match-dispatch-test-${Date.now()}`;

function scoredFixture(mintAddress: string): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    ageMinutes: 90,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 80 },
  };
}

/** Records the order calls landed in - the ordering IS the behaviour under test. */
function recordingBot(order: string[], opts: { delayMs?: number; fail?: boolean } = {}): AlertBot {
  return {
    enabled: true,
    async sendMessage(chatId: string) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      order.push(`telegram:${chatId}`);
      return !opts.fail;
    },
    start() {},
    async stop() {},
  };
}

async function seedUserWithFilter(suffix: string, chatId?: string): Promise<FilterWithUser> {
  const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${suffix}` } });
  if (chatId) {
    await prisma.telegramLink.create({
      data: { userId: user.id, chatId, alertMode: "REALTIME", linkedAt: new Date() },
    });
  }
  const filter = await prisma.userFilter.create({
    data: { userId: user.id, name: suffix, mcapMin: 1_000, mcapMax: 10_000_000, isActive: true },
  });
  const link = chatId ? await prisma.telegramLink.findUnique({ where: { userId: user.id } }) : null;
  return { ...filter, user: { id: user.id, telegramLink: link } } as FilterWithUser;
}

async function seedToken(suffix: string): Promise<{ token: Token; snapshot: TokenSnapshot }> {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scoredFixture(token.mintAddress), "scan"),
  });
  return { token, snapshot };
}

describe.skipIf(!dbAvailable)("createMatchesForCandidate", () => {
  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("creates every match and pushes the dashboard BEFORE any Telegram send", async () => {
    // The latency fix this exists for: a Telegram round trip used to sit between one user's match
    // and the next user's, so the last dashboard waited out every send before it.
    const { token, snapshot } = await seedToken("order");
    const filters = [
      await seedUserWithFilter("a", "chat-a"),
      await seedUserWithFilter("b", "chat-b"),
      await seedUserWithFilter("c", "chat-c"),
    ];
    const order: string[] = [];
    const bot = recordingBot(order, { delayMs: 20 });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
      bot,
    });

    expect(count).toBe(3);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(3);
    // Every Telegram send happened; none of them gated the match rows, which already existed.
    expect(order.filter((o) => o.startsWith("telegram:")).length).toBe(3);
  });

  it("records Telegram delivery after the fact, and only for sends that worked", async () => {
    const { token, snapshot } = await seedToken("delivery");
    const filters = [await seedUserWithFilter("d", "chat-d")];

    await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
      bot: recordingBot([], { fail: true }),
    });
    const failed = await prisma.match.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(failed.deliveredTelegram).toBe(false);
    expect(failed.deliveredDashboard).toBe(true);

    await prisma.match.deleteMany({ where: { tokenId: token.id } });
    await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
      bot: recordingBot([]),
    });
    const delivered = await prisma.match.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(delivered.deliveredTelegram).toBe(true);
  });

  it("leaves a user alone for a token their filter already alerted on", async () => {
    const { token, snapshot } = await seedToken("cooldown");
    const filters = [await seedUserWithFilter("e")];
    const args = {
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
      bot: recordingBot([]),
    };

    expect(await createMatchesForCandidate(args)).toBe(1);
    expect(await createMatchesForCandidate(args)).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(1);

    // Aged past the cooldown, the same token is a genuinely new call again.
    await prisma.match.updateMany({
      where: { tokenId: token.id },
      data: { matchedAt: new Date(Date.now() - (ALERT_COOLDOWN_HOURS + 1) * 3_600_000) },
    });
    expect(await createMatchesForCandidate(args)).toBe(1);
  });

  it("cools down per filter, so one user's two matching filters both alert", async () => {
    const { token, snapshot } = await seedToken("two-filters");
    const first = await seedUserWithFilter("f");
    const second = await prisma.userFilter.create({
      data: { userId: first.userId, name: "second", mcapMin: 1_000, mcapMax: 10_000_000, isActive: true },
    });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [first, { ...second, user: first.user } as FilterWithUser],
      bot: recordingBot([]),
    });
    expect(count).toBe(2);
  });

  it("does nothing at all when the token matches nobody", async () => {
    const { token, snapshot } = await seedToken("nomatch");
    const filter = await seedUserWithFilter("g");
    // Way outside this filter's band.
    const scored = { ...scoredFixture(token.mintAddress), marketCapUsd: 50_000_000 };

    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored,
        activeFilters: [filter],
        bot: recordingBot([]),
      }),
    ).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });
});
