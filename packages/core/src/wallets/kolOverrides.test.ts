import { describe, expect, it } from "vitest";
import { KOL_MAINS, KOL_OVERRIDES, knownSideMain, normalizeKolName, type KolMain } from "./kolOverrides.js";

const MAIN: KolMain = { wallet: "Main1", name: "Cupsey", names: ["Cupsey", "Cupseyy"], twitter: ["Cupseyy"] };
const row = (wallet: string, name: string | null, twitter: string | null = null) => ({
  wallet,
  name,
  twitter,
});

describe("Known Sides", () => {
  it("normalizes roster names: case, spacing, punctuation and a trailing number", () => {
    expect(normalizeKolName("Cupsey 2")).toBe("cupsey");
    expect(normalizeKolName(" cupseyy! ")).toBe("cupseyy");
    expect(normalizeKolName(null)).toBe("");
  });

  it("sorts a KOL's other entries under its main wallet by name or X handle, never the main itself", () => {
    expect(knownSideMain(row("Main1", "Cupsey", "Cupseyy"), [MAIN])).toBeNull();
    expect(knownSideMain(row("Side1", "cupseyy"), [MAIN])?.wallet).toBe("Main1");
    expect(knownSideMain(row("Side2", "Cupsey alt 3"), [MAIN])).toBeNull();
    expect(knownSideMain(row("Side3", "C", "@cupseyy"), [MAIN])?.wallet).toBe("Main1");
    expect(knownSideMain(row("Other", "Ansem", "blknoiz06"), [MAIN])).toBeNull();
    expect(knownSideMain(row("Listed", "Anyone"), [{ ...MAIN, sides: ["Listed"] }])?.wallet).toBe("Main1");
  });

  it("names 2fg5…rx6f as Cupsey's main wallet", () => {
    expect(KOL_MAINS.find((m) => m.wallet === "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f")?.name).toBe(
      "Cupsey",
    );
  });
});

describe("KOL overrides", () => {
  it("names 7mHq…U1d3 as Kimba and 5sNn…V7gn as cryptovillian26", () => {
    expect(KOL_OVERRIDES.get("7mHqL9GzGnbsYLoHLDzB7FiHAZbND2CZCJYFvU9PU1d3")?.name).toBe("Kimba");
    expect(KOL_OVERRIDES.get("5sNnKuWKUtZkdC1eFNyqz3XHpNoCRQ1D1DfHcNHMV7gn")?.name).toBe("cryptovillian26");
  });
});
