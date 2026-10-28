import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Any animation that is running makes the browser draw a fresh frame of the whole page 60 times a
 * second, even a 7px opacity pulse on the compositor: the Live tab's "Scanning" dot, beating forever,
 * kept an idle dashboard at ~7% CPU (13% under the coin window) and the GPU busy, against ~1% still
 * (2026-10-28). So an animation that loops forever is only for a loading state, which ends by
 * itself, or for something under the pointer. Anything that stays on screen beats a few times
 * and rests.
 */
const LOOPING_ALLOWED = new Set([
  // Loading states.
  ".boot",
  ".page-loader-mark .logo-mark",
  ".page-loader-sweep",
  ".skeleton",
  ".card-skeleton",
  "img[data-loading]",
  ".tm-scanning",
  ".tm-chart-skeleton",
  ".bm-skeleton",
  ".search-field.busy .search-field-icon",
  ".skeleton-row",
  ".ld-spin",
  ".bm-loading-art circle",
  ".tm-trade-steps li.on i",
  ".x-sk-avatar",
  ".x-sk-lines span",
  ".asyl-loading",
  // Under the pointer, or the wallet the reader picked.
  ".bm-xfer.on .bm-xfer-flow",
  ".bm-xfer:hover .bm-xfer-flow",
  ".asyl-edge-g.hot .asyl-edge.asyl-edge-deploy",
  // The sign-in page's hero (user ask 2026-10-23), not the dashboard.
  ".this-is-fine-ring",
  ".this-is-fine-flame",
]);

/** The selectors of every rule that runs an animation forever, comments stripped. */
function loopingSelectors(css: string): string[] {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(text); m; m = rule.exec(text)) {
    const body = m[2]!;
    if (!/animation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(body)) continue;
    for (const sel of m[1]!.split(",")) out.push(sel.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("animations that never stop", () => {
  for (const file of ["styles.css", "asyl/asyl.css"]) {
    it(`${file} loops only loading states and pointer hovers`, () => {
      const css = readFileSync(resolve(import.meta.dirname, file), "utf8");
      const looping = loopingSelectors(css);
      expect(looping.length).toBeGreaterThan(0);
      expect(looping.filter((s) => !LOOPING_ALLOWED.has(s))).toEqual([]);
    });
  }

  it("finds a looping rule among others", () => {
    const css =
      ".a { color: red; }\n.b,\n.c:hover { animation: spin 1s linear infinite; }\n.d { animation: x 1s 3; }";
    expect(loopingSelectors(css)).toEqual([".b", ".c:hover"]);
  });
});
