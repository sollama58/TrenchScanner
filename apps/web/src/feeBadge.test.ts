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
});
