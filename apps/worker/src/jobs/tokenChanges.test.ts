import { describe, expect, it } from "vitest";
import type { Token } from "@prisma/client";
import { tokenChanges } from "./scanJob.js";

const existing = {
  symbol: "DOG",
  name: "Dog",
  pairAddress: "pair1",
  imageUrl: "https://img/1.png",
  hasTwitter: true,
  hasTelegram: false,
  hasWebsite: false,
  firstInBandAt: new Date("2026-10-01T00:00:00Z"),
  narrativeTags: ["animal"],
} as unknown as Token;

describe("tokenChanges", () => {
  it("is empty when a re-scan changes nothing, so the row is not rewritten", () => {
    expect(
      tokenChanges(existing, {
        symbol: "DOG",
        name: "Dog",
        pairAddress: "pair1",
        imageUrl: undefined,
        hasTwitter: false,
        hasTelegram: false,
        firstInBandAt: new Date(),
        narrativeTags: ["animal"],
      }),
    ).toEqual({});
  });

  it("carries only what changed, keeping images, socials and firstInBandAt sticky", () => {
    expect(
      tokenChanges(existing, {
        symbol: undefined,
        name: "Dog 2",
        pairAddress: "pair1",
        imageUrl: "https://img/2.png",
        hasTelegram: true,
        narrativeTags: ["animal", "meme"],
      }),
    ).toEqual({
      name: "Dog 2",
      imageUrl: "https://img/2.png",
      hasTelegram: true,
      narrativeTags: ["animal", "meme"],
    });
  });

  it("with no row to compare, sets everything a re-scan may set", () => {
    const at = new Date();
    expect(
      tokenChanges(null, { symbol: "X", hasWebsite: true, firstInBandAt: at, narrativeTags: [] }),
    ).toEqual({
      symbol: "X",
      hasWebsite: true,
      firstInBandAt: at,
      narrativeTags: [],
    });
  });
});
