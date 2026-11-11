// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FDSA_DEFAULT_EXIT_PLAN, FDSA_PROMPT_VERSIONS, loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";

const TAG = `fdsa-replay-test-${Date.now()}`;

/** What the mocked client does: the batch it creates, the results it streams, the calls it saw. */
const mock: {
  results: MessageBatchIndividualResponse[];
  processingStatus: string;
  created: { requests: { custom_id: string; params: Record<string, unknown> }[] }[];
  failCreate: Error | null;
} = { results: [], processingStatus: "ended", created: [], failCreate: null };
vi.mock("../ai/client.js", async (importActual) => ({
  ...(await importActual<typeof import("../ai/client.js")>()),
  anthropicClient: () => ({
    messages: {
      batches: {
        create: async (body: { requests: { custom_id: string; params: Record<string, unknown> }[] }) => {
          if (mock.failCreate) throw mock.failCreate;
          mock.created.push(body);
          return { id: `${TAG}-batch-${mock.created.length}` };
        },
        retrieve: async () => ({ processing_status: mock.processingStatus }),
        results: async () =>
          (async function* () {
            yield* mock.results;
          })(),
      },
    },
  }),
}));
const {
  decideReplayVariants,
  decideReplayVerdictRow,
  FDSA_DECIDE_REPLAY_PURPOSE,
  loadDecideReplayItems,
  MIN_REPLAY_ITEMS,
  pollDecideReplayRuns,
  rocAuc,
  runFdsaDecideReplayJob,
  submitDecideReplay,
  summarizeDecideReplay,
} = await import("./decideReplay.js");
const { pollReplayRuns } = await import("../ai/replay.js");

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
if (!dbAvailable && process.env.REQUIRE_TEST_DB === "1")
  throw new Error("REQUIRE_TEST_DB=1 but Postgres is unreachable");

const env = (over: Partial<Env> = {}): Env => ({
  ...loadEnv(),
  ANTHROPIC_API_KEY: "sk-ant-test",
  FDSA_DECIDE_MODEL: "claude-opus-5-5",
  FDSA_DECIDE_EFFORT: "high",
  FDSA_TRADE_TOP_PCT: 20,
  FDSA_DECIDE_REPLAY: TAG,
  FDSA_DECIDE_REPLAY_ITEMS: 500,
  FDSA_DECIDE_REPLAY_MAX_USD: 30,
  ...over,
});

const answer = (decision: "trade" | "pass", probability2x: number) =>
  JSON.stringify({
    decision,
    probability2x,
    probability4x: probability2x / 2,
    conviction: 0.6,
    exitPlan: FDSA_DEFAULT_EXIT_PLAN,
    reasoning: "flow",
    risks: [],
  });

const succeeded = (customId: string, text: string, stop = "end_turn"): MessageBatchIndividualResponse =>
  ({
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        model: "claude-opus-5-5",
        content: [{ type: "text", text }],
        stop_reason: stop,
        stop_details: null,
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    },
  }) as unknown as MessageBatchIndividualResponse;

describe("decide replay variants", () => {
  it("replays at the live effort and one step cheaper", () => {
    expect(decideReplayVariants({ FDSA_DECIDE_EFFORT: "high" }, "t")).toEqual([
      { id: "t:high", effort: "high" },
      { id: "t:medium", effort: "medium" },
    ]);
    expect(decideReplayVariants({ FDSA_DECIDE_EFFORT: "medium" }, "t")).toEqual([
      { id: "t:medium", effort: "medium" },
      { id: "t:low", effort: "low" },
    ]);
    expect(decideReplayVariants({ FDSA_DECIDE_EFFORT: "low" }, "t")).toEqual([
      { id: "t:low", effort: "low" },
    ]);
  });
});

