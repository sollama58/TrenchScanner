import { describe, expect, it } from "vitest";
import { accessEnded, apiUrlFor, runExamRates } from "./api";

describe("accessEnded", () => {
  it("is the access gate's 402, not a paid lookup's or any other error", () => {
    expect(accessEnded(402, { error: "subscription_required", expiresAt: null })).toBe(true);
    expect(accessEnded(402, { code: "lookup_required", error: "Look this up to open it" })).toBe(false);
    expect(accessEnded(401, { error: "subscription_required" })).toBe(false);
    expect(accessEnded(402, null)).toBe(false);
    expect(accessEnded(402, "subscription_required")).toBe(false);
  });
});

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

describe("withTimeout", () => {
  it("aborts after the time given, and follows the caller's own abort", async () => {
    const { withTimeout } = await import("./api");
    const t = withTimeout(undefined, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.signal.aborted).toBe(true);
    t.done();

    const own = new AbortController();
    const u = withTimeout(own.signal, 60_000);
    expect(u.signal.aborted).toBe(false);
    own.abort();
    expect(u.signal.aborted).toBe(true);
    u.done();
  });

  it("clears its timer when done", async () => {
    const { withTimeout } = await import("./api");
    const t = withTimeout(undefined, 10);
    t.done();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.signal.aborted).toBe(false);
  });
});
