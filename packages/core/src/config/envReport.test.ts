import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { describeEnvVar, ENV_MANIFEST, envReport, readEnvReport, type EnvService } from "./envReport.js";

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
});
