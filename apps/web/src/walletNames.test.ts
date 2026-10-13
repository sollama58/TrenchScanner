import { describe, expect, it } from "vitest";
import { walletText } from "./walletNames";

const W = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

describe("walletText", () => {
  it("shows a named wallet by its name, and any other by its short address", () => {
    expect(walletText(W, { [W]: { name: "Cupsey", source: "kol" } })).toBe("Cupsey");
    expect(walletText(W, {})).toBe("5tzF…uAi9");
    expect(walletText(W)).toBe("5tzF…uAi9");
    expect(walletText(null)).toBe("");
  });
});
