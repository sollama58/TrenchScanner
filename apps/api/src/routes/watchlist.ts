import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addToWatchlist,
  clearWatchlist,
  loadWatchlist,
  removeFromWatchlist,
  reorderWatchlist,
  WATCHLIST_CAP,
  WATCHLIST_FULL_MESSAGE,
} from "../watchlist.js";

const tokenId = z.string().trim().min(1).max(64);
const mint = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid mint");

const addSchema = z.union([z.object({ tokenId }).strict(), z.object({ mint }).strict()]);
const orderSchema = z.object({ tokenIds: z.array(tokenId).min(1).max(WATCHLIST_CAP) }).strict();

const WRITE_LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * The Watchlist (apps/api/src/watchlist.ts). Behind the same subscriber gate as the feeds whose
 * tokens it stars.
 *
 *   GET    /watchlist            -> { cap, items: WatchlistEntry[] } (in the user's order)
 *   POST   /watchlist            { tokenId } | { mint } -> 201 { item } (200 if already watched;
 *                                409 { error, cap } when full; 404 for a token the scanner doesn't track)
 *   PUT    /watchlist/order      { tokenIds } -> { cap, items }
 *   DELETE /watchlist/:tokenId   -> { removed }
 *   DELETE /watchlist            -> { removed: count }
 */
export async function registerWatchlistRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { cap: WATCHLIST_CAP, items: await loadWatchlist(request.user!.userId) };
  });

  app.post("/", { config: WRITE_LIMIT }, async (request, reply) => {
    const parsed = addSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const result = await addToWatchlist(request.user!.userId, parsed.data);
    if (result.kind === "unknown_token") {
      return reply.code(404).send({ error: "TrenchScanner doesn't track this token yet." });
    }
    if (result.kind === "full") {
      return reply.code(409).send({ error: WATCHLIST_FULL_MESSAGE, cap: WATCHLIST_CAP });
    }
    return reply.code(result.kind === "added" ? 201 : 200).send({ item: result.entry });
  });

  app.put("/order", { config: WRITE_LIMIT }, async (request, reply) => {
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    await reorderWatchlist(request.user!.userId, parsed.data.tokenIds);
    return { cap: WATCHLIST_CAP, items: await loadWatchlist(request.user!.userId) };
  });

  app.delete("/", { config: WRITE_LIMIT }, async (request) => ({
    removed: await clearWatchlist(request.user!.userId),
  }));

  app.delete("/:tokenId", { config: WRITE_LIMIT }, async (request, reply) => {
    const parsed = tokenId.safeParse((request.params as { tokenId?: unknown }).tokenId);
    if (!parsed.success) return reply.code(400).send({ error: "invalid token id" });
    return { removed: await removeFromWatchlist(request.user!.userId, parsed.data) };
  });
}
