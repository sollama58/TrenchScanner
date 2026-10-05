import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Env, prisma, scanBand, loadFilterTrackRecords } from "@trenchscanner/core";
import {
  boardFor,
  buildFilterLeaderboard,
  criteriaChanged,
  filterLeaderboardCache,
} from "../filterLeaderboard.js";

// A factory (rather than a module-level constant) so mcapMin/mcapMax default to this deployment's
// own MCAP_FILTER_MIN/MAX instead of a hardcoded literal that could drift out of sync with them -
// only matters for a POST that omits mcapMin/mcapMax entirely, but there's no reason to duplicate
// the number when env already has it.
function buildFilterInputSchema(env: Env) {
  return z.object({
    name: z.string().min(1).max(60).default("Default"),
    mcapMin: z.number().nonnegative().default(env.MCAP_FILTER_MIN),
    mcapMax: z.number().positive().default(env.MCAP_FILTER_MAX),
    minVolumeMcapRatio: z.number().nonnegative().nullable().optional(),
    minHolderGrowthPct: z.number().nullable().optional(),
    maxTop10HolderPct: z.number().min(0).max(100).nullable().optional(),
    maxDevWalletPct: z.number().min(0).max(100).nullable().optional(),
    maxRiskScore: z.number().min(0).max(100).nullable().optional(),
    excludeCriticalRiskFlags: z.boolean().default(false),
    // Not .int(): a fraction of a minute is how you express seconds here, and rejecting 0.25
    // would make the field's own placeholder a lie.
    minTokenAgeMinutes: z.number().nonnegative().nullable().optional(),
    maxTokenAgeMinutes: z.number().nonnegative().nullable().optional(),
    // Capped: every active filter is evaluated against every token on each scan.
    narrativeKeywords: z
      .array(z.string().trim().min(1, "keywords can't be blank").max(40))
      .max(20)
      .default([]),
    minScore: z.number().min(0).max(100).nullable().optional(),
    maxFreshTop10WalletPct: z.number().min(0).max(100).nullable().optional(),
    maxEmptyTop10WalletPct: z.number().min(0).max(100).nullable().optional(),
    minFirstBuyersHolding: z.number().int().min(0).max(25).nullable().optional(),
    maxFirstBuyersHolding: z.number().int().min(0).max(25).nullable().optional(),
    isActive: z.boolean().default(true),
    // Opt-in to the public filter leaderboard; off unless the owner turns it on.
    shareOnLeaderboard: z.boolean().default(false),
  });
}

