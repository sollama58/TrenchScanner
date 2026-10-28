import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { wilsonBounds, wilsonLowerBound } from "./wilson.js";

const REPO = join(import.meta.dirname, "../../..");
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/core/scripts",
  "apps/api/src",
  "apps/worker/src",
  "apps/web/src",
];

/** Every non-test TypeScript source file under the roots, as repo-relative paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(relative(REPO, path));
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO, root));
  return out;
}

describe("wilsonBounds", () => {
  it("matches the textbook interval", () => {
    const { lower, upper } = wilsonBounds(10, 20, 1.96);
    expect(lower).toBeCloseTo(0.2993, 4);
    expect(upper).toBeCloseTo(0.7007, 4);
  });

  it("stays inside 0-1 at the extremes, within floating point", () => {
    const none = wilsonBounds(0, 30, 1.645);
    expect(none.lower).toBeCloseTo(0, 12);
    expect(none.upper).toBeGreaterThan(0);
    const all = wilsonBounds(30, 30, 1.645);
    expect(all.upper).toBeCloseTo(1, 12);
    expect(all.lower).toBeLessThan(1);
  });
});

describe("wilsonLowerBound", () => {
  it("reads 0 with nothing graded and the raw rate at z <= 0", () => {
    expect(wilsonLowerBound(5, 0, 1.96)).toBe(0);
    expect(wilsonLowerBound(3, 10, 0)).toBe(0.3);
  });

  it("is the interval's lower bound, never below 0", () => {
    expect(wilsonLowerBound(10, 20, 1.96)).toBe(wilsonBounds(10, 20, 1.96).lower);
    expect(wilsonLowerBound(0, 10, 1.645)).toBe(0);
  });
});

// Seven copies of the interval and an inline win test in 18 files meant a change to either had to
// be made everywhere (full audit 2026-10-27, CH-14). These keep them in one place each.
describe("one Wilson interval and one win test", () => {
  const files = sourceFiles();

  it("finds the sources it scans", () => {
    expect(files).toContain("packages/core/src/wilson.ts");
    expect(files).toContain("apps/web/src/rates.ts");
  });

  it("computes the interval only in wilson.ts", () => {
    // The margin term every copy had: sqrt(p(1 - p)/n + z²/(4n²)).
    const margin = /\/\s*\(4\s*\*\s*\w+\s*\*\s*\w+\)/;
    const copies = files.filter(
      (f) => f !== "packages/core/src/wilson.ts" && margin.test(readFileSync(join(REPO, f), "utf8")),
    );
    expect(copies).toEqual([]);
  });

  it("tests a win only through isWin", () => {
    const inline = /^(?!\s*(\*|\/\/)).*\blabelValue\s*>\s*0\b/m;
    const copies = files.filter(
      (f) => f !== "packages/core/src/curation/labels.ts" && inline.test(readFileSync(join(REPO, f), "utf8")),
    );
    expect(copies).toEqual([]);
  });
});