describe("decideReplayVerdictRow", () => {
  const ids = ["t:high", "t:medium"];
  it("stores the model's own word and odds under the variant its custom_id names", () => {
    expect(decideReplayVerdictRow("run", ids, succeeded("v1-co_1", answer("trade", 0.4)))).toEqual({
      runId: "run",
      playbookId: "t:medium",
      candidateOutcomeId: "co_1",
      decision: "trade",
      probability2x: 0.4,
      probability4x: 0.2,
      error: null,
      inputTokens: 1200,
      outputTokens: 300,
    });
  });
  it("keeps a refusal, a bad answer and a failed request as errors with no odds", () => {
    expect(
      decideReplayVerdictRow("run", ids, succeeded("v0-co_1", answer("pass", 0.1), "refusal")),
    ).toMatchObject({
      decision: null,
      probability2x: null,
      error: expect.any(String),
    });
    expect(decideReplayVerdictRow("run", ids, succeeded("v0-co_1", "not json"))).toMatchObject({
      decision: null,
      probability2x: null,
    });
    const errored = {
      custom_id: "v0-co_2",
      result: { type: "errored", error: { type: "invalid_request" } },
    } as unknown as MessageBatchIndividualResponse;
    expect(decideReplayVerdictRow("run", ids, errored)).toMatchObject({
      candidateOutcomeId: "co_2",
      error: "errored: invalid_request",
    });
  });
  it("drops a result that names no variant of the run", () => {
    expect(decideReplayVerdictRow("run", ids, succeeded("v2-co_1", answer("pass", 0.1)))).toBeNull();
    expect(decideReplayVerdictRow("run", ids, succeeded("p0-co_1", answer("pass", 0.1)))).toBeNull();
  });
});

describe("rocAuc", () => {
  it("is 1 when every winner outscores every loser, 0.5 on ties, null without both outcomes", () => {
    expect(
      rocAuc([
        { score: 0.9, won: true },
        { score: 0.8, won: true },
        { score: 0.3, won: false },
      ]),
    ).toBe(1);
    expect(
      rocAuc([
        { score: 0.5, won: true },
        { score: 0.5, won: false },
      ]),
    ).toBe(0.5);
    expect(rocAuc([{ score: 0.9, won: true }])).toBeNull();
    // One winner ranked under one of three losers: 2 of 3 pairs right.
    expect(
      rocAuc([
        { score: 0.9, won: false },
        { score: 0.7, won: true },
        { score: 0.2, won: false },
        { score: 0.1, won: false },
      ]),
    ).toBeCloseTo(0.667, 3);
  });
});

describe("summarizeDecideReplay", () => {
  const row = (
    variantId: string,
    i: number,
    decision: "trade" | "pass" | null,
    p: number | null,
    labelValue: number,
    modelPct: number | null = null,
  ) => ({ variantId, candidateOutcomeId: `co_${i}`, decision, probability2x: p, labelValue, modelPct });

  it("grades each variant's word, its ranked top share and its ordering, beside the model's", () => {
    // Ten alerts, three winners. The live pass ranks the winners first; the cheap pass flips one.
    const live = [
      row("t:high", 1, "trade", 0.6, 1, 40),
      row("t:high", 2, "trade", 0.5, 1.5, 30),
      row("t:high", 3, "pass", 0.4, 1, 10),
      ...[4, 5, 6, 7, 8, 9, 10].map((i) => row("t:high", i, "pass", 0.1, 0, 20)),
    ];
    const cheap = [
      row("t:medium", 1, "trade", 0.6, 1, 40),
      row("t:medium", 2, "pass", 0.2, 1.5, 30),
      row("t:medium", 3, "pass", 0.4, 1, 10),
      row("t:medium", 4, "trade", 0.5, 0, 20),
      ...[5, 6, 7, 8, 9].map((i) => row("t:medium", i, "pass", 0.1, 0, 20)),
      row("t:medium", 10, null, null, 0, 20),
    ];
    const out = summarizeDecideReplay([...live, ...cheap], ["t:high", "t:medium"], 20);
    expect(out["t:high"]).toEqual({
      answered: 10,
      errors: 0,
      baseWinRatePct: 30,
      trades: 2,
      tradeWinRatePct: 100,
      ranked: 2,
      rankedWinRatePct: 100,
      auc: 1,
      brier: expect.any(Number),
      meanProbability2xPct: 22,
      // The model put a loser band (20%) above one winner (10%): 2 of 3 winners outrank the losers.
      modelAuc: expect.closeTo(0.667, 2),
      modelRankedWinRatePct: 100,
      agreesWithLivePct: null,
      rankedOverlapPct: null,
    });
    expect(out["t:medium"]).toMatchObject({
      answered: 9,
      errors: 1,
      trades: 2,
      tradeWinRatePct: 50,
      ranked: 2,
      rankedWinRatePct: 50,
      // Nine answered, two words differ (co_2 and co_4).
      agreesWithLivePct: expect.closeTo(77.8, 1),
      rankedOverlapPct: 50,
    });
    expect(out["t:medium"]!.auc).toBeLessThan(1);
  });

  it("reports nothing on a variant with no usable answer", () => {
    const out = summarizeDecideReplay([row("t:high", 1, null, null, 1)], ["t:high"], 20);
    expect(out["t:high"]).toMatchObject({ answered: 0, errors: 1, auc: null, brier: null, ranked: 0 });
  });
});