export async function registerFilterRoutes(app: FastifyInstance, opts: { env: Env }) {
  // Filters are the product: they decide what the paid feed shows. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  const filterInputSchema = buildFilterInputSchema(opts.env);
  const filterUpdateSchema = filterInputSchema.partial();

  // The true range a token could ever be scanned/matched at - see scanBand()'s own doc comment.
  // A user's mcapMin/mcapMax outside this can never match anything regardless of what they set,
  // so both the create and update handlers below reject it rather than silently accepting a
  // filter that will never fire. Computed once at startup since env only changes via redeploy.
  const { min: scanMin, max: scanMax } = scanBand(opts.env.MCAP_FILTER_MIN, opts.env.MCAP_FILTER_MAX);

  function mcapRangeError(mcapMin: number, mcapMax: number): string | null {
    if (mcapMin >= mcapMax) return "mcapMin must be less than mcapMax";
    if (mcapMin < scanMin || mcapMax > scanMax) {
      return `Market cap range must be within $${scanMin.toLocaleString()}-$${scanMax.toLocaleString()} - the platform never scans tokens outside that range`;
    }
    return null;
  }

  /**
   * Every rule a whole filter has to satisfy, checked against the row as it will be saved (on a
   * PATCH, the stored row with the change merged in). A min above its max can never match
   * anything, and the filter would sit silent with nothing telling its owner why.
   */
  function filterError(f: {
    mcapMin: number;
    mcapMax: number;
    minTokenAgeMinutes?: number | null;
    maxTokenAgeMinutes?: number | null;
    minFirstBuyersHolding?: number | null;
    maxFirstBuyersHolding?: number | null;
  }): string | null {
    const mcap = mcapRangeError(f.mcapMin, f.mcapMax);
    if (mcap) return mcap;
    const above = (min: number | null | undefined, max: number | null | undefined) =>
      min != null && max != null && min > max;
    if (above(f.minTokenAgeMinutes, f.maxTokenAgeMinutes)) {
      return "Minimum token age must not be above the maximum - the filter could never match";
    }
    if (above(f.minFirstBuyersHolding, f.maxFirstBuyersHolding)) {
      return "Minimum first buyers holding must not be above the maximum - the filter could never match";
    }
    return null;
  }

  app.get("/", async (request) => {
    const filters = await prisma.userFilter.findMany({
      where: { userId: request.user!.userId },
      orderBy: { createdAt: "asc" },
    });
    // Each filter's last-30-day record on the curated feed's verdict (2x within 15 minutes of the alert
    // price, a 50% drop first is a loss) - additive, so an older dashboard simply ignores it.
    const records = await loadFilterTrackRecords(filters).catch(() => new Map());
    return filters.map((f) => ({ ...f, trackRecord: records.get(f.id) ?? null }));
  });

  app.post("/", async (request, reply) => {
    const parsed = filterInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const rangeError = filterError(parsed.data);
    if (rangeError) {
      return reply.code(400).send({ error: rangeError });
    }
    const userId = request.user!.userId;
    const created = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      if ((await tx.userFilter.count({ where: { userId } })) >= MAX_FILTERS_PER_USER) return null;
      const switchedOff = parsed.data.isActive ? await deactivateOthers(tx, userId, null) : false;
      const row = await tx.userFilter.create({ data: { ...parsed.data, userId } });
      return { row, boardChanged: row.shareOnLeaderboard || switchedOff };
    });
    if (created?.boardChanged) filterLeaderboardCache.clear();
    if (!created) {
      return reply
        .code(409)
        .send({ error: `You can save up to ${MAX_FILTERS_PER_USER} filters. Delete one to add another.` });
    }
    return reply.code(201).send(created.row);
  });

  /** Makes this the user's one active filter, switching off whichever was active before. */
  app.post("/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    const activated = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      const existing = await tx.userFilter.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId) return null;
      const switchedOff = await deactivateOthers(tx, userId, id);
      const row = await tx.userFilter.update({
        where: { id },
        // Switched on from off: it starts from what newly matches, not the backlog (armedAt).
        data: { isActive: true, ...(existing.isActive ? {} : { armedAt: new Date() }) },
      });
      return { row, boardChanged: existing.shareOnLeaderboard || switchedOff };
    });
    if (!activated) return reply.code(404).send({ error: "filter not found" });
    // The board shows which shared filters are active now.
    if (activated.boardChanged) filterLeaderboardCache.clear();
    return activated.row;
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = filterUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const userId = request.user!.userId;
    // Read, validated and written under the user's filter lock. Validating outside it let two
    // concurrent PATCHes (one moving only mcapMin, the other only mcapMax) each pass against the
    // old row and together save mcapMin >= mcapMax; and a delete landing in between turned the
    // update into a P2025 500 instead of a 404.
    const result = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      const existing = await tx.userFilter.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId) return { error: 404 as const };
      const merged = { ...existing, ...parsed.data };
      const rangeError = filterError(merged);
      if (rangeError) return { error: 400 as const, message: rangeError };
      // Turning one filter on turns the user's other filters off: one active filter at a time.
      const switchedOff = parsed.data.isActive ? await deactivateOthers(tx, userId, id) : false;
      // New criteria start a new leaderboard record: the record shown must be the one of the
      // settings a copier would get, not of whatever the filter used to be.
      const reset = criteriaChanged(existing, parsed.data);
      const updated = await tx.userFilter.update({
        where: { id },
        data: {
          ...parsed.data,
          ...(rearms(existing, parsed.data) ? { armedAt: new Date() } : {}),
          ...(reset ? { criteriaChangedAt: new Date() } : {}),
        },
      });
      return {
        updated,
        boardChanged: existing.shareOnLeaderboard || updated.shareOnLeaderboard || switchedOff,
      };
    });
    if ("updated" in result) {
      if (result.boardChanged) filterLeaderboardCache.clear();
      return result.updated;
    }
    if (result.error === 404) return reply.code(404).send({ error: "filter not found" });
    return reply.code(400).send({ error: result.message });
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    // Under the same lock as the other filter writes, so a create counting toward the cap and a
    // delete can't interleave, and a concurrent PATCH gets a 404 rather than a P2025 500.
    const existing = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      const row = await tx.userFilter.findUnique({ where: { id } });
      if (!row || row.userId !== userId) return null;
      await tx.userFilter.delete({ where: { id } });
      return row;
    });
    if (!existing) return reply.code(404).send({ error: "filter not found" });
    if (existing.shareOnLeaderboard) filterLeaderboardCache.clear();
    return reply.code(204).send();
  });

  /**
   * The public filter leaderboard - shared filters ranked by their alerts' graded record (see
   * filterLeaderboard.ts). The same board for every reader, cached; the caller's own entries are
   * flagged and no owner is ever named.
   */
  app.get("/leaderboard", async (request) => {
    const board = await filterLeaderboardCache.get(() => buildFilterLeaderboard(opts.env));
    return boardFor(board, request.user!.userId);
  });

  /**
   * Copies a shared filter's criteria into a new saved filter for the caller: inactive, not shared,
   * and counted against their MAX_FILTERS_PER_USER like any other.
   */
  app.post("/leaderboard/:id/copy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    const result = await prisma.$transaction(async (tx) => {
      const source = await tx.userFilter.findUnique({ where: { id } });
      if (!source || !source.shareOnLeaderboard) return { error: 404 as const };
      await lockUserFilters(tx, userId);
      if ((await tx.userFilter.count({ where: { userId } })) >= MAX_FILTERS_PER_USER) {
        return { error: 409 as const };
      }
      // Everything but identity, ownership and state: exactly the criteria (FILTER_CRITERIA_KEYS).
      const {
        id: _id,
        userId: _owner,
        name,
        isActive: _active,
        shareOnLeaderboard: _shared,
        createdAt: _created,
        updatedAt: _updated,
        criteriaChangedAt: _changed,
        armedAt: _armed,
        ...criteria
      } = source;
      const created = await tx.userFilter.create({
        data: {
          ...criteria,
          name: copyName(name),
          isActive: false,
          shareOnLeaderboard: false,
          userId,
        },
      });
      return { created };
    });
    if ("created" in result) return reply.code(201).send(result.created);
    if (result.error === 404) return reply.code(404).send({ error: "That filter is no longer shared." });
    return reply
      .code(409)
      .send({ error: `You can save up to ${MAX_FILTERS_PER_USER} filters. Delete one to copy another.` });
  });
}

