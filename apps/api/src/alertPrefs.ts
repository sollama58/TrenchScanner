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

export const alertPrefsSchema = z.object({
  soundEnabled: z.boolean(),
  sound: z.enum(ALERT_SOUNDS),
  /** 0-100. */
  volume: z.number().int().min(0).max(100),
  browserNotifications: z.boolean(),
  /** Which alerts ping or notify. */
  notifyOn: z.object({ filterMatches: z.boolean(), modelCalls: z.boolean() }),
});

export type AlertPrefs = z.infer<typeof alertPrefsSchema>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  soundEnabled: true,
  sound: "chime",
  volume: 60,
  browserNotifications: false,
  notifyOn: { filterMatches: true, modelCalls: true },
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