describe.skipIf(!dbAvailable)("the decide replay on the database", () => {
  let tokens: { id: string }[] = [];
  const outcomes = new Map<string, string>();

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.aiReplayRun.deleteMany({ where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });
  beforeEach(() => {
    mock.results = [];
    mock.created = [];
    mock.failCreate = null;
    mock.processingStatus = "ended";
  });

  async function seed(
    i: number,
    opts: {
      graded?: boolean;
      version?: string;
      brief?: boolean;
      calibratedPct?: number;
      later?: boolean;
    } = {},
  ) {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}`, symbol: `R${i}` } });
    tokens.push(token);
    const at = new Date(Date.now() - (100 - i) * 3_600_000);
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        anchorAt: at,
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        features: {},
        nextCheckAt: at,
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
        ...(opts.graded === false ? {} : { finalizedAt: at, labelValue: i % 3 === 0 ? 1 : 0 }),
      },
    });
    outcomes.set(`co_${i}`, outcome.id);
    const alert =
      opts.calibratedPct === undefined
        ? null
        : await prisma.curatedAlert.create({
            data: {
              tokenId: token.id,
              source: "catcher",
              model: "catcher",
              confidence: 50,
              calibratedPct: opts.calibratedPct,
              anchorPriceUsd: 1,
              anchorMcapUsd: 10_000,
              createdAt: at,
            },
          });
    const review = (createdAt: Date, brief: string | null) => ({
      tokenId: token.id,
      candidateOutcomeId: outcome.id,
      curatedAlertId: alert?.id ?? null,
      stage: "decide",
      model: "claude-opus-5-5",
      effort: "high",
      promptVersion: opts.version ?? FDSA_PROMPT_VERSIONS.decide,
      brief,
      decision: "pass",
      alertAt: at,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      latencyMs: 1,
      createdAt,
    });
    await prisma.fdsaReview.create({ data: review(at, opts.brief === false ? null : `brief ${i} first`) });
    if (opts.later) {
      await prisma.fdsaReview.create({
        data: review(new Date(at.getTime() + 60_000), `brief ${i} latest`),
      });
    }
    return outcome.id;
  }

  it("loads the latest graded decide per token on the current prompt, with its brief", async () => {
    tokens = [];
    for (let i = 1; i <= 60; i++) await seed(i, { later: i === 1, calibratedPct: i === 2 ? 25 : undefined });
    await seed(61, { graded: false });
    await seed(62, { version: "fdsa-decide-v5" });
    await seed(63, { brief: false });
    const items = await loadDecideReplayItems(1000);
    const mine = items.filter(
      (it) => outcomes.has(it.candidateOutcomeId) || tokens.some((t) => t.id === it.tokenId),
    );
    const ids = new Set(mine.map((it) => it.candidateOutcomeId));
    expect(ids.size).toBe(60);
    expect(ids.has(outcomes.get("co_61")!)).toBe(false);
    expect(ids.has(outcomes.get("co_62")!)).toBe(false);
    expect(ids.has(outcomes.get("co_63")!)).toBe(false);
    expect(mine.find((it) => it.candidateOutcomeId === outcomes.get("co_1"))?.brief).toBe("brief 1 latest");
    // Newest first, and `max` caps the list.
    expect(mine[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(mine[1]!.createdAt.getTime());
    expect((await loadDecideReplayItems(5)).length).toBe(5);
  });

  it("submits one batch of every item under every variant, trimmed to the cap, and records the run", async () => {
    const items = (await loadDecideReplayItems(1000)).filter((it) => tokens.some((t) => t.id === it.tokenId));
    expect(items.length).toBe(60);
    // A cap that pays for fewer than MIN_REPLAY_ITEMS sends nothing and records nothing.
    expect(
      await submitDecideReplay(env({ FDSA_DECIDE_REPLAY_MAX_USD: 0.01 }), { tag: TAG, items }),
    ).toMatchObject({
      runId: null,
      reason: "over-cap",
    });
    expect(mock.created).toHaveLength(0);
    expect(MIN_REPLAY_ITEMS).toBe(50);

    const submitted = await submitDecideReplay(env({ FDSA_DECIDE_REPLAY_ITEMS: 55 }), { tag: TAG, items });
    expect(submitted).toMatchObject({ items: 55, requests: 110 });
    expect(submitted.runId).not.toBeNull();
    const body = mock.created[0]!;
    expect(body.requests).toHaveLength(110);
    expect(body.requests[0]!.custom_id).toBe(`v0-${items[0]!.candidateOutcomeId}`);
    expect(body.requests[55]!.custom_id).toBe(`v1-${items[0]!.candidateOutcomeId}`);
    expect(body.requests[0]!.params).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: items[0]!.brief }],
      output_config: { effort: "high" },
    });
    expect(body.requests[55]!.params).toMatchObject({ output_config: { effort: "medium" } });
    expect(String((body.requests[0]!.params.system as { text: string }[])[0]!.text)).toContain("top 20%");
    const run = await prisma.aiReplayRun.findUniqueOrThrow({ where: { id: submitted.runId! } });
    expect(run).toMatchObject({
      purpose: FDSA_DECIDE_REPLAY_PURPOSE,
      status: "submitted",
      batchId: `${TAG}-batch-1`,
      playbookIds: [`${TAG}:high`, `${TAG}:medium`],
      requestCount: 110,
    });
    expect(run.estimatedCostUsd).toBeGreaterThan(0);
    expect(run.estimatedCostUsd).toBeLessThanOrEqual(30);
    // The reviewer's own poll leaves the run alone.
    expect(await pollReplayRuns(env())).toEqual([]);
    expect((await prisma.aiReplayRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("submitted");
  });

  it("scores the batch once it ends: verdicts per variant, the scorecard on the run, the real cost", async () => {
    const run = await prisma.aiReplayRun.findFirstOrThrow({
      where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE, status: "submitted" },
    });
    const items = (await loadDecideReplayItems(1000)).filter((it) => tokens.some((t) => t.id === it.tokenId));
    const labelOf = new Map(
      (
        await prisma.candidateOutcome.findMany({
          where: { id: { in: items.map((i) => i.candidateOutcomeId) } },
          select: { id: true, labelValue: true },
        })
      ).map((o) => [o.id, o.labelValue ?? 0]),
    );
    // The live pass knows the answer; the cheap pass guesses 0.2 everywhere and errs once.
    mock.results = items.flatMap((it, i) => [
      succeeded(
        `v0-${it.candidateOutcomeId}`,
        answer(
          labelOf.get(it.candidateOutcomeId)! > 0 ? "trade" : "pass",
          labelOf.get(it.candidateOutcomeId)! > 0 ? 0.6 : 0.1,
        ),
      ),
      i === 0
        ? succeeded(`v1-${it.candidateOutcomeId}`, "garbage")
        : succeeded(`v1-${it.candidateOutcomeId}`, answer("pass", 0.2)),
    ]);
    mock.processingStatus = "in_progress";
    expect(await pollDecideReplayRuns(env())).toEqual([]);
    mock.processingStatus = "ended";
    const scored = await pollDecideReplayRuns(env());
    expect(scored).toHaveLength(1);
    expect(scored[0]!.costUsd).toBeGreaterThan(0);
    const high = scored[0]!.summaries[`${TAG}:high`]!;
    const medium = scored[0]!.summaries[`${TAG}:medium`]!;
    expect(high).toMatchObject({
      answered: 60,
      errors: 0,
      auc: 1,
      tradeWinRatePct: 100,
      rankedWinRatePct: 100,
    });
    expect(high.trades).toBe(items.filter((it) => labelOf.get(it.candidateOutcomeId)! > 0).length);
    // One guess for every alert orders nothing: ties all round score a coin.
    expect(medium).toMatchObject({ answered: 59, errors: 1, trades: 0, auc: 0.5, tradeWinRatePct: null });
    expect(medium.agreesWithLivePct).toBeLessThan(100);
    // One alert carried the alerting model's odds: too few for an ordering, so no model AUC yet.
    expect(high.modelAuc).toBeNull();
    const stored = await prisma.aiReplayRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("scored");
    expect(stored.costUsd).toBeCloseTo(scored[0]!.costUsd, 6);
    expect(await prisma.aiReplayVerdict.count({ where: { runId: run.id } })).toBe(120);
    expect(
      await prisma.aiReplayVerdict.count({
        where: { runId: run.id, playbookId: `${TAG}:medium`, decision: null },
      }),
    ).toBe(1);
  });

  it("runs the tag once: a scored run is reported, not resubmitted, and no tag runs nothing", async () => {
    expect(await runFdsaDecideReplayJob(env({ FDSA_DECIDE_REPLAY: "" }))).toEqual({
      skipped: "FDSA_DECIDE_REPLAY unset",
    });
    expect(await runFdsaDecideReplayJob(env({ ANTHROPIC_API_KEY: "" }))).toEqual({
      skipped: "no ANTHROPIC_API_KEY",
    });
    const meta = await runFdsaDecideReplayJob(env());
    expect(meta).toMatchObject({ tag: TAG, status: "scored", requests: 110 });
    expect(meta["variant high"]).toMatchObject({ answered: 60, auc: 1 });
    expect(mock.created).toHaveLength(0);
  });

  it("records a submit that failed, and tries the tag again only after a day", async () => {
    const tag = `${TAG}-fail`;
    mock.failCreate = new Error("boom");
    const first = await runFdsaDecideReplayJob(env({ FDSA_DECIDE_REPLAY: tag }));
    expect(first).toMatchObject({ tag, submitted: false, reason: "submit-failed" });
    const failed = await prisma.aiReplayRun.findFirstOrThrow({
      where: { playbookIds: { has: `${tag}:high` } },
    });
    expect(failed).toMatchObject({ status: "failed", costUsd: 0 });
    mock.failCreate = null;
    // An hour later: still waiting on the failed one.
    expect(
      await runFdsaDecideReplayJob(env({ FDSA_DECIDE_REPLAY: tag }), Date.now() + 3_600_000),
    ).toMatchObject({
      status: "failed",
    });
    expect(mock.created).toHaveLength(0);
    // A day later: tried again.
    const retried = await runFdsaDecideReplayJob(
      env({ FDSA_DECIDE_REPLAY: tag }),
      Date.now() + 25 * 3_600_000,
    );
    expect(retried).toMatchObject({ tag, submitted: true });
    expect(mock.created).toHaveLength(1);
  });
});
