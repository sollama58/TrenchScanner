import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The fine print states two cadences in words, and both had gone stale: "rescanned about every 30
 * seconds" with the scan on a one-minute cycle, and "every few hours each model retrains" with
 * training every 12 hours (program audit 2026-11-28, WB-62). The words are checked here against
 * the settings they describe, so changing either setting fails this until the words follow.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const finePrint = read("./AboutDetails.tsx").replace(/\s+/g, " ");

describe("the fine print's cadences", () => {
  it("says how often the band is rescanned, as render.yaml sets it", () => {
    const renderYaml = read("../../../../render.yaml");
    const minutes = /- key: SCAN_INTERVAL_MINUTES\s+value: "([\d.]+)"/.exec(renderYaml)?.[1];
    expect(minutes).toBe("1");
    expect(finePrint).toContain("rescanned about once a minute");
  });

  it("says how often the models retrain, as the config defaults it", () => {
    const env = read("../../../../packages/core/src/config/env.ts");
    const hours =
      /CURATOR_TRAINING_INTERVAL_HOURS: z\.coerce\.number\(\)\.min\([\d.]+\)\.default\((\d+)\)/.exec(
        env,
      )?.[1];
    expect(hours).toBe("12");
    // Not overridden for production: the default is what runs.
    expect(read("../../../../render.yaml")).not.toMatch(/- key: CURATOR_TRAINING_INTERVAL_HOURS\s+value:/);
    expect(finePrint).toContain("About twice a day each model retrains");
  });
});
