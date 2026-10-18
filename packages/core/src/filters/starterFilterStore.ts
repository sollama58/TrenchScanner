import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { Env } from "../config/env.js";
import { clampToSafetyBounds } from "./filterBounds.js";
import { STARTER_FILTER_NAME, starterFilterInput } from "./starterFilter.js";

/**
 * The filter a new account is seeded with: the frozen copy of Gemerald when one is stored
 * (StarterFilter, user ask 2026-10-18), the built-in starter filter otherwise.
 *
 * Like Gems' gate (curation/modelGate.ts) it is a copy, never a link: the row is written once by
 * the migration that froze it, and later edits to Gemerald don't reach new accounts. Existing
 * accounts' filters are never touched.
 */

/** The StarterFilter row new accounts read. */
export const STARTER_FILTER_ID = "default";

/** UserFilter columns a copy never carries: identity, ownership, state and card styling. */
const NOT_CRITERIA = new Set<string>([
  "id",
  "userId",
  "name",
  "color",
  "icon",
  "isActive",
  "createdAt",
  "updatedAt",
  "armedAt",
  "shareOnLeaderboard",
  "criteriaChangedAt",
  "bestRank",
  "deletedAt",
]);

const CRITERIA_COLUMNS = Object.values(Prisma.UserFilterScalarFieldEnum).filter((c) => !NOT_CRITERIA.has(c));

/**
 * The stored criteria as UserFilter create data, or null when they don't parse. Keys that are no
 * longer UserFilter columns are dropped, so a column removed after the copy can't fail the create.
 */
export function parseStarterCriteria(
  criteria: unknown,
): Omit<Prisma.UserFilterUncheckedCreateInput, "userId"> | null {
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) return null;
  const c = criteria as Record<string, unknown>;
  if (typeof c.mcapMin !== "number" || typeof c.mcapMax !== "number") return null;
  const data: Record<string, unknown> = {};
  for (const col of CRITERIA_COLUMNS) if (col in c) data[col] = c[col];
  // Inside the screen's bounds (filterBounds.ts) whatever the frozen copy says.
  return clampToSafetyBounds({ ...data, name: STARTER_FILTER_NAME, mcapMin: c.mcapMin, mcapMax: c.mcapMax });
}

/** What a new account's first filter is created with (without its userId). */
export async function starterFilterData(
  env: Env,
): Promise<Omit<Prisma.UserFilterUncheckedCreateInput, "userId">> {
  const row = await prisma.starterFilter.findUnique({ where: { id: STARTER_FILTER_ID } });
  return (row && parseStarterCriteria(row.criteria)) ?? starterFilterInput(env);
}
