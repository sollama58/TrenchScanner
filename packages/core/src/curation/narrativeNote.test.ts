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
  it("turns on above a 40% hit rate once enough calls are graded", () => {
    expect(narrativeNoteReadiness(record(50, 21)).ready).toBe(true); // 42%
    expect(narrativeNoteReadiness(record(50, 20)).ready).toBe(false); // exactly 40% is not above it
    expect(narrativeNoteReadiness(record(50, 15)).ready).toBe(false);
  });

  it("can't flip on from a few lucky calls", () => {
    const few = NARRATIVE_NOTE_MIN_GRADED - 1;
    expect(narrativeNoteReadiness(record(few, few)).ready).toBe(false);
    expect(narrativeNoteReadiness(record(NARRATIVE_NOTE_MIN_GRADED, 10)).ready).toBe(true);
    expect(narrativeNoteReadiness(emptyRecord())).toMatchObject({
      ready: false,
      winRatePct: null,
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
