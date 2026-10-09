import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { buildModelLineup, explainCall, recentSeatCalls, type CallExplain } from "../modelExplain.js";

/**
 * The Admin "Models" section (modelExplain.ts): every seat's recipe, inputs, member weights and
 * cutoffs, its newest calls, and one call explained. Behind the admin wallet check (registered
 * under its preHandler in server.ts), read-only.
 */

/** The lineup replays every active model over recent moments: once per training cadence is plenty. */
const LINEUP_CACHE_MS = 10 * 60_000;
/** A call's explanation never changes once its model and inputs are stored. */
const EXPLAIN_CACHE_MAX = 64;

const seatSchema = z.object({ seat: z.string().regex(/^[a-z0-9-]{1,40}$/, "not a model id") });
const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(15) });
const alertSchema = z.object({ id: z.string().regex(/^[a-z0-9]{8,40}$/i, "not an alert id") });

export async function registerAdminModelRoutes(app: FastifyInstance, opts: { env: Env }) {
  const lineup = new SharedCache<Awaited<ReturnType<typeof buildModelLineup>>>(LINEUP_CACHE_MS);
  app.get("/models/explain", async () => lineup.get(() => buildModelLineup(opts.env)));

  app.get("/models/:seat/calls", async (request, reply) => {
    const seat = seatSchema.safeParse(request.params);
    const limit = limitSchema.safeParse(request.query);
    if (!seat.success || !limit.success) {
      const issue = (!seat.success ? seat.error : !limit.success ? limit.error : null)?.issues[0];
      return reply.code(400).send({ error: issue?.message ?? "invalid request" });
    }
    return recentSeatCalls(seat.data.seat, limit.data.limit);
  });

  const explained = new Map<string, CallExplain>();
  app.get("/models/calls/:id", async (request, reply) => {
    const parsed = alertSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const hit = explained.get(parsed.data.id);
    if (hit) return hit;
    const out = await explainCall(opts.env, parsed.data.id);
    if (!out) return reply.code(404).send({ error: "no such call" });
    if (explained.size >= EXPLAIN_CACHE_MAX) explained.delete(explained.keys().next().value as string);
    explained.set(parsed.data.id, out);
    return out;
  });
}
