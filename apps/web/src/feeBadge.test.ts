import { describe, expect, it } from "vitest";
import { feeBadge } from "./components/AlertCard";

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
});
