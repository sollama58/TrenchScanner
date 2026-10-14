import { NARRATIVE_CONTESTANT } from "./contestants.js";
import { liveCallRecords, loadCurrentLanes } from "./laneStore.js";
import { emptyRecord, type CallRecord } from "./leaderboard.js";

/**
 * Whether the Narrative seat's "agrees"/"warns" note on other models' cards (dashboard pill and
 * Telegram line) shows by default. A user who set the Customize toggle keeps their choice; for
 * everyone else it turns on once the seat proves itself live (user decision 2026-10-08): its 2x
 * hit rate over the Models tab's default 7-day window above NARRATIVE_NOTE_MIN_RATE_PCT, on at
 * least NARRATIVE_NOTE_MIN_GRADED graded calls.
 *
 * "Proves" is read with a 90% Wilson interval and a hysteresis band (audit 2026-10-14, W17): at 20
 * graded calls the interval on 40% is about ±17 points, so a raw "> 40%" flipped the pill between
 * reads on noise alone. The note turns ON only when the interval's LOWER bound clears 40%, turns
 * OFF only when its UPPER bound falls below 40%, and in between keeps the state it had.
 */
export const NARRATIVE_NOTE_MIN_RATE_PCT = 40;
export const NARRATIVE_NOTE_MIN_GRADED = 20;
export const NARRATIVE_NOTE_WINDOW_DAYS = 7;
/** z for the two-sided 90% Wilson interval the band is read on. */
export const NARRATIVE_NOTE_Z = 1.645;

export interface NarrativeNoteReadiness {
  /** The note shows for users who haven't set the toggle. */
  ready: boolean;
  /** The seat's live 2x hit rate over the window, in percent; null with nothing graded. */
  winRatePct: number | null;
  /** Its 90% Wilson interval, in percent; null with nothing graded. */
  lowerPct: number | null;
  upperPct: number | null;
  graded: number;
  minRatePct: number;
  minGraded: number;
  windowDays: number;
}

/** The Wilson score interval of `wins` of `n` at `z`, as fractions; null with n = 0. */
export function narrativeNoteInterval(
  wins: number,
  n: number,
  z: number,
): { lower: number; upper: number } | null {
  if (n <= 0) return null;
  const p = Math.min(Math.max(wins / n, 0), 1);
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

/**
 * The readiness a live record makes: the same raw 2x rate the Models tab shows, judged on its
 * interval. `previous` is the state it last had (null when unknown, e.g. a fresh process); inside
 * the band the note keeps it, and with no previous state it stays off until the lower bound clears.
 */
export function narrativeNoteReadiness(
  record: CallRecord,
  previous: boolean | null = null,
): NarrativeNoteReadiness {
  const winRatePct = record.graded > 0 ? (record.wins / record.graded) * 100 : null;
  const interval = narrativeNoteInterval(record.wins, record.graded, NARRATIVE_NOTE_Z);
  const lowerPct = interval ? interval.lower * 100 : null;
  const upperPct = interval ? interval.upper * 100 : null;
  const enough = record.graded >= NARRATIVE_NOTE_MIN_GRADED;
  const on = enough && lowerPct !== null && lowerPct > NARRATIVE_NOTE_MIN_RATE_PCT;
  const off = !enough || upperPct === null || upperPct < NARRATIVE_NOTE_MIN_RATE_PCT;
  return {
    ready: on ? true : off ? false : (previous ?? false),
    winRatePct,
    lowerPct,
    upperPct,
    graded: record.graded,
    minRatePct: NARRATIVE_NOTE_MIN_RATE_PCT,
    minGraded: NARRATIVE_NOTE_MIN_GRADED,
    windowDays: NARRATIVE_NOTE_WINDOW_DAYS,
  };
}

/** The user's toggle if they set one, else the automatic default. */
export function showsNarrativeNote(choice: boolean | null | undefined, ready: boolean): boolean {
  return typeof choice === "boolean" ? choice : ready;
}

/** The toggle as stored on User.feedAppearance (narrativeNote), or null when unset. */
export function narrativeNoteChoice(feedAppearance: unknown): boolean | null {
  if (typeof feedAppearance !== "object" || feedAppearance === null) return null;
  const v = (feedAppearance as Record<string, unknown>).narrativeNote;
  return typeof v === "boolean" ? v : null;
}

const CACHE_MS = 5 * 60_000;
let cached: { at: number; value: Promise<NarrativeNoteReadiness> } | null = null;
/**
 * The state the band holds between reads. It lives in the process: the API and the worker's
 * Telegram dispatch each keep their own, and a restart starts from off (the strict side), so the
 * two can differ only while the record sits inside the band after one of them restarted - the
 * cheapest correct place, as the state needs no table and both start conservative.
 */
let lastReady: boolean | null = null;

/** Test hook. */
export function resetNarrativeNoteState(): void {
  cached = null;
  lastReady = null;
}

/**
 * The Narrative seat's readiness from its live calls, read the same way the Models tab reads its
 * record (its current lane's calls only). Cached for five minutes per process: the Telegram
 * dispatch asks every few seconds and the rate moves over hours.
 */
export function loadNarrativeNoteReadiness(now: number = Date.now()): Promise<NarrativeNoteReadiness> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = (async () => {
    const since = new Date(now - NARRATIVE_NOTE_WINDOW_DAYS * 86_400_000);
    const lanes = await loadCurrentLanes();
    const records = await liveCallRecords([NARRATIVE_CONTESTANT], since, lanes);
    const readiness = narrativeNoteReadiness(records.get(NARRATIVE_CONTESTANT) ?? emptyRecord(), lastReady);
    lastReady = readiness.ready;
    return readiness;
  })();
  cached = { at: now, value };
  // A failed read isn't kept: the next ask tries again.
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

/**
 * What the Narrative seat's verdict on a coin rests on, as stored with it
 * (CuratedAlert.narrativeRationale) and shown in the TokenSage view: its own probability, the
 * calibrated 2x rate of its past calls ranked like this one, and the inputs that moved it most
 * each way, in plain words.
 */
export interface NarrativeRationale {
  probabilityPct: number;
  calibratedPct: number | null;
  for: string[];
  against: string[];
}

const RATIONALE_MAX_ITEMS = 5;

/** A stored rationale read back defensively (a JSON column); null when it isn't one. */
export function parseNarrativeRationale(value: unknown): NarrativeRationale | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const list = (x: unknown): string[] | null =>
    Array.isArray(x)
      ? x.filter((s): s is string => typeof s === "string").slice(0, RATIONALE_MAX_ITEMS)
      : null;
  const pros = list(v.for);
  const cons = list(v.against);
  if (!pros || !cons || typeof v.probabilityPct !== "number" || !Number.isFinite(v.probabilityPct))
    return null;
  return {
    probabilityPct: v.probabilityPct,
    calibratedPct:
      typeof v.calibratedPct === "number" && Number.isFinite(v.calibratedPct) ? v.calibratedPct : null,
    for: pros,
    against: cons,
  };
}
