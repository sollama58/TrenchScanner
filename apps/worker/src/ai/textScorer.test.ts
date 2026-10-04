// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, type Env } from "@trenchscanner/core";

const parse = vi.fn();
vi.mock("./client.js", () => ({
  anthropicClient: () => ({ beta: { messages: { parse } } }),
  anthropicConfigured: (env: Env) => env.ANTHROPIC_API_KEY !== "",
  describeAnthropicError: (err: unknown) => String(err),
}));
const { requestTextScores, resetTextScorer } = await import("./textScorer.js");

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ai-text-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("text scorer", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable ? { ...base, ANTHROPIC_API_KEY: "test-key", AI_TEXT_MAX_PER_HOUR: 2 } : base;

  beforeEach(() => {
    resetTextScorer();
    parse.mockReset();
    parse.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: { copycatRisk: 0.8, narrativeStrength: 0.4, memeAppeal: 0.6, scamSignals: 1.7 },
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  const newToken = (name: string) =>
    prisma.token.create({
      data: { mintAddress: `${TAG}-${name}`, symbol: "CAT", name: "Cat", description: "meow" },
    });

  it("stores Claude's read on the token, clamped to 0-1", async () => {
    const token = await newToken("a");
    await requestTextScores(token, env);
    const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.aiTextScores).toEqual({
      copycatRisk: 0.8,
      narrativeStrength: 0.4,
      memeAppeal: 0.6,
      scamSignals: 1,
    });
    expect(row.aiTextScoredAt).not.toBeNull();
    const call = parse.mock.calls[0]![0];
    expect(call.messages[0].content).toContain("description: meow");
  });

  it("never asks without a key, twice for a scored token, or past the hourly cap", async () => {
    const token = await newToken("b");
    expect(requestTextScores(token, { ...env, ANTHROPIC_API_KEY: "" })).toBeNull();
    expect(requestTextScores({ ...token, aiTextScoredAt: new Date() }, env)).toBeNull();
    expect(
      requestTextScores({ ...token, aiTextScoredAt: new Date() }, { ...env, AI_TEXT_FEATURES: false }),
    ).toBeNull();
    const t1 = await newToken("c1");
    const t2 = await newToken("c2");
    const t3 = await newToken("c3");
    await Promise.all([requestTextScores(t1, env), requestTextScores(t2, env)]);
    expect(requestTextScores(t3, env)).toBeNull();
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("gives up on a token whose read failed, until the worker restarts", async () => {
    const token = await newToken("d");
    parse.mockRejectedValueOnce(new Error("boom"));
    await requestTextScores(token, env);
    expect(requestTextScores(token, env)).toBeNull();
  });
});
