// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { isOpsRead, OPS_READS, scrubSecrets } from "./statsOps.js";

const TOKEN = "stats-ops-test-token-0123456789abcdef01234567";

describe("scrubSecrets", () => {
  it("redacts keyed URLs, userinfo and bare keys", () => {
    const out = scrubSecrets(
      JSON.stringify({
        a: "fetch failed https://mainnet.helius-rpc.com/?api-key=abcdef0123456789abcdef",
        b: "Can't reach postgresql://user:hunter2hunter2@dpg-x.render.com:5432/db",
        c: "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA used",
        d: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        e: 'password="correcthorsebatterystaple"',
      }),
    );
    for (const secret of [
      "abcdef0123456789abcdef",
      "hunter2hunter2",
      "sk-ant-api03-AAAA",
      "abcdefghijklmnopqrstuvwxyz",
      "correcthorsebatterystaple",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("redacts bot tokens, Basic values, AWS ids and env-style names, in text and in JSON", () => {
    // Made-up values only.
    const cases = {
      telegramUrl:
        "fetch failed https://api.telegram.org/bot1234567890:AAFakeFakeFakeFakeFakeFake_FAKE/sendPhoto",
      telegramBare: "bot token 1234567890:AAFakeFakeFakeFakeFakeFake_FAKE rejected",
      jupiterHeader: "x-api-key: 0f0f0f0f-aaaa-bbbb-cccc-0123456789ab",
      basic: "authorization: Basic Y21mYWtlOnNlY3JldGZha2VmYWtlZmFrZQ==",
      awsSecret: "TRADING_AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEFAKE",
      awsId: "id AKIAFAKEFAKEFAKEFAKE used",
      vapid: "WEB_PUSH_PRIVATE_KEY=UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-FAKE",
      quicknode: "https://cool-name.solana-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/",
    };
    const secrets = [
      "AAFakeFakeFakeFakeFakeFake_FAKE",
      "0f0f0f0f-aaaa-bbbb-cccc-0123456789ab",
      "Y21mYWtlOnNlY3JldGZha2VmYWtlZmFrZQ==",
      "wJalrXUtnFEMI",
      "AKIAFAKEFAKEFAKEFAKE",
      "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-FAKE",
      "0123456789abcdef0123456789abcdef01234567",
      "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    ];
    for (const text of [
      ...Object.values(cases),
      JSON.stringify({ ...cases, STATS_API_TOKEN: "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE" }),
      JSON.stringify({ headers: { "x-api-key": "0f0f0f0f-aaaa-bbbb-cccc-0123456789ab" } }),
    ]) {
      const out = scrubSecrets(text);
      for (const secret of secrets) expect(out, text).not.toContain(secret);
    }
    // The bot id alone, a chat id or a timestamp is not a token.
    expect(scrubSecrets("chat 1234567890: sent 12 at 1730000000000")).toBe(
      "chat 1234567890: sent 12 at 1730000000000",
    );
  });

  it("leaves plain URLs and mints alone", () => {
    const text = JSON.stringify({
      imageUrl: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      mint: "So11111111111111111111111111111111111111112",
    });
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("isOpsRead", () => {
  it("allows only the listed reads, by GET or HEAD", () => {
    expect(isOpsRead("GET", "/stats/ops/worker")).toBe(true);
    expect(isOpsRead("HEAD", "/stats/ops/fdsa/")).toBe(true);
    expect(isOpsRead(["GET", "HEAD"], "/stats/ops/models/:seat/calls")).toBe(true);
    expect(isOpsRead("PUT", "/stats/ops/ai/switch")).toBe(false);
    expect(isOpsRead("GET", "/stats/ops/accounts")).toBe(false);
    expect(isOpsRead("GET", "/stats/ops/filters")).toBe(false);
    expect(isOpsRead("PATCH", "/stats/ops/fdsa")).toBe(false);
    expect(isOpsRead("POST", "/stats/ops/jobs/run-now")).toBe(false);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("/stats/ops", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env: Env = { ...loadEnv(), STATS_API_TOKEN: TOKEN };
    app = await buildServer(env);
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (url: string, auth = `Bearer ${TOKEN}`) =>
    app.inject({ method: "GET", url, headers: { authorization: auth } });

  it("refuses a request without the token", async () => {
    expect((await get("/stats/ops/worker", "")).statusCode).toBe(401);
    expect((await get("/stats/ops/worker", "Bearer wrong-token-wrong-token-wrong-token")).statusCode).toBe(
      401,
    );
  });

  // The cheap reads; the heavy aggregates (hit rates, storage, feed-sim) are the admin
  // panel's own builders, covered by their own tests.
  it.each([
    "/stats/ops/",
    "/stats/ops/errors?hours=24",
    "/stats/ops/trainer",
    "/stats/ops/overview",
    "/stats/ops/worker",
    "/stats/ops/ai",
    "/stats/ops/alerts?limit=5",
    "/stats/ops/training",
    "/stats/ops/jobs/run-now",
    "/stats/ops/curator/retrain",
    "/stats/ops/fdsa",
    "/stats/ops/fdsa/reviews",
    "/stats/ops/fdsa/lab",
    "/stats/ops/fdsa/replay",
    "/stats/ops/api-usage",
  ])("%s answers the token", async (url) => {
    const res = await get(url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("leaves the fits' metrics out of /trainer on metrics=false", async () => {
    const res = await get("/stats/ops/trainer?metrics=false&limit=5");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("evalMetrics");
    expect((await get("/stats/ops/trainer?metrics=maybe")).statusCode).toBe(400);
  });

  it("lists every read on its index", async () => {
    const res = await get("/stats/ops/");
    const body = res.json() as { reads: string[] };
    expect(body.reads.length).toBe(OPS_READS.length - 1);
  });

  it("serves no write, whatever the token", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const writes = [
      { method: "PUT" as const, url: "/stats/ops/ai/switch", payload: { state: "off" } },
      { method: "POST" as const, url: "/stats/ops/confirm", payload: {} },
      { method: "PATCH" as const, url: "/stats/ops/fdsa", payload: { running: false } },
      { method: "POST" as const, url: "/stats/ops/fdsa/reset", payload: {} },
      { method: "POST" as const, url: "/stats/ops/jobs/run-now", payload: { job: "scan" } },
      { method: "POST" as const, url: "/stats/ops/curator/retrain", payload: {} },
      { method: "POST" as const, url: "/stats/ops/api-usage/helius-credits-restored", payload: {} },
    ];
    const before = await prisma.jobRunRequest.count();
    for (const w of writes) {
      const res = await app.inject({ ...w, headers: auth });
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(404);
    }
    expect(await prisma.jobRunRequest.count()).toBe(before);
  });

  it("leaves out the reads that carry users' wallets", async () => {
    expect((await get("/stats/ops/accounts")).statusCode).toBe(404);
    expect((await get("/stats/ops/filters")).statusCode).toBe(404);
  });
});

describe.skipIf(!dbAvailable)("/stats/ops without a token configured", () => {
  it("is absent", async () => {
    const app = await buildServer({ ...loadEnv(), STATS_API_TOKEN: "" });
    try {
      const res = await app.inject({ method: "GET", url: "/stats/ops/worker" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
