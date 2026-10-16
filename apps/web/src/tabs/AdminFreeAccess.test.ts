import { describe, expect, it } from "vitest";
import { disablePhrase, timesProblem, toLocalInput } from "./AdminFreeAccess";

describe("Free Access admin form", () => {
  const now = new Date(2026, 9, 16, 12, 0);
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

  it("writes a date the way a datetime-local input reads it, in local time", () => {
    expect(toLocalInput(new Date(2026, 0, 5, 7, 3))).toBe("2026-01-05T07:03");
    expect(new Date(toLocalInput(now)).getTime()).toBe(now.getTime());
  });

  it("checks the times the way the API does", () => {
    expect(timesProblem(at(0), at(1), at(2), now)).toBeNull();
    expect(timesProblem(new Date(""), at(1), at(2), now)).toMatch(/all three/);
    expect(timesProblem(at(1), at(1), at(2), now)).toMatch(/close after/);
    expect(timesProblem(at(0), at(2), at(1), now)).toMatch(/before sign-in closes/);
    expect(timesProblem(at(-3), at(-2), at(-1), now)).toMatch(/future/);
    expect(timesProblem(at(0), at(1), at(91 * 24), now)).toMatch(/90 days/);
  });

  it("makes the switch-off's typed confirmation name the deletions it runs", () => {
    expect(disablePhrase(3)).toBe("DELETE 3");
    expect(disablePhrase(0)).toBe("END FREE ACCESS");
  });
});
