// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { attachAiReviewsForAdmin } from "./curatedFeed.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `curated-ai-review-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("attachAiReviewsForAdmin", () => {
  let alertId: string;

  beforeAll(async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "AI" } });
    const alert = await prisma.curatedAlert.create({
      data: { tokenId: token.id, source: TAG, confidence: 80, anchorPriceUsd: 1, anchorMcapUsd: 50_000 },
    });
    alertId = alert.id;
    await prisma.aiReview.create({
      data: {
        tokenId: token.id,
        curatedAlertId: alert.id,
        mode: "shadow",
        model: "test",
        decision: "buy",
        reasoning: "strong holder growth",
        latencyMs: 1,
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
      },
    });
  });

  afterAll(async () => {
    if (dbAvailable) await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("shows the reviewer's reasoning to an admin", async () => {
    const [card] = await attachAiReviewsForAdmin([{ curated: { alertId } }], true);
    expect(card?.curated?.aiReview?.reasoning).toBe("strong holder growth");
    expect(card?.curated?.aiReview?.decision).toBe("buy");
  });

  it("never attaches it for anyone else", async () => {
    const [card] = await attachAiReviewsForAdmin([{ curated: { alertId } }], false);
    expect(card?.curated).not.toHaveProperty("aiReview");
  });
});
