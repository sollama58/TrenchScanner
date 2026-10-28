import { describe, expect, it } from "vitest";
import { buildEntryProof, entryLiftLow, ENTRY_PROOF_MIN_GRADED, provenOnEntry } from "./entryProof.js";
import { isPastCalling } from "./curator.js";

/** n rows where seat "a" scores `score` and `wins` of them doubled. */
function rows(n: number, wins: number, score: number, extra: Record<string, number> = {}) {
  return Array.from({ length: n }, (_, i) => ({ seatScores: { a: score, ...extra }, won: i < wins }));
}

describe("entry-row proof", () => {
  it("proves a seat whose moments at its cutoff clearly beat the entry base rate", () => {
    // Base: 60 wins in 400 (15%). Above the cutoff: 50 of 100 (Wilson low ~40%, lift low ~2.7).
    const proof = buildEntryProof([...rows(100, 50, 0.9), ...rows(300, 10, 0.1)]);
    expect(entryLiftLow(proof, "a", 0.5)).toBeGreaterThan(2);
    expect(provenOnEntry(proof, "a", 0.5)).toBe(true);
    // At a cutoff below every score, the seat's moments are the base itself: lift low under 1.
    expect(provenOnEntry(proof, "a", 0)).toBe(false);
  });

  it("holds a seat back on too few moments, a point lift alone, no record or no cutoff", () => {
    const thin = buildEntryProof([...rows(ENTRY_PROOF_MIN_GRADED - 1, 30, 0.9), ...rows(300, 30, 0.1)]);
    expect(entryLiftLow(thin, "a", 0.5)).toBeNull();
    expect(provenOnEntry(thin, "a", 0.5)).toBe(false);
    // 24% against a 20% base on 100 moments: lift 1.2, but its lower bound is under 1.
    const noisy = buildEntryProof([...rows(100, 24, 0.9), ...rows(400, 76, 0.1)]);
    expect(provenOnEntry(noisy, "a", 0.5)).toBe(false);
    expect(provenOnEntry(noisy, "b", 0.5)).toBe(false);
    expect(provenOnEntry(undefined, "a", 0.5)).toBe(false);
    expect(provenOnEntry(noisy, "a", undefined)).toBe(false);
  });

  it("measures every seat against the base of all graded entry moments", () => {
    // Seat b scores only the strong rows; its record is those, the base all 400.
    const proof = buildEntryProof([...rows(100, 50, 0.9, { b: 0.8 }), ...rows(300, 10, 0.1)]);
    expect(provenOnEntry(proof, "b", 0.5)).toBe(true);
    expect(proof.graded).toBe(400);
    expect(proof.wins).toBe(60);
  });
});

describe("isPastCalling", () => {
  it("stops calls from an hour of age or half an hour in the band; unknown readings don't count", () => {
    expect(isPastCalling({ ageMinutes: 60 })).toBe(true);
    expect(isPastCalling({ ageMinutes: 59.9, minutesSinceFirstInBand: 29.9 })).toBe(false);
    expect(isPastCalling({ minutesSinceFirstInBand: 30 })).toBe(true);
    expect(isPastCalling({})).toBe(false);
  });
});
