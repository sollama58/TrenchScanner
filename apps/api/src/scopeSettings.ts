import { z } from "zod";

/**
 * The Live feed's Scope view settings (user ask 2026-10-19): how its rows look, and its columns
 * (user ask 2026-10-23: up to six of the user's choosing) with each one's filters. Stored on User.scopeSettings as JSON so they
 * follow the account to every device, as the Cards look does.
 *
 * apps/web/src/scopeSettings.ts owns the shape and reads whatever comes back through
 * normalizeScopeSettings, which drops unknown or broken fields. So this side only bounds what an
 * account can store (the two sections, their keys, short values), rather than repeating every
 * field: a new Scope switch then needs no API change.
 */

export const SCOPE_COLUMNS = ["filters", "models", "new", "soon", "graduated"] as const;

const key = z.string().min(1).max(40);
const value = z.union([
  z.boolean(),
  z.number().finite(),
  z.null(),
  z.string().max(40),
  z.array(z.string().max(128)).max(50),
]);
const section = (maxKeys: number) =>
  z
    .record(key, value)
    .refine((r) => Object.keys(r).length <= maxKeys, { message: `at most ${maxKeys} settings` });

/** The most columns a board holds, and specific filters or models one column picks. */
export const MAX_SCOPE_COLUMNS = 6;
const MAX_PICKS = 3;

const boardColumn = z
  .object({
    id: z.string().min(1).max(40),
    kind: z.string().min(1).max(20),
    picks: z.array(z.string().max(128)).max(MAX_PICKS),
    filter: section(40),
  })
  .strict();

export const scopeSettingsSchema = z
  .object({
    display: section(60),
    board: z.array(boardColumn).min(1).max(MAX_SCOPE_COLUMNS).optional(),
    /** The fixed columns' filters, as builds before chosen columns saved them. */
    columns: z
      .object(Object.fromEntries(SCOPE_COLUMNS.map((c) => [c, section(40).optional()])))
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => s.board !== undefined || s.columns !== undefined, { message: "board is required" });

export type ScopeSettings = z.infer<typeof scopeSettingsSchema>;

/** A stored value as this build hands it back: null (the defaults) unless it still fits the bounds. */
export function parseScopeSettings(raw: unknown): ScopeSettings | null {
  if (raw === null || raw === undefined) return null;
  const parsed = scopeSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
