import { describe, expect, it } from "vitest";
import { creatorFeeLine, feeBadge } from "./components/AlertCard";

describe("feeBadge", () => {
  it("names where the creator fee goes, one kind per destination", () => {
    const kind = (destination: string) => feeBadge({ destination, summary: null })?.kind ?? null;
    expect(kind("charity")).toBe("charity");
    expect(kind("holder_rewards")).toBe("rewards");
    expect(kind("wallet")).toBe("rewards");
    expect(kind("split")).toBe("rewards");
    expect(kind("cashback")).toBe("rewards");
    expect(kind("github")).toBe("github");
    expect(kind("creator")).toBe("dev");
  });

  it("shows nothing when the destination is unread or unknown", () => {
    expect(feeBadge(null)).toBeNull();
    expect(feeBadge(undefined)).toBeNull();
    expect(feeBadge({ destination: "unknown", summary: "creator fees go somewhere" })).toBeNull();
    expect(feeBadge({ destination: "other", summary: null })).toBeNull();
  });

  it("uses TokenSage's sentence as the tooltip, capitalized and stopped once", () => {
    expect(feeBadge({ destination: "charity", summary: "creator fees go to charity." })?.title).toBe(
      "Creator fees go to charity.",
    );
    expect(feeBadge({ destination: "creator", summary: null })?.title).toBe("Creator fees go to the dev.");
  });

  it("adds OTC Desks' reward coins to the tooltip and the token-details line when they are known", () => {
    const desk = "OTC Desks pays holder rewards in NVDAx.";
    expect(
      feeBadge({ destination: "wallet", summary: "creator fees go to a wallet", deskLine: desk })?.title,
    ).toBe("Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx.");
    expect(feeBadge({ destination: null, summary: null, deskLine: desk })).toMatchObject({
      kind: "rewards",
      title: desk,
    });
    expect(creatorFeeLine({ destination: null, summary: null, deskLine: desk })).toBe(desk);
    expect(feeBadge({ destination: null, summary: null })).toBeNull();
    expect(creatorFeeLine({ destination: "wallet", summary: null })).toBeNull();
  });

  it("lists every coin in a multi-coin OTC basket on the gift tooltip and the token-details line", () => {
    const desk = "OTC Desks pays holder rewards in NVDAx and TSLAx.";
    expect(
      feeBadge({ destination: "wallet", summary: "creator fees go to a wallet", deskLine: desk })?.title,
    ).toBe("Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx and TSLAx.");
    expect(feeBadge({ destination: null, summary: null, deskLine: desk })?.title).toContain("NVDAx");
    expect(feeBadge({ destination: null, summary: null, deskLine: desk })?.title).toContain("TSLAx");
    expect(creatorFeeLine({ destination: "holder_rewards", summary: null, deskLine: desk })).toBe(desk);
  });

  it("names the charity on the heart's tooltip when Pump.fun loaded one (user ask 2026-10-21)", () => {
    const name = "St. Jude Children's Research Hospital";
    expect(
      feeBadge({ destination: "charity", summary: "creator fees go to charity.", charityName: name })?.title,
    ).toBe(`${name}. Creator fees go to charity.`);
    expect(feeBadge({ destination: "charity", summary: null, charityName: name })?.title).toBe(
      `Creator fees go to ${name}.`,
    );
    expect(
      feeBadge({
        destination: "charity",
        summary: null,
        charityName: name,
        deskLine: "OTC Desks pays holder rewards in NVDAx.",
      })?.title,
    ).toBe(`Creator fees go to ${name}. OTC Desks pays holder rewards in NVDAx.`);
    // A name on any other destination is not the heart, and is not shown there.
    expect(feeBadge({ destination: "creator", summary: null, charityName: name })?.title).toBe(
      "Creator fees go to the dev.",
    );
  });
});
