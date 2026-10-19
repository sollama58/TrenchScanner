import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db.js";
import type { ContestantSpec } from "../curation/contestants.js";
import type { AlertCard } from "../telegram/format.js";
import {
  describeCard,
  isPushEndpoint,
  MAX_NOTIFICATIONS,
  pushPayloads,
  pushPrefs,
  runWebPushDispatch,
  type PushPayload,
  type PushTarget,
  type SendResult,
} from "./dispatch.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `webpush-test-${Date.now()}`;

const card = (over: Partial<AlertCard> = {}): AlertCard => ({
  token: { mintAddress: "Mint111", symbol: "TST", name: "Test", firstSeenAt: new Date(), imageUrl: null },
  snapshot: { marketCapUsd: 52_300, holderCount: null, volume1hUsd: null },
  filters: [],
  calls: [],
  raisedAt: new Date(),
  ...over,
});
const call = (modelName: string) => ({
  modelName,
  confidence: 80,
  tier: null,
  calibratedPct: null,
  reasons: [],
  narrativeVerdict: null,
});

describe("pushPrefs", () => {
  it("is off until browser notifications are on, and takes both kinds by default", () => {
    expect(pushPrefs(null)).toEqual({ on: false, filterMatches: true, modelCalls: true });
    expect(pushPrefs({ browserNotifications: true, notifyOn: { modelCalls: false } })).toEqual({
      on: true,
      filterMatches: true,
      modelCalls: false,
    });
  });
});

describe("isPushEndpoint", () => {
  it("takes the push services' https URLs and nothing internal", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isPushEndpoint("https://localhost/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("https://[::1]/x")).toBe(false);
    expect(isPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});

describe("describeCard", () => {
  it("words a call and a filter match like the open dashboard", () => {
    expect(describeCard(card({ calls: [call("Rules")] }))).toEqual({
      title: "$TST: Rules alert",
      body: "Rules alerted on $TST at $52.3K mcap.",
    });
    expect(describeCard(card({ filters: [{ name: "Mine", score: 70 }] }))).toEqual({
      title: "$TST: filter match",
      body: '"Mine" caught $TST at $52.3K mcap.',
    });
    expect(describeCard(card({ calls: [call("Rules")], filters: [{ name: "Mine", score: 70 }] })).body).toBe(
      'Rules alerted on $TST at $52.3K mcap. "Mine" caught it too.',
    );
  });
});

describe("pushPayloads", () => {
  it("sends one per alert, tagged by coin, and a summary past the limit", () => {
    const one = pushPayloads([card({ calls: [call("Rules")] })], "https://trenchscanner.app/");
    expect(one).toEqual([
      expect.objectContaining({
        tag: "ts-alert-Mint111",
        url: "https://trenchscanner.app/",
        title: "$TST: Rules alert",
      }),
    ]);
    const many = pushPayloads(
      Array.from({ length: MAX_NOTIFICATIONS + 1 }, () => card({ calls: [call("Rules")] })),
      "/",
    );
    expect(many).toHaveLength(1);
    expect(many[0]!.title).toBe(`${MAX_NOTIFICATIONS + 1} new alerts`);
  });

  it("only uses https artwork", () => {
    const http = card({ token: { ...card().token, imageUrl: "http://x/y.png" } });
    const https = card({ token: { ...card().token, imageUrl: "https://x/y.png" } });
    expect(pushPayloads([http], "/")[0]!.icon).toBeUndefined();
    expect(pushPayloads([https], "/")[0]!.icon).toBe("https://x/y.png");
  });
});

const spec = (id: string): ContestantSpec =>
  ({ id, name: id, description: "", role: "rules" }) as ContestantSpec;
const state = {
  roster: [spec("rules"), spec("trees")],
  defaultModel: "rules",
  defaultModels: ["rules"],
  bestModel: null,
};
const env = { ...loadEnv(), TELEGRAM_DASHBOARD_URL: "https://trenchscanner.app" };

describe.skipIf(!dbAvailable)("runWebPushDispatch", () => {
  let userId = "";
  let filterId = "";
  let tokenId = "";
  let snapshotId = "";
  const endpoint = `https://fcm.googleapis.com/fcm/send/${TAG}`;

  beforeAll(async () => {
    userId = (
      await prisma.user.create({
        data: {
          walletAddress: `${TAG}-wallet`,
          followBestModel: true,
          alertPrefs: { browserNotifications: true },
        },
      })
    ).id;
    filterId = (await prisma.userFilter.create({ data: { userId, name: "Mine", mcapMin: 1, mcapMax: 1e9 } }))
      .id;
    tokenId = (await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "TST" } })).id;
    snapshotId = (
      await prisma.tokenSnapshot.create({
        data: { tokenId, priceUsd: 0.001, marketCapUsd: 50_000, score: 60 },
      })
    ).id;
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });
  beforeEach(async () => {
    await prisma.webPushSubscription.deleteMany({ where: { userId } });
    await prisma.webPushSubscription.create({
      data: { userId, endpoint, p256dh: "k", auth: "a", sentThrough: new Date(Date.now() - 60_000) },
    });
  });

  const run = (results: SendResult[] = [], hasAccess = true) => {
    const sent: { target: PushTarget; payload: PushPayload }[] = [];
    const summary = runWebPushDispatch(env, {
      send: async (target, payload) => {
        if (target.endpoint === endpoint) sent.push({ target, payload });
        return results.shift() ?? { ok: true };
      },
      hasAccess: async () => hasAccess,
      oldestOpenTransaction: async () => null,
      feedModelState: async () => state,
    });
    return summary.then((s) => ({ summary: s, sent }));
  };

  it("pushes a filter match and a followed model's call as one notification, once", async () => {
    const at = new Date(Date.now() - 30_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    await prisma.curatedAlert.createMany({
      data: [
        {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(at.getTime() + 1_000),
        },
        // Not in this user's feed.
        {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "trees",
          modelName: "Trees",
          createdAt: new Date(at.getTime() + 2_000),
        },
      ],
    });
    const first = await run();
    expect(first.sent.map((s) => s.payload.title)).toEqual(["$TST: Rules alert"]);
    expect(first.sent[0]!.payload.url).toBe("https://trenchscanner.app/");
    const row = await prisma.webPushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.lastSentAt).not.toBeNull();
    expect(row.sentTokens).toHaveProperty(tokenId);

    // The cursor moved: nothing again.
    expect((await run()).sent).toHaveLength(0);
  });

  it("sends nothing while browser notifications are off, or without access", async () => {
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: new Date(Date.now() - 20_000), score: 71 },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { alertPrefs: { browserNotifications: false } },
    });
    expect((await run()).sent).toHaveLength(0);
    await prisma.user.update({ where: { id: userId }, data: { alertPrefs: { browserNotifications: true } } });
    await prisma.webPushSubscription.update({
      where: { endpoint },
      data: { sentThrough: new Date(Date.now() - 60_000), sentTokens: {} },
    });
    expect((await run([], false)).sent).toHaveLength(0);
  });

  it("drops a subscription the push service says is gone", async () => {
    const token2 = await prisma.token.create({ data: { mintAddress: `${TAG}-gone`, symbol: "GONE" } });
    await prisma.match.create({
      data: {
        userId,
        filterId,
        tokenId: token2.id,
        snapshotId,
        matchedAt: new Date(Date.now() - 10_000),
        score: 71,
      },
    });
    const { summary, sent } = await run([{ ok: false, gone: true, error: "HTTP 410" }]);
    expect(sent).toHaveLength(1);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.webPushSubscription.count({ where: { endpoint } })).toBe(0);
  });
});
