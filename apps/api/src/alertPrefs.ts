import { z } from "zod";

/**
 * How alerts reach a user in the dashboard: an in-page sound and browser notifications. Stored on
 * User.alertPrefs as JSON so a new setting needs no migration; read through parseAlertPrefs, which
 * fills anything missing or unreadable with the defaults.
 *
 * The sounds are synthesized in the browser (apps/web/src/alertSounds.ts), so these ids are the
 * whole contract between the two.
 */
export const ALERT_SOUNDS = ["chime", "ping", "bell", "coin", "radar"] as const;

/** Where Chaos Mode opens each new alert: the cards' quick-link sites plus Pump.fun. */
export const CHAOS_SITES = ["terminal", "axiom", "gmgn", "pumpfun"] as const;
/** Chaos Mode's per-minute cap on the tabs it opens. */
export const CHAOS_PER_MINUTE = { min: 1, max: 60 } as const;

export const alertPrefsSchema = z.object({
  soundEnabled: z.boolean(),
  sound: z.enum(ALERT_SOUNDS),
  /** 0-100. */
  volume: z.number().int().min(0).max(100),
  browserNotifications: z.boolean(),
  /** Which alerts ping or notify. */
  notifyOn: z.object({ filterMatches: z.boolean(), modelCalls: z.boolean() }),
  /** Chaos Mode: open every new Live feed alert in a trading site's tab (desktop browsers only). */
  chaosMode: z.boolean(),
  /** The site it opens; null follows the first of the cards' quick links. */
  chaosSite: z.enum(CHAOS_SITES).nullable(),
  /** The most tabs it opens in any minute; alerts past it are skipped. */
  chaosPerMinute: z.number().int().min(CHAOS_PER_MINUTE.min).max(CHAOS_PER_MINUTE.max),
});

export type AlertPrefs = z.infer<typeof alertPrefsSchema>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  soundEnabled: true,
  sound: "chime",
  volume: 60,
  browserNotifications: false,
  notifyOn: { filterMatches: true, modelCalls: true },
  // Off by default, 10 a minute (user ask 2026-10-17).
  chaosMode: false,
  chaosSite: null,
  chaosPerMinute: 10,
};

/** A partial update: any top-level field, and either half of notifyOn. */
export const alertPrefsPatchSchema = alertPrefsSchema
  .extend({ notifyOn: alertPrefsSchema.shape.notifyOn.partial() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export type AlertPrefsPatch = z.infer<typeof alertPrefsPatchSchema>;

/** The stored JSON as settings, field by field: a bad or missing field takes its default. */
export function parseAlertPrefs(stored: unknown): AlertPrefs {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const field = <K extends keyof AlertPrefs>(key: K): AlertPrefs[K] => {
    const parsed = alertPrefsSchema.shape[key].safeParse(raw[key]);
    return parsed.success ? (parsed.data as AlertPrefs[K]) : DEFAULT_ALERT_PREFS[key];
  };
  const notifyRaw =
    typeof raw.notifyOn === "object" && raw.notifyOn !== null
      ? (raw.notifyOn as Record<string, unknown>)
      : {};
  return {
    soundEnabled: field("soundEnabled"),
    sound: field("sound"),
    volume: field("volume"),
    browserNotifications: field("browserNotifications"),
    chaosMode: field("chaosMode"),
    chaosSite: field("chaosSite"),
    chaosPerMinute: field("chaosPerMinute"),
    notifyOn: {
      filterMatches:
        typeof notifyRaw.filterMatches === "boolean"
          ? notifyRaw.filterMatches
          : DEFAULT_ALERT_PREFS.notifyOn.filterMatches,
      modelCalls:
        typeof notifyRaw.modelCalls === "boolean"
          ? notifyRaw.modelCalls
          : DEFAULT_ALERT_PREFS.notifyOn.modelCalls,
    },
  };
}

export function applyAlertPrefsPatch(current: AlertPrefs, patch: AlertPrefsPatch): AlertPrefs {
  return {
    ...current,
    ...patch,
    notifyOn: { ...current.notifyOn, ...(patch.notifyOn ?? {}) },
  };
}
