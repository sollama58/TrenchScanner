import { describe, expect, it } from "vitest";
import { mixKey, sameMix } from "./feedCompare.js";

describe("mixKey", () => {
  it("reads the same models in any order, once each, as one mix", () => {
    expect(mixKey(["b", "a", "b"])).toBe("a,b");
    expect(sameMix(["forest", "sharp"], ["sharp", "forest"])).toBe(true);
    expect(sameMix(["forest"], ["forest", "sharp"])).toBe(false);
  });
});
