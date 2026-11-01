import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TAB_DATA, resolveTab, tabFromHash } from "./routes";

// The FDSA page (user ask 2026-11-01): any reader opens it at #fdsa, but nothing links to it or
// warms it. Its controls are Admin > FDSA, which only an admin wallet sees.

const at = (hash: string) => vi.stubGlobal("window", { location: { hash } });
afterEach(() => vi.unstubAllGlobals());

describe("the unlinked FDSA page", () => {
  it("is what #fdsa asks for", () => {
    at("#fdsa");
    expect(tabFromHash()).toBe("fdsa");
    at("#fdsa/x");
    expect(tabFromHash()).toBe("live");
  });

  it("is drawn for every reader; Admin stays an admin wallet's", () => {
    expect(resolveTab("fdsa", { isAdmin: true, portfolioOn: false })).toBe("fdsa");
    expect(resolveTab("fdsa", { isAdmin: false, portfolioOn: false })).toBe("fdsa");
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
    // Only opening it loads its code; the admin desk is its own chunk in Admin.
    expect(app).toMatch(/tab === "fdsa" && <FdsaTab \/>/);
    const page = readFileSync(resolve(import.meta.dirname, "tabs/FdsaTab.tsx"), "utf8");
    // The readers' page reads the readers' API and never the admin one, controls or spend.
    expect(page).toMatch(/`\/fdsa\?days=/);
    expect(page).not.toMatch(/\/admin\/fdsa|patch\(|post\(|costUsd|budget/);
    const main = readFileSync(resolve(import.meta.dirname, "main.tsx"), "utf8");
    expect(main).not.toMatch(/fdsa/i);
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    expect(html).not.toMatch(/fdsa/i);
  });
});
