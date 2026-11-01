import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TAB_DATA, resolveTab, tabFromHash } from "./routes";

// The FDSA tab is hidden and admin-only (owner decision 2026-10-31, decision 7): it opens at #fdsa
// for an admin wallet and nowhere else, and nothing links to it or warms it.

const at = (hash: string) => vi.stubGlobal("window", { location: { hash } });
afterEach(() => vi.unstubAllGlobals());

describe("the hidden FDSA tab", () => {
  it("is what #fdsa asks for", () => {
    at("#fdsa");
    expect(tabFromHash()).toBe("fdsa");
    at("#fdsa/x");
    expect(tabFromHash()).toBe("live");
  });

  it("is drawn for an admin wallet only; anyone else gets the Live tab", () => {
    expect(resolveTab("fdsa", { isAdmin: true, portfolioOn: false })).toBe("fdsa");
    expect(resolveTab("fdsa", { isAdmin: false, portfolioOn: true })).toBe("live");
    expect(resolveTab("admin", { isAdmin: false, portfolioOn: false })).toBe("live");
    expect(resolveTab("portfolio", { isAdmin: true, portfolioOn: false })).toBe("live");
    expect(resolveTab("model", { isAdmin: false, portfolioOn: false })).toBe("model");
  });

  it("is never warmed, linked from the tab bar, or prefetched at boot", () => {
    expect(TAB_DATA.fdsa).toEqual([]);
    const app = readFileSync(resolve(import.meta.dirname, "App.tsx"), "utf8");
    // The tab bar is TABS (+ the Admin tab): FDSA is in neither.
    const tabs = app.slice(app.indexOf("const TABS"), app.indexOf("];", app.indexOf("const TABS")));
    expect(tabs).not.toMatch(/fdsa/i);
    expect(app).toMatch(/const tabs = isAdmin \? \[\.\.\.shownTabs, ADMIN_TAB\] : shownTabs;/);
    // Only the admin's own render loads its code.
    expect(app).toMatch(/tab === "fdsa" && isAdmin && <FdsaTab \/>/);
    const main = readFileSync(resolve(import.meta.dirname, "main.tsx"), "utf8");
    expect(main).not.toMatch(/fdsa/i);
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    expect(html).not.toMatch(/fdsa/i);
  });
});
