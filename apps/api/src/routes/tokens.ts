import type { FastifyInstance } from "fastify";
import { prisma, type TokenSageAnalysis } from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { sageRead, sageTrack, type DayLabelRow, type SageView } from "../tokenSageView.js";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Market cap points drawn in the TokenSage view's chart (the newest scans). */
const SAGE_CHART_POINTS = 120;

/** The week of narrative records behind the TokenSage view: the same for every token, moves hourly. */
const TRACK_DAYS = 7;
const TRACK_CACHE_MS = 10 * 60_000;

/**
 * Token detail is not user-specific (it's the same underlying market data for
 * everyone), but still requires auth since it's part of the product surface
 * rather than a public API - keeps scope aligned with "multiple users,
 * individual filters" rather than an open public tool.
 */
export async function registerTokenRoutes(app: FastifyInstance) {
  // Token detail is reached from the paid feed. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:mintAddress", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    const row = await prisma.token.findUnique({ where: { mintAddress } });
    if (!row) {
      return reply.code(404).send({ error: "token not found" });
    }
    // Its own query rather than a nested `snapshots: { take: 50 }` include: Prisma doesn't
    // reliably push a nested take down as SQL LIMIT, and TokenSnapshot is the largest table.
    // A direct take on the (tokenId, takenAt) index is a bounded index walk.
    // Everything but the AI text scores: model inputs, not display data (the cards omit them too).
    const { aiTextScores: _scores, aiTextScoredAt: _scoredAt, ...token } = row;
    const snapshots = await prisma.tokenSnapshot.findMany({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
      take: 50,
    });
    return { ...token, snapshots };
  });

  const weekLabels = new SharedCache<DayLabelRow[]>(TRACK_CACHE_MS);

  /** TokenSage's read of the token, for the card's TokenSage view (src/tokenSageView.ts). */
  app.get("/:mintAddress/sage", async (request, reply): Promise<SageView | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    const [row, token] = await Promise.all([
      prisma.tokenNarrative.findUnique({
        where: { mintAddress },
        select: {
          depth: true,
          status: true,
          failReason: true,
          categories: true,
          mainCategory: true,
          analysis: true,
        },
      }),
      prisma.token.findUnique({
        where: { mintAddress },
        select: { id: true, symbol: true, name: true, imageUrl: true, firstSeenAt: true },
      }),
    ]);
    const [snapshots, labels] = await Promise.all([
      token
        ? prisma.tokenSnapshot.findMany({
            where: { tokenId: token.id },
            orderBy: { takenAt: "desc" },
            take: SAGE_CHART_POINTS,
            select: { takenAt: true, marketCapUsd: true },
          })
        : [],
      row?.categories
        ? weekLabels.get(() =>
            prisma.lighthouseDayLabel.findMany({
              where: {
                dimension: "category",
                day: { gte: new Date(Date.now() - TRACK_DAYS * 86_400_000) },
              },
              select: { day: true, label: true, count: true, alerts: true, graded: true, won2x: true },
            }),
          )
        : [],
    ]);
    const read =
      row?.status === "failed"
        ? null
        : sageRead(row?.analysis as TokenSageAnalysis | null, row?.depth ?? "basic");
    return {
      mint: mintAddress,
      token: token
        ? {
            symbol: token.symbol,
            name: token.name,
            imageUrl: token.imageUrl,
            firstSeenAt: token.firstSeenAt.toISOString(),
          }
        : null,
      status: read ? "ok" : row?.status === "failed" ? "failed" : "none",
      failReason: row?.status === "failed" ? (row.failReason ?? null) : null,
      read,
      marketCap: snapshots
        .filter((s) => Number.isFinite(s.marketCapUsd) && s.marketCapUsd > 0)
        .reverse()
        .map((s) => ({ t: s.takenAt.toISOString(), usd: s.marketCapUsd })),
      track: read ? sageTrack(labels, row?.categories, row?.mainCategory) : null,
    };
  });
}
