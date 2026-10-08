import { describe, expect, it } from "vitest";
import { SettledAnswers } from "./settledAnswers.js";

describe("SettledAnswers", () => {
  it("returns only the keys it holds", () => {
    const answers = new SettledAnswers<boolean>(10);
    answers.remember("a", true);
    answers.remember("b", false);
    expect(answers.take(["a", "b", "c"])).toEqual(
      new Map([
        ["a", true],
        ["b", false],
      ]),
    );
  });

  it("drops the least recently used answer once full", () => {
    const answers = new SettledAnswers<number>(2);
    answers.remember("a", 1);
    answers.remember("b", 2);
    answers.take(["a"]);
    answers.remember("c", 3);
    expect(answers.size).toBe(2);
    expect([...answers.take(["a", "b", "c"]).keys()]).toEqual(["a", "c"]);
  });
});
