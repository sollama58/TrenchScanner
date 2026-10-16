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

  it("names 2iPg…qADtFM as Jdn", () => {
    expect(KOL_OVERRIDES.get("2iPgNgss7ow3v5YFkTpzABStfjFSyG3BGvP5sZqADtFM")?.name).toBe("Jdn");
  });

  it("names 5YRg…XRJQUzij as Slingoor", () => {
    expect(KOL_OVERRIDES.get("5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij")?.name).toBe("Slingoor");
  });

  it("names VJSD…FirUsy1 as Beanzz", () => {
    expect(KOL_OVERRIDES.get("VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1")?.name).toBe("Beanzz");
  });

  it("names bwam…PietdNfSXa as bwam_dev", () => {
    expect(KOL_OVERRIDES.get("bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa")?.name).toBe("bwam_dev");
  });

  it("names 4S8Y…nF5UuHA as shaka", () => {
    expect(KOL_OVERRIDES.get("4S8YBCt6hhi7Nr1NnKF6jF856LLN8JJFzD1a8nF5UuHA")?.name).toBe("shaka");
  });

  it("names ALau…1Ci31wE as Thurston", () => {
    expect(KOL_OVERRIDES.get("ALauG4FwEYDgSXd5Hen6kvuWSCdUi2fYNSNqM1Ci31wE")?.name).toBe("Thurston");
  });

  it("names 722t…Jv9x5VTx as caller100x", () => {
    expect(KOL_OVERRIDES.get("722tXm5uB5uuG2tC43uKHXQ7Pbyz75pTokEAJv9x5VTx")?.name).toBe("caller100x");
  });

  it("names Hi5y…LfuD2mqd as gambles.sol", () => {
    expect(KOL_OVERRIDES.get("Hi5yNvPSfagdja5xjYMTYWnnjSE3ze5KsezTLfuD2mqd")?.name).toBe("gambles.sol");
  });

  it("names 9tRf…dYH4TnAp as Woozy", () => {
    expect(KOL_OVERRIDES.get("9tRff7L6Mx3ZDNBoGPffdjD3c9JNzLc3nxzadYH4TnAp")?.name).toBe("Woozy");
  });

  it("names AuPp…nD45yqrf as Dani", () => {
    expect(KOL_OVERRIDES.get("AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf")?.name).toBe("Dani");
  });

  it("names DwCp…1cXYicWf as wizard", () => {
    expect(KOL_OVERRIDES.get("DwCp9GZw3ueoXPykHSPUkRZEwcTVbJH2i9Sf1cXYicWf")?.name).toBe("wizard");
  });

  it("names KJXB…cwxftvY as aightbet", () => {
    expect(KOL_OVERRIDES.get("KJXB1ot9nkCvq1ZD27vzNSBaPPCT82DpVnXrcwxftvY")?.name).toBe("aightbet");
  });
});
