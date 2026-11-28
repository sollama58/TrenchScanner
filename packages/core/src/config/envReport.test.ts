import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  describeEnvVar,
  ENV_MANIFEST,
  envReport,
  readEnvReport,
  unlistedEnvKind,
  type EnvService,
} from "./envReport.js";

interface RenderEnvVar {
  key?: string;
  fromGroup?: string;
}

/** The env var keys render.yaml gives each Node service, its shared group's included. */
function renderKeys(): Record<EnvService, Set<string>> {
  const doc = parse(
    readFileSync(fileURLToPath(new URL("../../../../render.yaml", import.meta.url)), "utf8"),
  ) as {
    envVarGroups: { name: string; envVars: RenderEnvVar[] }[];
    services: { name: string; envVars?: RenderEnvVar[] }[];
  };
  const groups = new Map(doc.envVarGroups.map((g) => [g.name, g.envVars]));
  const names: Record<string, EnvService> = {
    "trenchscanner-api": "api",
    "trenchscanner-worker": "scanner",
    "trenchscanner-trainer": "trainer",
  };
  const out: Record<EnvService, Set<string>> = { api: new Set(), scanner: new Set(), trainer: new Set() };
  for (const s of doc.services) {
    const service = names[s.name];
    if (!service) continue;
    for (const v of s.envVars ?? []) {
      for (const e of v.fromGroup ? (groups.get(v.fromGroup) ?? []) : [v]) if (e.key) out[service].add(e.key);
    }
  }
  return out;
}

describe("ENV_MANIFEST", () => {
  it("lists every variable render.yaml gives the api, the scanner and the trainer, on that service", () => {
    const keys = renderKeys();
    expect(keys.api.size).toBeGreaterThan(20);
    for (const service of ["api", "scanner", "trainer"] as const) {
      const listed = new Set(ENV_MANIFEST.filter((s) => s.on[service]).map((s) => s.key));
      const missing = [...keys[service]].filter((k) => !listed.has(k));
      expect(missing, `in render.yaml on ${service} but not in ENV_MANIFEST`).toEqual([]);
    }
  });

  it("names each variable once", () => {
    const keys = ENV_MANIFEST.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never treats a credential-looking name as a plain setting", () => {
    const risky = ENV_MANIFEST.filter(
      (s) => s.kind === "setting" && /(KEY|SECRET|TOKEN|PASSWORD|_URL|_URLS)$/.test(s.key),
    );
    expect(risky.map((s) => s.key)).toEqual([]);
  });

  it("shows no account identifier's value: wallets, buckets and storage endpoints are set or not", () => {
    const shown = ENV_MANIFEST.filter(
      (s) =>
        s.kind !== "identifier" &&
        s.kind !== "secret" &&
        /(WALLET_ADDRESS|WITHDRAW_TO|_BUCKET|S3_ENDPOINT)/.test(s.key),
    );
    expect(shown.map((s) => s.key)).toEqual([]);
  });
});

describe("describeEnvVar", () => {
  it("tells missing, empty and set apart", () => {
    expect(describeEnvVar("secret", undefined)).toEqual({ state: "missing", hint: null });
    expect(describeEnvVar("secret", "  ")).toEqual({ state: "empty", hint: null });
    expect(describeEnvVar("setting", " 8 ")).toEqual({ state: "set", hint: "8" });
  });

  it("gives a secret's length and a fingerprint, never the value", () => {
    const r = describeEnvVar("secret", "sk-very-secret-value");
    expect(r.hint).toBe("20 chars");
    expect(r.print).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(r)).not.toContain("secret-value");
    expect(describeEnvVar("secret", "other").print).not.toBe(r.print);
  });

  it("gives a URL's host only, dropping a key in its path or query", () => {
    const r = describeEnvVar("url", "https://mainnet.helius-rpc.com/v1/abc123?api-key=xyz");
    expect(r.hint).toBe("mainnet.helius-rpc.com");
    expect(JSON.stringify(r)).not.toMatch(/abc123|xyz/);
    const db = describeEnvVar("url", "postgresql://user:pw@db.internal:5432/ts");
    expect(db.hint).toBe("postgresql://db.internal");
    expect(describeEnvVar("url", "not a url").hint).toBe("set, not a URL");
  });

  it("says of an identifier only that it is set, with a fingerprint to compare services on", () => {
    const r = describeEnvVar("identifier", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(r).toEqual({ state: "set", hint: null, print: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(JSON.stringify(r)).not.toContain("7xKX");
    expect(describeEnvVar("identifier", "https://s3.eu-west-1.amazonaws.com").hint).toBeNull();
    expect(describeEnvVar("identifier", undefined)).toEqual({ state: "missing", hint: null });
  });

  it("cuts a long setting short", () => {
    expect(describeEnvVar("setting", "x".repeat(200)).hint).toHaveLength(80);
  });
});

describe("envReport / readEnvReport", () => {
  it("reports every manifest variable, and reads back only well-formed entries", () => {
    const r = envReport({ HELIUS_API_KEY: "abc", LIVE_TAPE_PAGES_PER_CYCLE: "8" });
    expect(Object.keys(r)).toHaveLength(ENV_MANIFEST.length);
    expect(r.HELIUS_API_KEY?.state).toBe("set");
    expect(r.LIVE_TAPE_PAGES_PER_CYCLE?.hint).toBe("8");
    expect(r.COINGECKO_API_KEY?.state).toBe("missing");
    const back = readEnvReport({ ...JSON.parse(JSON.stringify(r)), BAD: { state: "?" }, ODD: 3 });
    expect(back).toEqual(JSON.parse(JSON.stringify(r)));
    expect(readEnvReport(null)).toEqual({});
  });

  it("reports a schema key set outside the manifest, and never a credential-looking one's value (DB-3)", () => {
    // The owner's 11-11 decision lives only in the dashboard: no manifest row, so no report had it.
    expect(ENV_MANIFEST.some((s) => s.key === "CURATOR_CHAMPION_RULE")).toBe(false);
    const r = envReport({
      CURATOR_CHAMPION_RULE: "lower-bound",
      TRADING_JUPITER_API_KEY: "jup-secret-value",
      PATH: "/usr/bin",
      NOT_A_SCHEMA_KEY: "x",
    });
    expect(r.CURATOR_CHAMPION_RULE).toEqual({ state: "set", hint: "lower-bound" });
    expect(r.TRADING_JUPITER_API_KEY).toMatchObject({ state: "set", hint: null });
    expect(JSON.stringify(r)).not.toContain("jup-secret");
    // Only the schema's keys: the platform's own variables are not the product's settings.
    expect(r.PATH).toBeUndefined();
    expect(r.NOT_A_SCHEMA_KEY).toBeUndefined();
    // An unlisted key that is not set adds nothing.
    expect(Object.keys(envReport({}))).toHaveLength(ENV_MANIFEST.length);
    expect(unlistedEnvKind("FDSA_DAILY_BUDGET_USD")).toBe("setting");
    for (const key of [
      "X_API_KEY",
      "SOME_WEBHOOK",
      "RPC_URL",
      "FEE_WALLET",
      "ADMIN_CHAT_ID",
      "DB_PASSWORD",
    ]) {
      expect(unlistedEnvKind(key), key).toBe("identifier");
    }
  });
});
