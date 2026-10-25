import { trenchUrl } from "../panel/card";
import { colorsOf, type TooltipPrefs } from "../shared/tooltip";
import type { Site } from "../shared/types";
import { findTabStrip, isTokenPage, pageMint } from "./tokenPage";

/**
 * The bubble map as a tab on a coin's page (user ask 2026-10-25): a "Bubble map" tab at the end of
 * the site's own tab strip (Trades, Holders, Top Traders…) opens the coin's latest map over the
 * tab area. Without a strip it is a small button in the corner. The map is the site's own
 * (map/page.ts), in a frame of the extension's map page, so none of its code or reads runs in the
 * site's page: it reads the coin through the key, and only while this tab is on. The tab and the
 * box sit in closed shadow roots and are written with DOM calls only.
 */

const TAB_CSS = `
:host { all: initial; display: inline-flex; align-items: center; flex: none; }
:host(.floating) { position: fixed; right: 16px; bottom: 16px; z-index: 2147482000; }
button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; height: 28px;
  font: 500 13.5px system-ui, -apple-system, "Segoe UI", sans-serif; color: #9aa0b2; border-radius: 6px; white-space: nowrap; }
:host(.floating) button { background: #111218; border: 1px solid #2a2d38; height: 32px; padding: 0 12px; box-shadow: 0 8px 24px -8px rgba(0,0,0,.7); }
button:hover, button.on { color: #eef0f6; }
button:focus-visible { outline: 2px solid var(--c-filter); outline-offset: 1px; }
i { width: 7px; height: 7px; border-radius: 50%; background: var(--c-filter); box-shadow: 0 0 6px var(--c-filter); }
`;

const MAP_CSS = `
:host { all: initial; position: fixed; z-index: 2147482000; display: block; color-scheme: dark; }
.shell { background: #0b0c10; color: #eef0f6; border: 1px solid #2a2d38; border-radius: 12px; overflow: hidden;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 24px 60px -16px rgba(0,0,0,.85);
  display: flex; flex-direction: column; box-sizing: border-box; height: 100%; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid #1d1f28; }
.title { font: 500 10.5px/1.6 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: #8a90a3; }
.acts { display: flex; align-items: center; gap: 4px; }
a { color: var(--c-filter); text-decoration: none; font-size: 12px; padding: 2px 6px; border-radius: 5px; }
a:hover { background: #1b1d25; }
.close { all: unset; cursor: pointer; color: #8a90a3; font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 5px; }
.close:hover { color: #eef0f6; background: #1b1d25; }
iframe { border: 0; width: 100%; flex: 1; min-height: 0; display: block; background: transparent; }
`;

export class MapTab {
  private readonly tabHost = document.createElement("trench-overlay-maptab");
  private readonly tabButton = document.createElement("button");
  private readonly tabVars = document.createElement("style");
  private readonly mapHost = document.createElement("trench-overlay-map");
  private readonly mapVars = document.createElement("style");
  private readonly shell = document.createElement("div");
  private readonly frameEl = document.createElement("iframe");
  private readonly siteLink = document.createElement("a");
  private observer: MutationObserver | null = null;
  private frame = 0;
  private urlTimer: number | undefined;
  private mint: string | null = null;
  /** The coin the frame shows, so a redraw of the page doesn't reload it. */
  private framed: string | null = null;
  private strip: Element | null = null;
  private open = false;

  constructor(
    private readonly site: Site,
    private prefs: TooltipPrefs,
  ) {
    const tabRoot = this.tabHost.attachShadow({ mode: "closed" });
    const tabStyle = document.createElement("style");
    tabStyle.textContent = TAB_CSS;
    this.tabButton.type = "button";
    this.tabButton.append(document.createElement("i"), "Bubble map");
    this.tabButton.title = "TrenchScanner's bubble map of this coin's holders";
    this.tabButton.addEventListener("click", () => this.toggle());
    tabRoot.append(tabStyle, this.tabVars, this.tabButton);

    const mapRoot = this.mapHost.attachShadow({ mode: "closed" });
    const mapStyle = document.createElement("style");
    mapStyle.textContent = MAP_CSS;
    this.shell.className = "shell";
    const top = document.createElement("div");
    top.className = "top";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "TrenchScanner · bubble map";
    this.siteLink.target = "_blank";
    this.siteLink.rel = "noopener noreferrer";
    this.siteLink.textContent = "Open on TrenchScanner ↗";
    this.frameEl.title = "TrenchScanner bubble map";
    const acts = document.createElement("span");
    acts.className = "acts";
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close the bubble map");
    close.addEventListener("click", () => this.setOpen(false));
    acts.append(this.siteLink, close);
    top.append(title, acts);
    this.shell.append(top, this.frameEl);
    mapRoot.append(mapStyle, this.mapVars, this.shell);
    this.applyColors();
  }

