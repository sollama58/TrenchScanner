import { NARRATIVE_CONTESTANT } from "./contestants.js";
import { liveCallRecords, loadCurrentLanes } from "./laneStore.js";
import { emptyRecord, type CallRecord } from "./leaderboard.js";

/**
 * Whether the Narrative seat's "agrees"/"warns" note on other models' cards (dashboard pill and
 * Telegram line) shows by default. A user who set the Customize toggle keeps their choice; for
 * everyone else it turns on once the seat proves itself live (user decision 2026-10-08): its 2x
 * hit rate over the Models tab's default 7-day window above NARRATIVE_NOTE_MIN_RATE_PCT, on at
 * least NARRATIVE_NOTE_MIN_GRADED graded calls so a few lucky calls can't flip it, and back off
 * if the rate falls under it again.
 */
export const NARRATIVE_NOTE_MIN_RATE_PCT = 40;
export const NARRATIVE_NOTE_MIN_GRADED = 20;
export const NARRATIVE_NOTE_WINDOW_DAYS = 7;

export interface NarrativeNoteReadiness {
  /** The note shows for users who haven't set the toggle. */
  ready: boolean;
  /** The seat's live 2x hit rate over the window, in percent; null with nothing graded. */
  winRatePct: number | null;
  graded: number;
  minRatePct: number;
  minGraded: number;
  windowDays: number;
}

/** The readiness a live record makes: the same raw 2x rate the Models tab shows. */
export function narrativeNoteReadiness(record: CallRecord): NarrativeNoteReadiness {
  const winRatePct = record.graded > 0 ? (record.wins / record.graded) * 100 : null;
  return {
    ready:
      record.graded >= NARRATIVE_NOTE_MIN_GRADED &&
      winRatePct !== null &&
      winRatePct > NARRATIVE_NOTE_MIN_RATE_PCT,
    winRatePct,
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
    return narrativeNoteReadiness(records.get(NARRATIVE_CONTESTANT) ?? emptyRecord());
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
