import { describe, expect, it, vi } from "vitest";
import {
  adminWalletSet,
  appDomainForOrigin,
  appDomainList,
  corsOriginList,
  disabledGuards,
  loadEnv,
  resetEnvCacheForTests,
} from "./env.js";
import type { Env } from "./env.js";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_WALLET_ADDRESSES: "",
    CORS_ORIGINS: "",
    ...overrides,
  } as Env;
}

describe("adminWalletSet", () => {
  it("returns an empty set when unset - the Admin Panel is unreachable by default", () => {
    expect(adminWalletSet(baseEnv()).size).toBe(0);
  });

  it("parses a single address", () => {
    const set = adminWalletSet(
      baseEnv({ ADMIN_WALLET_ADDRESSES: "5BsFsz73yqe15X59thZnFEwPyE7NH3xP9ZvyZwNwf3Bz" }),
    );
    expect(set.has("5BsFsz73yqe15X59thZnFEwPyE7NH3xP9ZvyZwNwf3Bz")).toBe(true);
  });

  it("parses multiple comma-separated addresses and trims whitespace", () => {
    const set = adminWalletSet(baseEnv({ ADMIN_WALLET_ADDRESSES: " walletA , walletB ,walletC" }));
    expect(set).toEqual(new Set(["walletA", "walletB", "walletC"]));
  });

  it("drops empty entries from stray commas so they don't turn into a wildcard-like match", () => {
    const set = adminWalletSet(baseEnv({ ADMIN_WALLET_ADDRESSES: "walletA,,walletB," }));
    expect(set).toEqual(new Set(["walletA", "walletB"]));
    expect(set.has("")).toBe(false);
  });
});

// Same parsing shape as adminWalletSet - one shared regression guard for both list-style env vars.
describe("corsOriginList", () => {
  it("parses and trims a comma-separated list", () => {
    expect(corsOriginList(baseEnv({ CORS_ORIGINS: "https://a.example, https://b.example" }))).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("appDomainForOrigin", () => {
  const env = baseEnv({ PUBLIC_APP_DOMAIN: "holdex.live, trenchscanner-web.onrender.com" });

  it("lists every configured dashboard, first one first", () => {
    expect(appDomainList(env)).toEqual(["holdex.live", "trenchscanner-web.onrender.com"]);
  });

  it("binds a sign-in to the listed dashboard it came from", () => {
    expect(appDomainForOrigin(env, "https://trenchscanner-web.onrender.com")).toBe(
      "trenchscanner-web.onrender.com",
    );
    expect(appDomainForOrigin(env, "https://holdex.live")).toBe("holdex.live");
  });

  it("binds trenchscanner.app and its www host to themselves", () => {
    const prod = baseEnv({
      PUBLIC_APP_DOMAIN: "trenchscanner.app,www.trenchscanner.app,holdex.live,trenchscanner-web.onrender.com",
    });
    expect(appDomainForOrigin(prod, "https://trenchscanner.app")).toBe("trenchscanner.app");
    expect(appDomainForOrigin(prod, "https://www.trenchscanner.app")).toBe("www.trenchscanner.app");
    expect(appDomainForOrigin(prod, "https://holdex.live")).toBe("holdex.live");
  });

  it("falls back to the first listed domain for an unlisted, missing or malformed origin", () => {
    expect(appDomainForOrigin(env, "https://evil.example")).toBe("holdex.live");
    expect(appDomainForOrigin(env, undefined)).toBe("holdex.live");
    expect(appDomainForOrigin(env, "not a url")).toBe("holdex.live");
  });

  it("keeps the port, which is part of the SIWS domain", () => {
    const local = baseEnv({ PUBLIC_APP_DOMAIN: "localhost:5173" });
    expect(appDomainForOrigin(local, "http://localhost:5173")).toBe("localhost:5173");
    expect(appDomainForOrigin(local, "http://localhost:4000")).toBe("localhost:5173");
  });
});

describe("loadEnv", () => {
  it("cleans a TokenSage key pasted with spaces, quotes or a Bearer prefix", () => {
    for (const raw of ["  abc123 ", '"abc123"', "'abc123'", "Bearer abc123", " bearer  abc123\n"]) {
      resetEnvCacheForTests();
      expect(loadEnv({ DATABASE_URL: "postgres://x", TOKENSAGE_API_KEY: raw }).TOKENSAGE_API_KEY).toBe(
        "abc123",
      );
    }
    resetEnvCacheForTests();
  });

  it("seats the Narrative model on the TokenSage flag alone, so the trainer and the scanner agree", () => {
    resetEnvCacheForTests();
    expect(loadEnv({ DATABASE_URL: "postgres://x" }).CURATOR_CONTESTANTS).not.toContain("narrative");
    resetEnvCacheForTests();
    // The trainer has the flag but no key (render.yaml): it still trains the seat.
    expect(
      loadEnv({ DATABASE_URL: "postgres://x", TOKENSAGE_ENABLED: "true" }).CURATOR_CONTESTANTS,
    ).toContain("narrative");
    resetEnvCacheForTests();
    const on = loadEnv({
      DATABASE_URL: "postgres://x",
      TOKENSAGE_ENABLED: "true",
      TOKENSAGE_API_URL: "https://tokensage.example",
      TOKENSAGE_API_KEY: "k",
    });
    expect(on.CURATOR_CONTESTANTS).toContain("narrative");
    expect(on.CURATOR_CONTESTANTS).toContain("linear");
    resetEnvCacheForTests();
  });

  it("accepts 0 on the training guards, naming each one as off", () => {
    resetEnvCacheForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = loadEnv({
        DATABASE_URL: "postgres://x",
        CURATOR_EVOLUTION_MIN_AGE_HOURS: "0",
        CURATOR_CHAMPION_MIN_LIVE_GRADED: "0",
      });
      expect(env.CURATOR_EVOLUTION_MIN_AGE_HOURS).toBe(0);
      expect(env.CURATOR_CHAMPION_MIN_LIVE_GRADED).toBe(0);
      expect(disabledGuards(env)).toEqual([
        "CURATOR_EVOLUTION_MIN_AGE_HOURS",
        "CURATOR_CHAMPION_MIN_LIVE_GRADED",
      ]);
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((line) => line.includes("CURATOR_EVOLUTION_MIN_AGE_HOURS is 0"))).toHaveLength(1);
      expect(warned.filter((line) => line.includes("CURATOR_CHAMPION_MIN_LIVE_GRADED is 0"))).toHaveLength(1);
      expect(warned.some((line) => line.includes("CURATOR_GUARD_MAX_HOLD_HOURS"))).toBe(false);
    } finally {
      warn.mockRestore();
      resetEnvCacheForTests();
    }
  });

  it("refuses a JWT secret under 32 characters, the HS256 floor", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(31) })).toThrow(
      /32 characters/,
    );
    expect(loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) }).JWT_SECRET).toHaveLength(32);
  });

  it("treats a blank numeric var as unset, not 0", () => {
    resetEnvCacheForTests();
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      CURATED_CONTENDER_RETRY_MINUTES: "",
      MCAP_FILTER_MIN: "  ",
    });
    expect(env.CURATED_CONTENDER_RETRY_MINUTES).toBeGreaterThan(0);
    expect(env.MCAP_FILTER_MIN).toBeGreaterThan(0);
    resetEnvCacheForTests();
  });
});
