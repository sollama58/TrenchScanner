import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { themeColorFor } from "./appearance";
import { MiddleCell, OLD_NUMBERS_TITLE } from "./components/MarketBar";
import { DEFAULT_EXPIRY_HOURS, EXPIRY_OPTIONS } from "./tabs/AdminAnnouncements";

// Audit 2026-11-28, the site's low-severity safe fixes (WB-65, WB-70).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the browser bar's colour (WB-70)", () => {
  it("is the page colour of the theme showing", () => {
    expect(themeColorFor("dark", true)).toBe("#07080c");
    expect(themeColorFor("light", false)).toBe("#f4f5f9");
    expect(themeColorFor("auto", true)).toBe("#f4f5f9");
    expect(themeColorFor("auto", false)).toBe("#07080c");
  });

  it("uses the stylesheet's two page colours, and index.html starts on the dark one", () => {
    const pages = [...read("./styles.css").matchAll(/^ {2}--page: (#[0-9a-f]{6});/gm)].map((m) => m[1]);
    expect(pages.slice(0, 2)).toEqual([themeColorFor("dark", false), themeColorFor("light", false)]);
    const html = read("../index.html");
    expect(html).toContain(`<meta name="theme-color" content="${themeColorFor("dark", false)}" />`);
  });
});

describe("the market bar while its refresh is failing (WB-65)", () => {
  it("dims the last numbers and says why; a working bar is not dimmed", () => {
    const old = renderToStaticMarkup(<MiddleCell prices={null} trench={null} trenchFailed={false} old />);
    expect(old).toContain('class="mkt-cell mkt-mid stale"');
    expect(old).toContain(OLD_NUMBERS_TITLE.replace("'", "&#x27;"));
    const fresh = renderToStaticMarkup(<MiddleCell prices={null} trench={null} trenchFailed={false} />);
    expect(fresh).toContain('class="mkt-cell mkt-mid"');
    expect(fresh).not.toContain("stale");
  });
});

describe("the announcement form (WB-70)", () => {
  it("opens on an expiry, not on 'Until I end it'", () => {
    expect(DEFAULT_EXPIRY_HOURS).toBeGreaterThan(0);
    expect(EXPIRY_OPTIONS.map((o) => o.hours)).toContain(DEFAULT_EXPIRY_HOURS);
    expect(EXPIRY_OPTIONS.map((o) => o.hours)).toContain(0);
  });
});
