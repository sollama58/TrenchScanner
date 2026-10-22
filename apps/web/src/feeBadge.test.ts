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

  // User ask 2026-10-21: the holder-reward tax sits beside the gift, as a percent.
  it("shows the holder-reward tax beside the gift as a percent", () => {
    const tax = (bps: number | null | undefined, destination = "holder_rewards") =>
      feeBadge({ destination, summary: null, bps })?.tax ?? null;
    expect(tax(5)).toBe("0.05%");
    expect(tax(100)).toBe("1%");
    expect(tax(300)).toBe("3%");
    expect(tax(95)).toBe("0.95%");
    expect(tax(10)).toBe("0.1%");
    expect(tax(null)).toBeNull();
    expect(tax(undefined)).toBeNull();
    expect(tax(0)).toBeNull();
    expect(tax(10001)).toBeNull();
    expect(tax(300, "wallet")).toBeNull();
    expect(tax(300, "charity")).toBeNull();
  });

  it("names the charity on the heart's tooltip when Pump.fun loaded one (user ask 2026-10-21)", () => {
    const name = "St. Jude Children's Research Hospital";
    const sentence = `Creator fees go to ${name}.`;
    expect(
      feeBadge({ destination: "charity", summary: "creator fees go to charity.", charityName: name })?.title,
    ).toBe(sentence);
    expect(
      creatorFeeLine({ destination: "charity", summary: "creator fees go to charity", charityName: name }),
    ).toBe(sentence);
    expect(feeBadge({ destination: "charity", summary: null, charityName: name })?.title).toBe(sentence);
    expect(sentence).toContain(name);
    expect(sentence).not.toBe("Creator fees go to charity.");
    expect(
      feeBadge({
        destination: "charity",
        summary: null,
        charityName: name,
        deskLine: "OTC Desks pays holder rewards in NVDAx.",
      })?.title,
    ).toBe(`${sentence} OTC Desks pays holder rewards in NVDAx.`);
    // A name on any other destination is not the heart, and is not shown there.
    expect(feeBadge({ destination: "creator", summary: null, charityName: name })?.title).toBe(
      "Creator fees go to the dev.",
    );
    // No organization yet: the generic sentence stays.
    expect(feeBadge({ destination: "charity", summary: "creator fees go to charity." })?.title).toBe(
      "Creator fees go to charity.",
    );
  });
});
