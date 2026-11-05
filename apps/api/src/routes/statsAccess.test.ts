// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { parsePartnerTokens, statsAuth } from "./statsAccess.js";
import { pauseRemovedPartnerWebhooks } from "./statsWebhook.js";

const OPERATOR = "stats-access-operator-token-0123456789abcdef";
const PARTNER = "stats-access-partner-token-0123456789abcdef0";
const OTHER = "stats-access-other-partner-0123456789abcdef01";
const TAG = `sa${Date.now().toString(36)}`;
const NAME = `${TAG}-a`;
const OTHER_NAME = `${TAG}-b`;

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("parsePartnerTokens", () => {
  it("reads name:token pairs and skips bad ones", () => {
    const got = parsePartnerTokens(
      [
        `alice:${PARTNER}`,
        ` bob : ${OTHER} `,
        "short:abc",
        `:${"x".repeat(40)}`,
        `op:${OPERATOR}`,
        `alice:${"y".repeat(40)}`,
        `carol:${PARTNER}`,
        `bad name:${"z".repeat(40)}`,
      ].join(",\n"),
      OPERATOR,
    );
    expect([...got.entries()]).toEqual([
      ["alice", PARTNER],
      ["bob", OTHER],
    ]);
  });

  it("tells the operator from a partner, and neither from a stranger", () => {
    const auth = statsAuth({
      ...loadEnv(),
      STATS_API_TOKEN: OPERATOR,
      STATS_PARTNER_TOKENS: `alice:${PARTNER}`,
    });
    expect(auth.identify(`Bearer ${OPERATOR}`)).toEqual({ kind: "operator" });
    expect(auth.identify(`Bearer ${PARTNER}`)).toEqual({ kind: "partner", name: "alice" });
    expect(auth.identify(`Bearer ${PARTNER}x`)).toBeNull();
    expect(auth.identify(PARTNER)).toBeNull();
    expect(auth.identify(undefined)).toBeNull();
  });
});