  start(): void {
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(document.body, { childList: true, subtree: true });
    // Single-page sites change coin without a reload.
    this.urlTimer = window.setInterval(() => this.schedule(), 1_000);
    this.schedule();
  }

  stop(): void {
    this.observer?.disconnect();
    window.clearInterval(this.urlTimer);
    cancelAnimationFrame(this.frame);
    this.setOpen(false);
    this.tabHost.remove();
  }

  applyPrefs(prefs: TooltipPrefs): void {
    this.prefs = prefs;
    this.applyColors();
    this.schedule();
  }

  private applyColors(): void {
    const c = colorsOf(this.prefs);
    this.tabVars.textContent = `:host { --c-filter: ${c.filter}; }`;
    this.mapVars.textContent = `:host { --c-filter: ${c.filter}; }`;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  /** Puts the tab where it belongs, or takes it away off a coin's page. */
  private sync(): void {
    const onPage = this.prefs.mapTab.enabled && isTokenPage(this.site, location.pathname);
    const mint = onPage ? pageMint(document, this.site, location.pathname) : null;
    if (mint !== this.mint) {
      this.mint = mint;
      if (this.open) this.load();
    }
    if (!mint) {
      this.setOpen(false);
      this.tabHost.remove();
      return;
    }
    this.strip = findTabStrip(document);
    if (this.strip) {
      this.tabHost.classList.remove("floating");
      if (this.tabHost.parentElement !== this.strip) this.strip.append(this.tabHost);
    } else {
      this.tabHost.classList.add("floating");
      if (this.tabHost.parentElement !== document.documentElement)
        document.documentElement.append(this.tabHost);
    }
    if (this.open) this.place();
  }

  private toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.tabButton.classList.toggle("on", open);
    if (!open) {
      this.mapHost.remove();
      // The closed map stops reading: its frame is emptied.
      this.frameEl.removeAttribute("src");
      this.framed = null;
      document.removeEventListener("keydown", this.onKey);
      window.removeEventListener("resize", this.onMove);
      window.removeEventListener("scroll", this.onMove, { capture: true });
      return;
    }
    document.documentElement.append(this.mapHost);
    document.addEventListener("keydown", this.onKey);
    window.addEventListener("resize", this.onMove);
    window.addEventListener("scroll", this.onMove, { capture: true, passive: true });
    this.place();
    this.load();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.setOpen(false);
  };
  private readonly onMove = () => this.place();

  /** Over the tab area: under the strip, as wide as its row, down to the window's edge. */
  private place(): void {
    const anchor = (this.strip?.parentElement ?? this.tabHost).getBoundingClientRect();
    const width = Math.min(Math.max(anchor.width, 420), 760, window.innerWidth - 16);
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8);
    const below = this.strip ? anchor.bottom + 4 : Math.max(8, anchor.top - 8 - 520);
    const top = Math.max(8, Math.min(below, window.innerHeight - 260));
    const height = Math.min(560, window.innerHeight - top - 8);
    Object.assign(this.mapHost.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  /** Points the frame at the open coin's map, unless it shows it already. */
  private load(): void {
    const mint = this.mint;
    if (!mint || mint === this.framed) return;
    this.framed = mint;
    this.siteLink.href = trenchUrl(mint);
    this.frameEl.src = chrome.runtime.getURL(`map.html?mint=${encodeURIComponent(mint)}&in=page`);
  }
}
