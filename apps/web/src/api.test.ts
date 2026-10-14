import { describe, expect, it } from "vitest";
import { apiUrlFor, runExamRates } from "./api";

describe("apiUrlFor", () => {
  it("sends trenchscanner.app pages to the API on its own subdomain", () => {
    expect(apiUrlFor("trenchscanner.app", "https://trenchscanner-api.onrender.com")).toBe(
      "https://api.trenchscanner.app",
    );
    expect(apiUrlFor("www.trenchscanner.app", "https://x")).toBe("https://api.trenchscanner.app");
    expect(apiUrlFor("WWW.TrenchScanner.app", "https://x")).toBe("https://api.trenchscanner.app");
  });

  it("keeps the configured API everywhere else", () => {
    expect(apiUrlFor("trenchscanner-web.onrender.com", "https://trenchscanner-api.onrender.com/")).toBe(
      "https://trenchscanner-api.onrender.com",
    );
    // A look-alike host is not the same site.
    expect(apiUrlFor("nottrenchscanner.app", "https://a")).toBe("https://a");
    expect(apiUrlFor("localhost", undefined)).toBe("http://localhost:4000");
  });
});

describe("runExamRates", () => {
  it("reads the held-out exam when the run stored one", () => {
    const r = runExamRates({ exam: { graded: 40, wins: 10, goals: 4 }, precisionCalibration: null });
    expect(r).toEqual({ calls: 40, winRatePct: 25, goalRatePct: 10, heldOut: true });
  });

  it("says so when it falls back to the in-sample calibration", () => {
    const r = runExamRates({
      exam: null,
      precisionCalibration: { threshold: 0.4, support: 30, winRatePct: 50, goalRatePct: 20 },
    });
    expect(r).toEqual({ calls: 30, winRatePct: 50, goalRatePct: 20, heldOut: false });
  });
});