describe("partner access to /stats", () => {
  let app: FastifyInstance;
  const env: Env = {
    ...loadEnv(),
    STATS_API_TOKEN: OPERATOR,
    STATS_PARTNER_TOKENS: `${NAME}:${PARTNER},${OTHER_NAME}:${OTHER}`,
  };
  beforeAll(async () => {
    app = await buildServer(env);
  });
  afterAll(async () => {
    await app.close();
    if (dbAvailable) await prisma.partnerWebhook.deleteMany({ where: { partner: { startsWith: TAG } } });
  });

  it("answers a partner 404 on everything outside its reads", async () => {
    for (const url of [
      "/stats/db",
      "/stats/storage",
      "/stats/routes",
      "/stats/caches",
      "/stats/live",
      "/stats/kol-known-sides",
      "/stats/screen-funnel",
      "/stats/features",
      "/stats/candles",
      "/stats/candles/sources",
      "/stats/ops",
      "/stats/ops/errors",
      "/stats/ops/env",
      "/stats/ops/fdsa/positions",
      "/stats/ops/models/desk",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(PARTNER) });
      // /stats/ops refuses any token but the operator's, as it refuses a wrong one.
      expect(res.statusCode, url).toBe(url.startsWith("/stats/ops") ? 401 : 404);
    }
  });

  it("keeps a partner to the alerts and paths exports", async () => {
    for (const dataset of [
      "outcomes",
      "ai-reviews",
      "shadow",
      "wallets",
      "wallet-activity",
      "tape",
      "telegram-sent",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/stats/export?dataset=${dataset}&days=1`,
        headers: bearer(PARTNER),
      });
      expect(res.statusCode, dataset).toBe(404);
    }
  });

  it("lets a partner reach its reads, and nobody without a token", async () => {
    for (const url of [
      "/stats/hit-rates",
      "/stats/models",
      "/stats/export?dataset=alerts",
      "/stats/webhook",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    // A bad query is answered past the guard: the partner got through.
    const bad = await app.inject({ method: "GET", url: "/stats/models?days=99", headers: bearer(PARTNER) });
    expect(bad.statusCode).toBe(400);
    const candles = await app.inject({
      method: "GET",
      url: "/stats/candles/not-a-mint",
      headers: bearer(PARTNER),
    });
    expect(candles.statusCode).toBe(400);
  });

  it("gives the operator no webhook", async () => {
    const res = await app.inject({ method: "GET", url: "/stats/webhook", headers: bearer(OPERATOR) });
    expect(res.statusCode).toBe(404);
  });

  it.skipIf(!dbAvailable)("trims the hit-rate report for a partner", async () => {
    const res = await app.inject({ method: "GET", url: "/stats/hit-rates?days=1", headers: bearer(PARTNER) });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [
        "curatedAlerts",
        "curatorConfidenceBands",
        "minGradedForVerdict",
        "rules",
        "targets",
        "window",
        "winnerRuns",
      ].sort(),
    );
    const full = await app.inject({
      method: "GET",
      url: "/stats/hit-rates?days=1",
      headers: bearer(OPERATOR),
    });
    expect(full.json()).toHaveProperty("filterMatches");
    expect(full.json()).toHaveProperty("aiReviewer");
  });

  it.skipIf(!dbAvailable)("lets a partner set, read, test and drop its own webhook only", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/stats/webhook",
      headers: bearer(PARTNER),
      payload: { url: "https://169.254.169.254/latest/meta-data" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_url" });

    const made = await app.inject({
      method: "PUT",
      url: "/stats/webhook",
      headers: bearer(PARTNER),
      payload: { url: "https://hooks.example.com/ts" },
    });
    expect(made.statusCode).toBe(201);
    const { secret } = made.json<{ secret: string }>();
    expect(secret).toMatch(/^whsec_/);

    const read = await app.inject({ method: "GET", url: "/stats/webhook", headers: bearer(PARTNER) });
    expect(read.json()).toMatchObject({ webhook: { url: "https://hooks.example.com/ts", enabled: true } });
    expect(read.body).not.toContain(secret);
    // The other partner sees none of it.
    const theirs = await app.inject({ method: "GET", url: "/stats/webhook", headers: bearer(OTHER) });
    expect(theirs.json()).toMatchObject({ webhook: null });

    const changed = await app.inject({
      method: "PUT",
      url: "/stats/webhook",
      headers: bearer(PARTNER),
      payload: { url: "https://hooks.example.com/v2", models: ["rules"] },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).not.toContain("whsec_");

    const rotated = await app.inject({
      method: "POST",
      url: "/stats/webhook/rotate-secret",
      headers: bearer(PARTNER),
    });
    expect(rotated.json<{ secret: string }>().secret).not.toBe(secret);

    const ping = await app.inject({ method: "POST", url: "/stats/webhook/test", headers: bearer(PARTNER) });
    expect(ping.statusCode).toBe(202);
    const log = await app.inject({
      method: "GET",
      url: "/stats/webhook/deliveries",
      headers: bearer(PARTNER),
    });
    expect(log.json<{ deliveries: { event: string }[] }>().deliveries.map((d) => d.event)).toEqual(["ping"]);
    const otherLog = await app.inject({
      method: "GET",
      url: "/stats/webhook/deliveries",
      headers: bearer(OTHER),
    });
    expect(otherLog.json()).toMatchObject({ deliveries: [] });

    const dropped = await app.inject({ method: "DELETE", url: "/stats/webhook", headers: bearer(PARTNER) });
    expect(dropped.json()).toMatchObject({ deleted: true });
  });

  it.skipIf(!dbAvailable)("pauses the webhook of a partner taken out of the list", async () => {
    await prisma.partnerWebhook.create({
      data: { partner: OTHER_NAME, url: "https://hooks.example.com/b", secret: "s" },
    });
    // This suite is the only one in the api workspace that makes webhooks (each workspace tests
    // on its own database), so the sweep can't pause another suite's row.
    await pauseRemovedPartnerWebhooks({ ...env, STATS_PARTNER_TOKENS: `${NAME}:${PARTNER}` });
    expect(await prisma.partnerWebhook.findUniqueOrThrow({ where: { partner: OTHER_NAME } })).toMatchObject({
      enabled: false,
      pausedReason: "partner_removed",
    });
  });
});
