// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, resetAiReviewerSwitchCache, type Env } from "@trenchscanner/core";

const parse = vi.fn();
vi.mock("./client.js", async (importActual) => ({
  lenientFormat: (await importActual<typeof import("./client.js")>()).lenientFormat,
  anthropicClient: () => ({ beta: { messages: { parse } } }),
  anthropicConfigured: (env: Env) => env.ANTHROPIC_API_KEY !== "",
  describeAnthropicError: (err: unknown) => String(err),
}));
const { requestTextScores, resetTextScorer } = await import("./textScorer.js");
const { resetAiBudget } = await import("./budget.js");

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ai-text-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("text scorer", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable ? { ...base, ANTHROPIC_API_KEY: "test-key", AI_TEXT_MAX_PER_HOUR: 2 } : base;

  beforeEach(() => {
    resetAiReviewerSwitchCache("admins");
    resetTextScorer();
    resetAiBudget();
    parse.mockReset();
    parse.mockResolvedValue({
      model: "claude-opus-5-5",
      usage: { input_tokens: 800, output_tokens: 400 },
      stop_reason: "end_turn",
      parsed_output: { copycatRisk: 0.8, narrativeStrength: 0.4, memeAppeal: 0.6, scamSignals: 1.7 },
    });
  });

  afterAll(async () => {
    resetAiReviewerSwitchCache();
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
    resetAiReviewerSwitchCache("off");
    expect(requestTextScores(token, env)).toBeNull();
    resetAiReviewerSwitchCache("admins");
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

  it("asks nothing once the daily AI budget is spent, and gives the hourly slot back", async () => {
    const token = await newToken("e");
    await requestTextScores(token, { ...env, AI_DAILY_BUDGET_USD: 0 });
    expect(parse).not.toHaveBeenCalled();
    const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.aiTextScoredAt).toBeNull();
    // Not marked failed, and the slot is free again: with budget back, the same mint is read.
    await requestTextScores(token, env);
    await requestTextScores(await newToken("e2"), env);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("reads a billed answer that isn't schema-valid JSON as no answer, not as a failed call", async () => {
    const token = await newToken("f");
    // The SDK's own format throws on such text, which settled the budget at the estimate with the
    // real usage in hand; the format sent parses it to null instead.
    parse.mockImplementationOnce(
      async (params: { output_config: { format: { parse: (s: string) => unknown } } }) => {
        const format = params.output_config.format;
        expect(format.parse('{"copycatRisk": 0.2, "narra')).toBeNull();
        expect(format.parse('{"copycatRisk": "high"}')).toBeNull();
        expect(
          format.parse('{"copycatRisk":0.1,"narrativeStrength":0.2,"memeAppeal":0.3,"scamSignals":0.4}'),
        ).toEqual({
          copycatRisk: 0.1,
          narrativeStrength: 0.2,
          memeAppeal: 0.3,
          scamSignals: 0.4,
        });
        return {
          model: "claude-haiku-5-5",
          usage: { input_tokens: 800, output_tokens: 4000 },
          stop_reason: "max_tokens",
          parsed_output: format.parse('{"copycatRisk": 0.2, "narra'),
        };
      },
    );
    await requestTextScores(token, env);
    const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.aiTextScoredAt).toBeNull();
    // Not asked again this run, as before.
    expect(requestTextScores(token, env)).toBeNull();
  });

  it("gives up on a token whose read failed, until the worker restarts", async () => {
    const token = await newToken("d");
    parse.mockRejectedValueOnce(new Error("boom"));
    await requestTextScores(token, env);
    expect(requestTextScores(token, env)).toBeNull();
  });
});
