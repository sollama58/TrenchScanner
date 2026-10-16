// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import {
  csvCell,
  csvColumns,
  exportChunks,
  exportQuerySchema,
  narrativeText,
  startExportStream,
} from "./statsExport.js";

const TOKEN = "stats-test-token-0123456789abcdef0123456789";

describe("export query", () => {
  it("parses sample kinds and rejects unknown ones", () => {
    const q = exportQuerySchema.parse({ dataset: "outcomes", sampleKind: "event, emission" });
    expect(q.sampleKind).toEqual(["event", "emission"]);
    expect(q.format).toBe("jsonl");
    expect(exportQuerySchema.safeParse({ dataset: "outcomes", sampleKind: "bogus" }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ dataset: "tokens" }).success).toBe(false);
    expect(exportQuerySchema.parse({ dataset: "wallets" }).dataset).toBe("wallets");
    expect(exportQuerySchema.parse({ dataset: "wallet-activity" }).dataset).toBe("wallet-activity");
  });

  it("pulls the narrative's names out of a stored TokenSage analysis", () => {
    const t = narrativeText({
      referent: { label: "Peanut (squirrel)", desc: "pet squirrel seized by NY officials" },
      lineage: { of_name: "Peanut", of_ticker: "PNUT" },
      copy_of: [{ name: "Peanut the Squirrel", ticker: "PNUT", mint: "abc", recent: true, signals: ["x"] }],
      x: { text: "gm" },
    });
    expect(t).toEqual({
      referentDesc: "pet squirrel seized by NY officials",
      lineageOfName: "Peanut",
      lineageOfTicker: "PNUT",
      copyOf: [{ name: "Peanut the Squirrel", ticker: "PNUT", mint: "abc", recent: true }],
      tickerExplanation: null,
      xText: "gm",
      xPostedAt: null,
      xLikes: null,
      xReposts: null,
      xReplies: null,
      xQuotes: null,
      xViews: null,
      xEngagementAsOf: null,
      xQuotedViews: null,
      xMediaCount: null,
      referentPostId: null,
      lineageSameTicker: null,
      timedOut: [],
      trendTerms: [],
    });
    expect(narrativeText(null).copyOf).toEqual([]);
    expect(exportQuerySchema.parse({ dataset: "narratives" }).dataset).toBe("narratives");
    expect(csvColumns("narratives")).toContain("referentLabel");
  });

  it("pulls the trending terms the full read matched, per source", () => {
    const t = narrativeText({
      trend: {
        matched: true,
        terms: [
          { term: "Plague (disease)", source: "wikipedia", spike: 4.2, score: 0.43, matched_on: "name" },
          {
            term: "plague",
            source: "x_trends",
            rank: 7,
            hours: 5,
            score: 0.5,
            partial: false,
            extra: "x",
            days_listed: 2,
            direction: "rising",
            novelty: 0.41,
          },
        ],
      },
    });
    expect(t.trendTerms).toEqual([
      {
        term: "Plague (disease)",
        source: "wikipedia",
        score: 0.43,
        spike: 4.2,
        rank: null,
        hours: null,
        searches: null,
        posts: null,
        matchedOn: "name",
        partial: null,
        seenAt: null,
        daysListed: null,
        direction: null,
        novelty: null,
      },
      {
        term: "plague",
        source: "x_trends",
        score: 0.5,
        spike: null,
        rank: 7,
        hours: 5,
        searches: null,
        posts: null,
        matchedOn: null,
        partial: false,
        seenAt: null,
        daysListed: 2,
        direction: "rising",
        novelty: 0.41,
      },
    ]);
  });

  it("pulls the X post's engagement and the newer read fields (TokenSage rules 0.30.0+)", () => {
    const t = narrativeText({
      referent: { label: "Woods the Tiger", post_id: "1977" },
      lineage: { same_ticker: 3 },
      timed_out: ["x_media", 7],
      x: {
        created_at: "2026-10-12T03:00:00Z",
        engagement: {
          likes: 120,
          reposts: 14,
          replies: 9,
          quotes: null,
          views: 40000,
          as_of: "2026-10-12T03:20:00Z",
        },
        quoted: { engagement: { views: 900 } },
        media: [{ kind: "photo" }],
      },
    });
    expect(t).toMatchObject({
      xPostedAt: "2026-10-12T03:00:00Z",
      xLikes: 120,
      xReposts: 14,
      xReplies: 9,
      xQuotes: null,
      xViews: 40000,
      xEngagementAsOf: "2026-10-12T03:20:00Z",
      xQuotedViews: 900,
      xMediaCount: 1,
      referentPostId: "1977",
      lineageSameTicker: 3,
      timedOut: ["x_media"],
    });
  });

  it("quotes CSV cells only when it has to", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(["x", "y"])).toBe("x|y");
    expect(csvCell(new Date("2001-01-01T00:00:00Z"))).toBe("2001-01-01T00:00:00.000Z");
  });

  it("stops a cell from opening as a spreadsheet formula, but leaves numbers signed", () => {
    expect(csvCell("=HYPERLINK(x)")).toBe("'=HYPERLINK(x)");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("-SYM")).toBe("'-SYM");
    expect(csvCell("@at")).toBe("'@at");
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(["=a", "b"])).toBe("=a|b");
  });

  it("caps the window whichever way it is spelled", () => {
    expect(exportQuerySchema.safeParse({ dataset: "outcomes", since: "1970-01-01" }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ dataset: "outcomes", days: "181" }).success).toBe(false);
    const since = new Date(Date.now() - 100 * 86_400_000).toISOString();
    expect(exportQuerySchema.safeParse({ dataset: "outcomes", since }).success).toBe(true);
  });

  it("frees an export slot when the client stops reading", async () => {
    // Endless incompressible output, so the pipeline fills and then waits on the reader.
    async function* endless() {
      for (;;) yield randomBytes(4096).toString("hex");
    }
    const start = (idleMs?: number) => startExportStream(endless(), "test", idleMs);
    // Never read: the gzip output sits in the pipeline until the watchdog ends it.
    const stalled = start(200)!;
    expect(stalled).not.toBeNull();
    const ended = new Promise<void>((resolve) => stalled.on("close", () => resolve()));
    const second = start()!;
    expect(start()).toBeNull();
    await ended;
    // Only the pipeline callback frees the slot, and it runs after the stream closes.
    await new Promise((r) => setTimeout(r, 50));
    const third = start(200);
    expect(third).not.toBeNull();
    for (const s of [second, third!]) (s as unknown as { destroy(): void }).destroy();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("GET /stats/export gating", () => {
  it("is behind the stats token", async () => {
    const off = await buildServer({ ...loadEnv(), STATS_API_TOKEN: "" });
    const on = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    try {
      expect((await off.inject({ method: "GET", url: "/stats/export?dataset=outcomes" })).statusCode).toBe(
        404,
      );
      expect((await on.inject({ method: "GET", url: "/stats/export?dataset=outcomes" })).statusCode).toBe(
        401,
      );
      const bad = await on.inject({
        method: "GET",
        url: "/stats/export?dataset=nope",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await Promise.all([off.close(), on.close()]);
    }
  });
});

/** CI provisions Postgres; this skips rather than fails on a machine without a database. */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

// A window nothing else in the database can fall into, so the export is exactly the fixture.
const BASE = new Date("2001-03-04T00:00:00Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);
const WINDOW = `since=${at(-1).toISOString()}&until=${at(600).toISOString()}`;

describe.skipIf(!dbAvailable)("GET /stats/export", () => {
  let app: FastifyInstance;
  let tokenId: string;
  let userId: string;
  const chatIds: string[] = [];
  let alertId: string;
  const outcomeIds: string[] = [];

  async function get(query: string) {
    const res = await app.inject({
      method: "GET",
      url: `/stats/export?${query}&${WINDOW}`,
      headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip" },
    });
    return { res, text: res.statusCode === 200 ? gunzipSync(res.rawPayload).toString("utf8") : "" };
  }

  beforeAll(async () => {
    app = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    const token = await prisma.token.create({
      data: {
        mintAddress: `export-test-${Date.now()}`,
        symbol: "EXP",
        firstSeenAt: BASE,
        // The screen rejected it at minute 2; the hour after peaked at minute 20.
        screenRejectedAt: at(2),
        screenRejectedPriceUsd: 1,
        screenRejectedMcapUsd: 50_000,
        rejectPeak60mPriceUsd: 3,
        rejectPeak60mMcapUsd: 150_000,
        rejectPeak60mAt: at(20),
        rejectLow60mPriceUsd: 0.5,
        rejectLow60mMcapUsd: 25_000,
      },
    });
    tokenId = token.id;
    // Three rows sharing one anchor time, so paging has to break ties on id; one more an hour on.
    for (const [minute, kind, won] of [
      [0, "event", true],
      [0, "event", false],
      [0, "hourly", null],
      [60, "emission", false],
    ] as const) {
      const row = await prisma.candidateOutcome.create({
        data: {
          tokenId,
          anchorAt: at(minute),
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          sampleKind: kind,
          features: { mcapUsd: 50_000, buyRatio24h: 0.6 },
          nextCheckAt: at(minute + 1),
          peak1hPriceUsd: won ? 2.5 : 1.2,
          low1hPriceUsd: 0.8,
          lowBefore2xPriceUsd: 0.8,
          peak24hPriceUsd: 3,
          ...(won !== null && { finalizedAt: at(minute + 60), hit2xIn1h: won, hit4xIn1h: false }),
        },
      });
      outcomeIds.push(row.id);
    }
    for (const [minute, price] of [
      [-5, 0.9], // before the path window
      [0, 1],
      [1, 1.4],
      [30, 2.5],
      [150, 4], // past the default 120 minutes
    ] as const) {
      await prisma.tokenSnapshot.create({
        data: { tokenId, takenAt: at(minute), priceUsd: price, marketCapUsd: price * 50_000 },
      });
    }
    alertId = (
      await prisma.curatedAlert.create({
        data: {
          tokenId,
          candidateOutcomeId: outcomeIds[0],
          createdAt: at(0),
          source: "heuristic-v1",
          model: "rules",
          modelName: "Rules",
          confidence: 70,
          reasons: ["volume, rising", 'said "hi"'],
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          narrativeVerdict: "warns",
          narrativeNotedAt: at(1),
        },
      })
    ).id;
    for (const [slot, models] of [
      [0, ["rules", "trees"]],
      [360, ["blend"]],
    ] as const) {
      await prisma.topModelsPick.create({
        data: { slotStart: at(slot), models: [...models], pickedAt: at(slot + 1) },
      });
    }
    // Three chats sent the token: two a minute after the call (a tie on sentAt), and one long after,
    // which no time window explains but whose send stored the call it carried.
    userId = (await prisma.user.create({ data: { walletAddress: `export-test-wallet-${Date.now()}` } })).id;
    const telegramIdBase = 9_000_000_000_000 + Date.now();
    for (const [i, minute] of [
      [0, 1],
      [1, 1],
      [2, 100],
    ] as const) {
      const chat = await prisma.telegramChat.create({
        data: {
          chatId: BigInt(telegramIdBase + i),
          kind: "private",
          title: "Someone Personal",
          userId,
          linkedByTelegramId: BigInt(telegramIdBase + i),
          linkedByName: "someone",
        },
      });
      chatIds.push(chat.id);
      await prisma.telegramAlertSent.create({
        data: { chatId: chat.id, tokenId, sentAt: at(minute), curatedAlertId: i === 2 ? alertId : null },
      });
    }
  });

  afterAll(async () => {
    // Chats and their sent rows cascade with the user.
    await prisma.user.delete({ where: { id: userId } });
    await prisma.topModelsPick.deleteMany({ where: { slotStart: { gte: at(-1), lt: at(600) } } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.tokenSnapshot.deleteMany({ where: { tokenId } });
    await prisma.candidateOutcome.deleteMany({ where: { tokenId } });
    await prisma.token.delete({ where: { id: tokenId } });
    await app.close();
  });

  it("streams outcome rows as gzipped JSONL, filtered by kind and grading", async () => {
    const { res, text } = await get("dataset=outcomes");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
    const rows = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ symbol: "EXP", features: { mcapUsd: 50_000 } });
    expect(rows[0]).not.toHaveProperty("nextCheckAt");

    const events = (await get("dataset=outcomes&sampleKind=event,emission&finalizedOnly=true")).text
      .trim()
      .split("\n");
    expect(events).toHaveLength(3);
  });

  it("pages across tied anchor times without skipping or repeating a row", async () => {
    const q = exportQuerySchema.parse({ dataset: "outcomes", format: "jsonl" });
    let text = "";
    for await (const chunk of exportChunks(q, at(-1), at(600), 1)) text += chunk;
    const ids = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id as string);
    expect(ids.sort()).toEqual([...outcomeIds].sort());
  });

  it("flattens features into CSV columns", async () => {
    const { text } = await get("dataset=outcomes&format=csv&limit=1");
    const [header, row, extra] = text.split("\n");
    const cols = header!.split(",");
    expect(cols).toContain("f_mcapUsd");
    // How long the scanner had been up when the row was banked (null on these fixture rows).
    expect(cols).toContain("bootAgeSeconds");
    expect(row!.split(",")[cols.indexOf("f_buyRatio24h")]).toBe("0.6");
    expect(extra).toBe("");
  });

  it("returns each row's snapshot price path, inside the window only", async () => {
    const { text } = await get("dataset=paths&sampleKind=event");
    const paths = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(paths).toHaveLength(2);
    expect(paths[0].ticks.map((t: unknown[]) => t.slice(0, 2))).toEqual([
      [0, 1],
      [60, 1.4],
      [1800, 2.5],
    ]);

    const csv = (await get("dataset=paths&sampleKind=emission&format=csv")).text.trim().split("\n");
    // Header + the one snapshot within 120 minutes of the 60-minute anchor (150 min).
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(",5400,4,");
  });

  it("returns each token's safety-screen verdicts and prices from first sight", async () => {
    const { text } = await get("dataset=screen");
    const rows = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenId, symbol: "EXP" });
    // Past the default 120 minutes is left out; the fixture snapshots never passed the screen.
    expect(rows[0].ticks.map((t: unknown[]) => t.slice(0, 4))).toEqual([
      [-300, 0.9, 45_000, false],
      [0, 1, 50_000, false],
      [60, 1.4, 70_000, false],
      [1800, 2.5, 125_000, false],
    ]);
    // Nothing the screen reads changed between snapshots: one check entry.
    expect(rows[0].checks).toHaveLength(1);
    // The rejected coin's hour after its first rejection rides on the token's record.
    expect(rows[0]).toMatchObject({
      screenRejectedAt: at(2).toISOString(),
      screenRejectedPriceUsd: 1,
      rejectPeak60mPriceUsd: 3,
      rejectPeak60mMcapUsd: 150_000,
      rejectPeak60mAt: at(20).toISOString(),
      rejectLow60mPriceUsd: 0.5,
      rejectLow60mMcapUsd: 25_000,
    });

    const csv = (await get("dataset=screen&format=csv&pathMinutes=360")).text.trim().split("\n");
    expect(csv).toHaveLength(6);
    expect(csv[0]).toContain("tSec,priceUsd,marketCapUsd,passed");
    expect(csv[5]).toContain(",9000,4,200000,false,scan,");
    const cols = csv[0]!.split(",");
    expect(csv[1]!.split(",")[cols.indexOf("rejectPeak60mPriceUsd")]).toBe("3");
    expect(csv[1]!.split(",")[cols.indexOf("screenRejectedAt")]).toBe(at(2).toISOString());
  });

  it("exports curated alerts with the token and quoted reasons", async () => {
    const { text } = await get("dataset=alerts&format=csv");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"volume, rising|said ""hi"""');
    const json = JSON.parse((await get("dataset=alerts")).text);
    expect(json).toMatchObject({ symbol: "EXP", candidateOutcomeId: outcomeIds[0] });
    // The Narrative seat's note rides along, so it can be graded against the card's outcome.
    expect(json).toMatchObject({ narrativeVerdict: "warns", narrativeNotedAt: at(1).toISOString() });
    expect(lines[0]).toMatch(
      /,narrativeVerdict,narrativeNotedAt,peakMcapUsd,peakMcapAt,peakCheckedAt,coinAthMcapUsd,coinAthAt$/,
    );
    expect(lines[1]).toMatch(new RegExp(`,warns,${at(1).toISOString()},,,,,$`));
    // The call's ATH, and the coin's since its first alert, ride along for the runner record.
    expect(json).toMatchObject({
      peakMcapUsd: null,
      peakCheckedAt: null,
      coinAthMcapUsd: null,
      coinAthAt: null,
    });
  });

  it("exports the stored Top Models pick per slot", async () => {
    const rows = (await get("dataset=top-models")).text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { slotStart: at(0).toISOString(), models: ["rules", "trees"], pickedAt: at(1).toISOString() },
      { slotStart: at(360).toISOString(), models: ["blend"], pickedAt: at(361).toISOString() },
    ]);
    const csv = (await get("dataset=top-models&format=csv")).text.trim().split("\n");
    expect(csv).toEqual([
      "slotStart,models,pickedAt",
      `${at(0).toISOString()},rules|trees,${at(1).toISOString()}`,
      `${at(360).toISOString()},blend,${at(361).toISOString()}`,
    ]);
  });

  it("exports what Telegram sent with the alert behind it, by token and chat row id only", async () => {
    const rows = (await get("dataset=telegram-sent")).text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // Nothing about the person: no Telegram ids, names, titles or user.
      expect(Object.keys(r).sort()).toEqual([...csvColumns("telegram-sent")].sort());
      expect(chatIds).toContain(r.chatId);
    }
    const byChat = new Map(rows.map((r) => [r.chatId, r]));
    expect(byChat.get(chatIds[0]!)).toMatchObject({
      sentAt: at(1).toISOString(),
      chatKind: "private",
      tokenId,
      symbol: "EXP",
      alertKind: "model",
      curatedAlertId: alertId,
      model: "rules",
      modelName: "Rules",
      matchId: null,
    });
    // The stored id wins over the time window.
    expect(byChat.get(chatIds[2]!)).toMatchObject({
      alertKind: "model",
      curatedAlertId: alertId,
      model: "rules",
    });
    expect(JSON.stringify(rows)).not.toContain("Someone Personal");

    // Tied sends page on the chat id without skipping or repeating one.
    const q = exportQuerySchema.parse({ dataset: "telegram-sent", format: "jsonl" });
    let text = "";
    for await (const chunk of exportChunks(q, at(-1), at(600), 1)) text += chunk;
    const paged = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).chatId as string);
    expect(paged.sort()).toEqual([...chatIds].sort());
  });
});
