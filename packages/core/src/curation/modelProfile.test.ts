import { describe, expect, it } from "vitest";
import { ACTIVE_CONTESTANT_IDS, contestantSpec } from "./contestants.js";
import { modelProfile } from "./modelProfile.js";

const profile = (id: string) => modelProfile(contestantSpec(id)!, 14);

describe("modelProfile", () => {
  it("draws every active seat with a goal, what it reads and how it decides", () => {
    for (const id of ACTIVE_CONTESTANT_IDS) {
      const p = profile(id);
      expect(p.goalText, id).toBeTruthy();
      expect(p.reads, id).toBeTruthy();
      expect(p.decides, id).toBeTruthy();
    }
  });

  it("reads each seat's recipe: goal, method, pickiness and memory", () => {
    expect(profile("trees")).toMatchObject({
      goal: "return",
      method: "trees",
      aimsToCallPct: null,
      memoryDays: 14,
    });
    expect(profile("linear-recent")).toMatchObject({ method: "formula", memoryDays: 3 });
    expect(profile("order-flow").reads).toBe("The last few minutes of trading");
    expect(profile("sharp-survivor")).toMatchObject({ goal: "2x", method: "two-step", aimsToCallPct: 12 });
    expect(profile("catcher")).toMatchObject({ goal: "catch", aimsToCallPct: 35 });
    expect(profile("return-regression")).toMatchObject({ method: "regression", aimsToCallPct: 12 });
    expect(profile("runner").goal).toBe("moonshot");
    expect(profile("trees-no-tokensage").reads).toBe("Every signal except TokenSage's read");
    expect(profile("gems").waitsFor).toBe("the Gemerald filter's go-ahead");
    expect(profile("narrative")).toMatchObject({
      method: "story",
      waitsFor: "TokenSage's deep read of the coin",
    });
  });

  it("draws the combiners and Rules as a team and a checklist, with no memory", () => {
    expect(profile("trader")).toMatchObject({
      goal: "team",
      method: "team",
      aimsToCallPct: 10,
      memoryDays: null,
    });
    expect(profile("consensus")).toMatchObject({ goal: "team", aimsToCallPct: null });
    expect(profile("rules")).toMatchObject({ goal: "rules", method: "rules", memoryDays: null });
  });
});
