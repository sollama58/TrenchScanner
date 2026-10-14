import { describe, expect, it } from "vitest";
import { emptyRecord } from "./leaderboard.js";
import {
  NARRATIVE_NOTE_MIN_GRADED,
  narrativeNoteChoice,
  narrativeNoteReadiness,
  parseNarrativeRationale,
  showsNarrativeNote,
} from "./narrativeNote.js";

const record = (graded: number, wins: number) => ({ ...emptyRecord(), calls: graded, graded, wins });

describe("the Narrative note's automatic default", () => {
  it("turns on only once the 90% interval's lower bound clears 40%", () => {
    // 60% of 50: the interval is about 48-71%, clear of 40%.
    expect(narrativeNoteReadiness(record(50, 30)).ready).toBe(true);
    // 42% of 50 is above 40% but its interval (about 31-54%) straddles it: not proven.
    expect(narrativeNoteReadiness(record(50, 21)).ready).toBe(false);
    expect(narrativeNoteReadiness(record(50, 15)).ready).toBe(false);
    const r = narrativeNoteReadiness(record(50, 30));
    expect(r.lowerPct!).toBeGreaterThan(40);
    expect(r.upperPct!).toBeGreaterThan(r.winRatePct!);
  });

  it("keeps its previous state inside the band, and turns off only when the upper bound drops below 40%", () => {
    // 42% of 50 is inside the band: it holds whatever it was.
    expect(narrativeNoteReadiness(record(50, 21), true).ready).toBe(true);
    expect(narrativeNoteReadiness(record(50, 21), false).ready).toBe(false);
    // 30% of 200: the interval (about 25-36%) is wholly below 40%, so it turns off.
    expect(narrativeNoteReadiness(record(200, 60), true).ready).toBe(false);
    // Clearly proven: on whatever it was.
    expect(narrativeNoteReadiness(record(200, 120), false).ready).toBe(true);
  });

  it("can't flip on from a few lucky calls", () => {
    const few = NARRATIVE_NOTE_MIN_GRADED - 1;
    expect(narrativeNoteReadiness(record(few, few)).ready).toBe(false);
    expect(narrativeNoteReadiness(record(few, few), true).ready).toBe(false);
    // 10 of 20 (50%) read on in the old rule; its interval (about 32-68%) proves nothing.
    expect(narrativeNoteReadiness(record(NARRATIVE_NOTE_MIN_GRADED, 10)).ready).toBe(false);
    expect(narrativeNoteReadiness(emptyRecord())).toMatchObject({
      ready: false,
      winRatePct: null,
      lowerPct: null,
      upperPct: null,
      graded: 0,
    });
  });

  it("gives way to the user's own toggle either way", () => {
    expect(showsNarrativeNote(null, true)).toBe(true);
    expect(showsNarrativeNote(null, false)).toBe(false);
    expect(showsNarrativeNote(false, true)).toBe(false);
    expect(showsNarrativeNote(true, false)).toBe(true);
  });

  it("reads the toggle off the stored appearance, unset when missing or unreadable", () => {
    expect(narrativeNoteChoice(null)).toBeNull();
    expect(narrativeNoteChoice({ theme: "dark" })).toBeNull();
    expect(narrativeNoteChoice({ narrativeNote: "yes" })).toBeNull();
    expect(narrativeNoteChoice({ narrativeNote: false })).toBe(false);
    expect(narrativeNoteChoice({ narrativeNote: true })).toBe(true);
  });
});

describe("parseNarrativeRationale", () => {
  it("reads a stored rationale and turns away anything else", () => {
    const stored = { probabilityPct: 41.2, calibratedPct: 38, for: ["X post fit"], against: ["late copy"] };
    expect(parseNarrativeRationale(stored)).toEqual(stored);
    expect(parseNarrativeRationale({ ...stored, calibratedPct: undefined })).toMatchObject({
      calibratedPct: null,
    });
    expect(parseNarrativeRationale({ ...stored, for: [1, "a"] })!.for).toEqual(["a"]);
    expect(parseNarrativeRationale(null)).toBeNull();
    expect(parseNarrativeRationale([])).toBeNull();
    expect(parseNarrativeRationale({ for: [], against: [] })).toBeNull();
  });
});
