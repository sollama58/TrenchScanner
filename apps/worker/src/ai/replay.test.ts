// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, loadEnv, type ScoredToken } from "@trenchscanner/core";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import { loadReplayItems, replayVerdictRow } from "./replay.js";
import { recordCandidateSample } from "../jobs/candidateOutcomeJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ai-replay-test-${Date.now()}`;

function fixture(mintAddress: string, mcap: number, ageMinutes = 90): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: mcap,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    top10HolderPct: 20,
    ageMinutes,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 95 },
  };
}

const succeeded = (customId: string, text: string, stop = "end_turn"): MessageBatchIndividualResponse =>
  ({
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "text", text }],
        stop_reason: stop,
        stop_details: null,
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    },
  }) as unknown as MessageBatchIndividualResponse;

describe("replayVerdictRow", () => {
  const verdict = JSON.stringify({
    decision: "buy",
    probability2x: 1.4,
    probability4x: 0.3,
    reasoning: "strong flow",
    risks: [],
  });

  it("stores a schema-valid answer against the playbook its custom_id names", () => {
    const row = replayVerdictRow("run1", ["pbA", "pbB"], succeeded("p1-co_123", verdict));
    expect(row).toMatchObject({
      runId: "run1",
      playbookId: "pbB",
      candidateOutcomeId: "co_123",
      decision: "buy",
      probability2x: 1,
      error: null,
      inputTokens: 1200,
    });
  });

  it("records refusals, junk and failed requests as errors, and drops unknown ids", () => {
    expect(replayVerdictRow("r", ["pb"], succeeded("p0-x", verdict, "refusal"))?.error).toMatch(/^refused/);
    expect(replayVerdictRow("r", ["pb"], succeeded("p0-x", "not json"))?.error).toBe("unparsable verdict");
    expect(replayVerdictRow("r", ["pb"], succeeded("p0-x", '{"decision":"maybe"}'))?.error).toBe(
      "unparsable verdict",
    );
    const expired = { custom_id: "p0-x", result: { type: "expired" } } as MessageBatchIndividualResponse;
    expect(replayVerdictRow("r", ["pb"], expired)?.error).toBe("expired");
    expect(replayVerdictRow("r", ["pb"], succeeded("p5-x", verdict))).toBeNull();
    expect(replayVerdictRow("r", ["pb"], succeeded("bogus", verdict))).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("loadReplayItems", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  /** A graded event row anchored `minutesAgo` before now, optionally with an alert sent on it. */
  async function gradedRow(
    name: string,
    minutesAgo: number,
    labelValue: number,
    alert: boolean,
    mcap: number,
    peak = labelValue > 0 ? 150 : 10,
  ) {
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-${name}`, symbol: name.toUpperCase(), description: `the ${name} coin` },
    });
    const sample = await recordCandidateSample(
      token.id,
      fixture(token.mintAddress, mcap, mcap / 1_000),
      env,
      {
        kind: "event",
        bypassSpacing: true,
      },
    );
    const anchorAt = new Date(Date.now() - minutesAgo * 60_000);
    await prisma.candidateOutcome.update({
      where: { id: sample!.id },
      data: {
        anchorAt,
        finalizedAt: new Date(anchorAt.getTime() + 61 * 60_000),
        labelValue,
        peak1hReturnPct: peak,
        sampleKind: "event",
      },
    });
    if (alert) {
      await prisma.curatedAlert.create({
        data: {
          tokenId: token.id,
          candidateOutcomeId: sample!.id,
          source: "cm_test",
          model: "consensus",
          confidence: 42,
          calibratedPct: 27,
          reasons: ["backed by Trees"],
          anchorPriceUsd: 0.0001,
          anchorMcapUsd: 150_000,
          createdAt: anchorAt,
        },
      });
    }
    return sample!.id;
  }

  it("briefs each past alert as the live reviewer saw it, with comparables only from outcomes already known", async () => {
    // Graded long before the alert: a fair comparable.
    await gradedRow("earlier", 600, 1.5, false, 140_000);
    await gradedRow("earlier2", 500, 0, false, 130_000, 40);
    // Graded AFTER the alert was made: must not leak into its brief.
    await gradedRow("later", 120, 0, false, 160_000);
    const alertId = await gradedRow("alert", 300, 1, true, 150_000);

    const items = await loadReplayItems(env, {
      from: new Date(Date.now() - 400 * 60_000),
      to: new Date(),
      take: 50,
    });
    const item = items.find((i) => i.candidateOutcomeId === alertId);
    expect(item).toBeDefined();
    expect(item!.brief).toContain("symbol: ALERT");
    // The calibrated rate, not the conviction score.
    expect(item!.brief).toContain("doubles within 15 minutes: 27%");
    expect(item!.brief).toContain("backed by Trees");
    // The earlier row won (+150%); the later one, which would read "missed (peak +10%)", is unseen.
    expect(item!.brief).toContain("WON (peak +150%)");
    expect(item!.brief).toContain("missed (peak +40%)");
    expect(item!.brief).not.toContain("missed (peak +10%)");
  });
});
