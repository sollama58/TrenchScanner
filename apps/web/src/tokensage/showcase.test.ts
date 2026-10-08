import { describe, expect, it } from "vitest";
import { compact, hitRate, named, prettyLabel, share } from "./showcase";

describe("tokensage showcase helpers", () => {
  it("names codes in words", () => {
    expect(prettyLabel("animal/dog")).toBe("Animal › Dog");
    expect(prettyLabel("late_copy")).toBe("Late copy");
    expect(prettyLabel("ai_agent")).toBe("AI agent");
    expect(prettyLabel("x_link_reused")).toBe("X link reused");
  });

  it("compacts big counts", () => {
    expect(compact(1284)).toBe("1,284");
    expect(compact(12_940)).toBe("12.9K");
    expect(compact(245_000)).toBe("245K");
    expect(compact(1_240_000)).toBe("1.2M");
  });

  it("divides only when there is something to divide by", () => {
    expect(share(1, 4)).toBe("25%");
    expect(share(1, 0)).toBe("–");
  });

  it("holds a 2x rate back until enough calls are graded", () => {
    expect(hitRate({ graded: 19, won2x: 10 })).toBeNull();
    expect(hitRate({ graded: 40, won2x: 10 })).toBe(25);
  });

  it("drops the catch-all labels", () => {
    expect(named([{ label: "other" }, { label: "animal" }, { label: "uncategorized" }])).toEqual([
      { label: "animal" },
    ]);
  });
});
