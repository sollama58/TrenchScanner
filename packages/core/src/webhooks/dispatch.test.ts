import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db.js";
import type { ContestantSpec } from "../curation/contestants.js";
import {
  newWebhookSecret,
  runWebhookDispatch,
  signWebhook,
  webhookUrlProblem,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_FAILURES,
  type WebhookSendResult,
} from "./dispatch.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `webhook-test-${Date.now()}`;

describe("webhookUrlProblem", () => {
  it("takes https on 443 to a public host only", () => {
    expect(webhookUrlProblem("https://hooks.example.com/ts")).toBeNull();
    expect(webhookUrlProblem("https://hooks.example.com:443/ts")).toBeNull();
    expect(webhookUrlProblem("https://8.8.8.8/ts")).toBeNull();
    for (const bad of [
      "http://hooks.example.com/ts",
      "https://hooks.example.com:8443/ts",
      "https://user:pw@hooks.example.com/ts",
      "https://localhost/ts",
      "https://metadata.internal/ts",
      "https://printer.local/ts",
      "https://127.0.0.1/ts",
      "https://169.254.169.254/latest",
      "https://10.0.0.5/ts",
      "https://[::1]/ts",
      "https://[fd00::1]/ts",
      "not a url",
    ]) {
      expect(webhookUrlProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("signWebhook", () => {
  it("is HMAC-SHA256 over '<t>.<body>' that a receiver can check", () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const header = signWebhook(secret, 1_800_000_000, '{"a":1}');
    const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
    expect(t).toBe("1800000000");
    expect(v1).toBe(createHmac("sha256", secret).update('1800000000.{"a":1}').digest("hex"));
  });
});

const spec = (id: string): ContestantSpec =>
  ({ id, name: id, description: "", role: "rules" }) as ContestantSpec;
// Its own model ids, so other suites' calls in the same window never reach this webhook.
const state = {
  roster: [spec("wh-rules"), spec("wh-trees")],
  defaultModel: "wh-rules",
  defaultModels: ["wh-rules"],
  bestModel: null,
};
const env = loadEnv();

type Sent = { url: string; headers: Record<string, string>; body: string };

describe.skipIf(!dbAvailable)("runWebhookDispatch", () => {
  let tokenId = "";
  let webhookId = "";
  const secret = newWebhookSecret();
  const partner = `${TAG}-p`.slice(0, 32);

  beforeAll(async () => {
    tokenId = (
      await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "TST", name: "Test" } })
    ).id;
  });
  afterAll(async () => {
    await prisma.partnerWebhook.deleteMany({ where: { partner } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });
  beforeEach(async () => {
    await prisma.partnerWebhook.deleteMany({ where: { partner } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    webhookId = (
      await prisma.partnerWebhook.create({
        data: {
          partner,
          url: "https://hooks.example.com/ts",
          secret,
          // Empty would follow the live default feed; the test's state names it instead.
          models: [],
          sentThrough: new Date(Date.now() - 60_000),
        },
      })
    ).id;
  });

  const call = (model: string, ageMs = 30_000) =>
    prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "test",
        confidence: 80,
        anchorPriceUsd: 0.001,
        anchorMcapUsd: 50_000,
        model,
        modelName: model,
        createdAt: new Date(Date.now() - ageMs),
      },
    });

  const run = (results: WebhookSendResult[] = [], now = Date.now) => {
    const sent: Sent[] = [];
    const summary = runWebhookDispatch(env, {
      send: async (url, headers, body) => {
        sent.push({ url, headers, body });
        return results.shift() ?? { status: 200, error: null };
      },
      now,
      oldestOpenTransaction: async () => null,
      feedModelState: async () => state,
    });
    return summary.then((s) => ({
      summary: s,
      sent: sent.filter((x) => x.url.includes("hooks.example.com")),
    }));
  };

  it("sends the default feed's calls once, signed", async () => {
    const mine = await call("wh-rules");
    await call("wh-trees");
    const first = await run();
    expect(first.sent).toHaveLength(1);
    const { headers, body } = first.sent[0]!;
    const parsed = JSON.parse(body) as { event: string; data: { alertId: string; token: { mint: string } } };
    expect(parsed.event).toBe("alert.created");
    expect(parsed.data.alertId).toBe(mine.id);
    expect(parsed.data.token.mint).toBe(`${TAG}-mint`);
    const [t] = headers["x-trenchscanner-signature"]!.split(",");
    expect(headers["x-trenchscanner-signature"]).toBe(signWebhook(secret, Number(t!.slice(2)), body));
    expect(headers["x-trenchscanner-event"]).toBe("alert.created");

    const again = await run();
    expect(again.sent).toHaveLength(0);
    const hook = await prisma.partnerWebhook.findUniqueOrThrow({ where: { id: webhookId } });
    expect(hook.lastDeliveryAt).not.toBeNull();
  });

  it("takes the models it lists instead of the default feed", async () => {
    await prisma.partnerWebhook.update({ where: { id: webhookId }, data: { models: ["wh-trees"] } });
    await call("wh-rules");
    const trees = await call("wh-trees");
    const { sent } = await run();
    expect(sent.map((s) => (JSON.parse(s.body) as { data: { alertId: string } }).data.alertId)).toEqual([
      trees.id,
    ]);
  });

  it("retries a failed send after its backoff, then gives up", async () => {
    await call("wh-rules");
    // A second ahead: the queued row's nextAttemptAt is the database's now(), a moment after this.
    let clock = Date.now() + 1_000;
    const now = () => clock;
    const first = await run([{ status: 500, error: "HTTP 500" }], now);
    expect(first.sent).toHaveLength(1);
    expect(first.summary.retrying).toBe(1);
    // Not due yet.
    expect((await run([], now)).sent).toHaveLength(0);
    clock += 11_000;
    const second = await run([{ status: 200, error: null }], now);
    expect(second.sent).toHaveLength(1);
    const [d] = await prisma.partnerWebhookDelivery.findMany({ where: { webhookId } });
    expect(d).toMatchObject({ status: "delivered", attempts: 2, lastStatus: 200 });
    expect(WEBHOOK_MAX_ATTEMPTS).toBeGreaterThan(2);
  });

  it("fails an alert past the news window rather than send it late", async () => {
    await call("wh-rules");
    await run([{ status: 503, error: "HTTP 503" }]);
    const later = Date.now() + 20 * 60_000;
    const { sent, summary } = await run([], () => later);
    expect(sent).toHaveLength(0);
    expect(summary.failed).toBe(1);
    const [d] = await prisma.partnerWebhookDelivery.findMany({ where: { webhookId } });
    expect(d?.status).toBe("failed");
  });

  it("pauses on a 410, and after too many failures in a row", async () => {
    await call("wh-rules");
    const gone = await run([{ status: 410, error: "HTTP 410" }]);
    expect(gone.summary.paused).toBe(1);
    expect(await prisma.partnerWebhook.findUniqueOrThrow({ where: { id: webhookId } })).toMatchObject({
      enabled: false,
      pausedReason: "gone",
    });

    await prisma.partnerWebhook.update({
      where: { id: webhookId },
      data: { enabled: true, pausedReason: null, consecutiveFailures: WEBHOOK_MAX_FAILURES - 1 },
    });
    await prisma.partnerWebhookDelivery.updateMany({
      where: { webhookId },
      data: { nextAttemptAt: new Date(0) },
    });
    await run([{ status: 500, error: "HTTP 500" }]);
    expect(await prisma.partnerWebhook.findUniqueOrThrow({ where: { id: webhookId } })).toMatchObject({
      enabled: false,
      pausedReason: "failing",
    });
  });

  it("sends a queued ping", async () => {
    await prisma.partnerWebhookDelivery.create({
      data: { webhookId, event: "ping", payload: { message: "hi" } },
    });
    const { sent } = await run();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ event: "ping", data: { message: "hi" } });
  });
});