/** "Copy of <name>", kept inside the 60-character name limit. */
function copyName(name: string): string {
  return `Copy of ${name}`.slice(0, 60);
}

/**
 * Whether a change makes the filter start over from what newly matches (UserFilter.armedAt):
 * switched on from off, or any matching rule changed. Renaming, or saving it unchanged, doesn't -
 * a filter that is already alerting keeps its cooldowns either way, this only stops the tokens it
 * newly matches at that moment from all alerting at once.
 */
export function rearms(existing: Record<string, unknown>, change: Record<string, unknown>): boolean {
  if (change.isActive === true && existing.isActive !== true) return true;
  return Object.entries(change).some(
    ([key, value]) =>
      key !== "name" &&
      key !== "isActive" &&
      key !== "shareOnLeaderboard" &&
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(existing[key] ?? null),
  );
}

/**
 * How many filters a user can save. Only one is active at a time (see deactivateOthers): the rest
 * are saved setups to switch between, and every active filter is evaluated against every token on
 * each scan, which is why both limits exist.
 */
export const MAX_FILTERS_PER_USER = 10;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Serialises one user's filter writes, so two tabs can't both create the 11th or both activate. */
async function lockUserFilters(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"filters:" + userId}))`;
}

/**
 * Switches off every active filter of this user except `keepId`. Returns whether one of them is
 * on the public leaderboard, which shows each shared filter's active state.
 */
async function deactivateOthers(tx: Tx, userId: string, keepId: string | null): Promise<boolean> {
  const where = { userId, isActive: true, ...(keepId ? { id: { not: keepId } } : {}) };
  const shared = await tx.userFilter.count({ where: { ...where, shareOnLeaderboard: true } });
  await tx.userFilter.updateMany({ where, data: { isActive: false } });
  return shared > 0;
}
