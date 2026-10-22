import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  type Env,
  clampToSafetyBounds,
  FILTER_SAFETY_CEILINGS as CAP,
  prisma,
  scanBand,
  loadFilterTrackRecords,
  SCANNED_LAUNCHPADS,
} from "@trenchscanner/core";
import {
  boardFor,
  buildFilterLeaderboard,
  criteriaChanged,
  criteriaSnapshot,
  filterLeaderboardCache,
  KEEP_IF_EVER_RANKED_WITHIN,
  parseEntryId,
} from "../filterLeaderboard.js";
import { clearReaderCaches } from "./matches.js";

// A factory (rather than a module-level constant) so mcapMin/mcapMax default to this deployment's
// own MCAP_FILTER_MIN/MAX instead of a hardcoded literal that could drift out of sync with them -
// only matters for a POST that omits mcapMin/mcapMax entirely, but there's no reason to duplicate
// the number when env already has it.
const narrativeLabelList = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[a-z0-9_]+(\/[a-z0-9_]+)?$/, "narrative labels are lowercase slugs like animal or animal/dog")
      .max(60),
  )
  .max(20)
  .default([]);

/**
 * The icons a filter's feed cards can carry (apps/web/src/components/Icons.tsx draws them; the
 * Filters tab's FILTER_ICONS mirrors this list).
 */
export const FILTER_ICONS = [
  "target",
  "flame",
  "bolt",
  "rocket",
  "star",
  "gem",
  "crown",
  "shield",
  "trophy",
  "radar",
] as const;

