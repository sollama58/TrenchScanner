import { describe, expect, it } from "vitest";
import { adminWalletSet, corsOriginList } from "./env.js";
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
