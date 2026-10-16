import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { raisedAt, wantedBy } from "./alerts";

const at = (hhmm: string) => `2026-10-16T${hhmm}:00.000Z`;

/** Just the fields raisedAt and wantedBy read. */
function card(kind: Card["kind"], matchedAt: string, calls: string[] | null): Card {
  return {
    kind,
    matchedAt,
    curated: calls ? { alertedAt: calls[0], calledBy: calls.map((alertedAt) => ({ alertedAt })) } : null,
  } as unknown as Card;
}

describe("raisedAt", () => {
  it("dates a filter alert a later call made both by that call", () => {
    // The filter alerted at 12:00, the model called at 12:20: news at 12:20.
    expect(raisedAt(card("match", at("12:00"), [at("11:00"), at("12:20")]))).toBe(Date.parse(at("12:20")));
  });

  it("keeps the filter alert's time when the call came first, and a lone alert's own time", () => {
    expect(raisedAt(card("match", at("12:00"), [at("10:00")]))).toBe(Date.parse(at("12:00")));
    expect(raisedAt(card("match", at("12:00"), null))).toBe(Date.parse(at("12:00")));
    expect(raisedAt(card("curated", at("12:00"), [at("12:00")]))).toBe(Date.parse(at("12:00")));
  });
});

describe("wantedBy", () => {
  const only = (filterMatches: boolean, modelCalls: boolean) => ({ filterMatches, modelCalls });

  it("announces a filter alert wearing a call under either choice", () => {
    const both = card("match", at("12:00"), [at("12:20")]);
    expect(wantedBy(both, only(false, true))).toBe(true);
    expect(wantedBy(both, only(true, false))).toBe(true);
    expect(wantedBy(both, only(false, false))).toBe(false);
  });

  it("keeps a lone filter alert and a lone call to their own choice", () => {
    expect(wantedBy(card("match", at("12:00"), null), only(false, true))).toBe(false);
    expect(wantedBy(card("curated", at("12:00"), [at("12:00")]), only(true, false))).toBe(false);
  });
});