function buildFilterInputSchema(env: Env) {
  return z.object({
    name: z.string().min(1).max(60).default("Default"),
    mcapMin: z.number().nonnegative().default(env.MCAP_FILTER_MIN),
    mcapMax: z.number().positive().default(env.MCAP_FILTER_MAX),
    minVolumeMcapRatio: z.number().nonnegative().nullable().optional(),
    minHolderGrowthPct: z.number().nullable().optional(),
    // Capped at the most the safety screen lets through (core's filterBounds.ts): a looser value
    // only promises tokens the screen never alerts.
    maxTop10HolderPct: z.number().min(0).max(CAP.maxTop10HolderPct).nullable().optional(),
    maxLargestHolderPct: z.number().min(0).max(CAP.maxLargestHolderPct).nullable().optional(),
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
    maxFreshTop10WalletPct: z.number().min(0).max(CAP.maxFreshTop10WalletPct).nullable().optional(),
    maxEmptyTop10WalletPct: z.number().min(0).max(CAP.maxEmptyTop10WalletPct).nullable().optional(),
    maxSniperTop10WalletPct: z.number().min(0).max(100).nullable().optional(),
    maxSniperTopHolderCount: z.number().int().min(0).max(CAP.maxSniperTopHolderCount).nullable().optional(),
    maxBlockZeroHeldPct: z.number().min(0).max(CAP.maxBlockZeroHeldPct).nullable().optional(),
    maxLinkedWalletPct: z.number().min(0).max(100).nullable().optional(),
    maxLinkedWalletCount: z.number().int().min(0).max(CAP.maxLinkedWalletCount).nullable().optional(),
    maxFlaggedBuySol: z.number().min(0).max(10_000).nullable().optional(),
    minCexFundedCount: z.number().int().min(0).max(CAP.minCexFundedCount).nullable().optional(),
    maxCexFundedCount: z.number().int().min(0).max(CAP.maxCexFundedCount).nullable().optional(),
    maxSameTimeFundedPct: z.number().min(0).max(100).nullable().optional(),
    maxSameTimeFundedCount: z.number().int().min(0).max(25).nullable().optional(),
    maxLinkedCreatorPct: z.number().min(0).max(100).nullable().optional(),
    maxKolBundledPct: z.number().min(0).max(100).nullable().optional(),
    maxBundledSupplyPct: z.number().min(0).max(CAP.maxBundledSupplyPct).nullable().optional(),
    maxTransferredSupplyPct: z.number().min(0).max(100).nullable().optional(),
    minLiveHolderCount: z.number().int().min(0).max(100_000).nullable().optional(),
    // Empty means any launchpad. Only the ones discovery takes (core's SCANNED_LAUNCHPADS).
    launchpads: z
      .array(z.string().refine((v) => SCANNED_LAUNCHPADS.has(v), "unknown launchpad"))
      .max(10)
      .default([]),
    minFirstBuyersHolding: z.number().int().min(0).max(25).nullable().optional(),
    maxFirstBuyersHolding: z.number().int().min(0).max(25).nullable().optional(),
    // TokenSage narrative criteria (core matchFilters.ts). Labels are TokenSage's own slugs, a
    // top-level one ("animal") or a full one ("animal/dog"); the taxonomy can grow on their side,
    // so the shape is checked rather than the list.
    narrativeCategories: narrativeLabelList,
    excludeNarrativeCategories: narrativeLabelList,
    excludeCopycats: z.boolean().default(false),
    excludeNarrativeRedFlags: z.boolean().default(false),
    excludeUnrelatedX: z.boolean().default(false),
    requireTrendMatch: z.boolean().default(false),
    excludeLateCopies: z.boolean().default(false),
    // Card style (not criteria): any #rrggbb, though the Filters tab offers a fixed palette, and
    // one of FILTER_ICONS. Null goes back to the owner's Customize styling.
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #rrggbb hex color")
      .transform((c) => c.toLowerCase())
      .nullable()
      .optional(),
    icon: z.enum(FILTER_ICONS).nullable().optional(),
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
    minCexFundedCount?: number | null;
    maxCexFundedCount?: number | null;
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
    if (above(f.minCexFundedCount, f.maxCexFundedCount)) {
      return "Minimum exchange-funded holders must not be above the maximum - the filter could never match";
    }
    return null;
  }

  app.get("/", async (request) => {
    const filters = await prisma.userFilter.findMany({
      where: { userId: request.user!.userId, deletedAt: null },
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
      if ((await tx.userFilter.count({ where: { userId, deletedAt: null } })) >= MAX_FILTERS_PER_USER)
        return null;
      const row = await tx.userFilter.create({ data: { ...parsed.data, userId } });
      return { row, boardChanged: row.shareOnLeaderboard };
    });
    if (created?.boardChanged) filterLeaderboardCache.clear();
    if (!created) {
      return reply
        .code(409)
        .send({ error: `You can save up to ${MAX_FILTERS_PER_USER} filters. Delete one to add another.` });
    }
    return reply.code(201).send(created.row);
  });

  /**
   * Switches this filter on. The user's other filters stay as they are: each saved filter is
   * switched on and off on its own (PATCH isActive), and every one that is on alerts. Kept for
   * dashboards from before per-filter switches, which posted here to pick their one active filter.
   */
  app.post("/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    const activated = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      const existing = await tx.userFilter.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId || existing.deletedAt) return null;
      const row = await tx.userFilter.update({
        where: { id },
        // Switched on from off: it starts from what newly matches, not the backlog (armedAt).
        data: { isActive: true, ...(existing.isActive ? {} : { armedAt: new Date() }) },
      });
      return { row, boardChanged: existing.shareOnLeaderboard, switched: !existing.isActive };
    });
    if (!activated) return reply.code(404).send({ error: "filter not found" });
    // The board shows which shared filters are active now.
    if (activated.boardChanged) filterLeaderboardCache.clear();
    // "Only alerts both caught" counts active filters alone: its cached stats change with this.
    if (activated.switched) clearReaderCaches(userId);
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
      if (existing.deletedAt) {
        // A retired filter is gone as far as its owner's filter list goes, with one exception:
        // they can still take it off the public board. Nothing else about it can change.
        const unshareOnly = Object.keys(parsed.data).length === 1 && parsed.data.shareOnLeaderboard === false;
        if (!unshareOnly) return { error: 404 as const };
        const updated = await tx.userFilter.update({ where: { id }, data: { shareOnLeaderboard: false } });
        return { updated, boardChanged: existing.shareOnLeaderboard };
      }
      const merged = { ...existing, ...parsed.data };
      const rangeError = filterError(merged);
      if (rangeError) return { error: 400 as const, message: rangeError };
      // New criteria start a new leaderboard record: the record shown must be the one of the
      // settings a copier would get, not of whatever the filter used to be. The old settings are
      // kept as a version of their own, so the record they earned stays on the board (as its own
      // entry, once it is rankable) and can still be copied.
      const reset = criteriaChanged(existing, parsed.data);
      const changedAt = new Date();
      if (reset) {
        const version = (await tx.filterVersion.count({ where: { filterId: id } })) + 1;
        await tx.filterVersion.create({
          data: {
            filterId: id,
            version,
            criteria: criteriaSnapshot(existing) as Prisma.InputJsonObject,
            startedAt: existing.criteriaChangedAt,
            endedAt: changedAt,
          },
        });
      }
      const updated = await tx.userFilter.update({
        where: { id },
        data: {
          ...parsed.data,
          ...(rearms(existing, parsed.data) ? { armedAt: new Date() } : {}),
          ...(reset ? { criteriaChangedAt: changedAt } : {}),
        },
      });
      return {
        updated,
        boardChanged: existing.shareOnLeaderboard || updated.shareOnLeaderboard,
        switched: existing.isActive !== updated.isActive,
      };
    });
    if ("updated" in result) {
      if (result.boardChanged) filterLeaderboardCache.clear();
      // "Only alerts both caught" counts active filters alone (its feed, stats and returns), and
      // those answers are cached per reader: switching a filter on or off changes them now.
      if (result.switched) clearReaderCaches(userId);
      return result.updated;
    }
    if (result.error === 404) return reply.code(404).send({ error: "filter not found" });
    return reply.code(400).send({ error: result.message });
  });

  /**
   * Deleting a filter deletes every alert it raised with it (Match cascades) - unless it is on the
   * board and it, or one of its earlier versions, ever ranked in its top KEEP_IF_EVER_RANKED_WITHIN.
   * Such a filter is retired instead:
   * hidden from its owner, switched off for good, no longer counted against their cap, but its
   * alert history and record stay on the board (user decision 2026-10-06). An unshared filter is
   * not on the board, so there is no record there to keep: it is deleted whatever it once ranked.
   * The owner can still unshare a retired one (PATCH above), which leaves it off the board for good.
   */
  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;
    // Under the same lock as the other filter writes, so a create counting toward the cap and a
    // delete can't interleave, and a concurrent PATCH gets a 404 rather than a P2025 500.
    const existing = await prisma.$transaction(async (tx) => {
      await lockUserFilters(tx, userId);
      const row = await tx.userFilter.findUnique({ where: { id } });
      if (!row || row.userId !== userId || row.deletedAt) return null;
      const ranked = (bestRank: number | null) => bestRank !== null && bestRank <= KEEP_IF_EVER_RANKED_WITHIN;
      const versionRanked =
        (await tx.filterVersion.count({
          where: { filterId: id, bestRank: { lte: KEEP_IF_EVER_RANKED_WITHIN } },
        })) > 0;
      if (row.shareOnLeaderboard && (ranked(row.bestRank) || versionRanked)) {
        await tx.userFilter.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      } else {
        await tx.userFilter.delete({ where: { id } });
      }
      return row;
    });
    if (!existing) return reply.code(404).send({ error: "filter not found" });
    if (existing.shareOnLeaderboard) filterLeaderboardCache.clear();
    // The cascade announces nothing, so the owner's cached stats and deep-page counts would still
    // include the deleted alerts until their TTL ran out.
    clearReaderCaches(userId);
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
   * and counted against their MAX_FILTERS_PER_USER like any other. A retired filter can still be
   * copied while it is on the board; once its owner unshares it, it can't, like any other. An
   * earlier version's entry (id "<filter>-vN") copies that version's settings.
   */
  app.post("/leaderboard/:id/copy", async (request, reply) => {
    const { filterId: id, version } = parseEntryId((request.params as { id: string }).id);
    // FilterVersion.version is an Int: a bigger one in the URL is no version at all, not a 500.
    if (version !== null && version > MAX_INT32) {
      return reply.code(404).send({ error: "That filter is no longer shared." });
    }
    const userId = request.user!.userId;
    const result = await prisma.$transaction(async (tx) => {
      const source = await tx.userFilter.findUnique({ where: { id } });
      if (!source || !source.shareOnLeaderboard) return { error: 404 as const };
      const earlier =
        version === null
          ? null
          : await tx.filterVersion.findUnique({ where: { filterId_version: { filterId: id, version } } });
      if (version !== null && !earlier) return { error: 404 as const };
      await lockUserFilters(tx, userId);
      if ((await tx.userFilter.count({ where: { userId, deletedAt: null } })) >= MAX_FILTERS_PER_USER) {
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
        bestRank: _bestRank,
        deletedAt: _deletedAt,
        ...criteria
      } = source;
      // An earlier version's settings, keeping only columns a filter still has: one dropped since
      // the version was saved can't fail the create, and one added since takes its default, as the
      // version never had it.
      const columns = new Set(Object.keys(criteriaSnapshot(source)));
      const versionCriteria = earlier
        ? (Object.fromEntries(
            Object.entries(earlier.criteria as Record<string, unknown>).filter(([k]) => columns.has(k)),
          ) as typeof criteria)
        : null;
      const created = await tx.userFilter.create({
        data: {
          // A source saved before the screen's bounds can't hand a copy values the API refuses.
          ...clampToSafetyBounds(versionCriteria ?? criteria),
          name: copyName(earlier ? `${name} v${earlier.version}` : name),
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

/** The largest value a Postgres integer column holds. */
const MAX_INT32 = 2_147_483_647;

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
      key !== "color" &&
      key !== "icon" &&
      key !== "isActive" &&
      key !== "shareOnLeaderboard" &&
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(existing[key] ?? null),
  );
}

/**
 * How many filters a user can save. Each one is switched on or off on its own, and every one
 * that is on is evaluated against every token on each scan, which is why the cap exists.
 */
export const MAX_FILTERS_PER_USER = 10;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Serialises one user's filter writes, so two tabs can't both create the 11th. */
export async function lockUserFilters(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"filters:" + userId}))`;
}
