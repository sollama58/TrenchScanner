import panelCss from "../../static/panel.css";
import { bubbleMapView } from "../panel/bubble";
import { colorsOf, type TooltipPrefs } from "../shared/tooltip";
import type { BubbleAnswer, Site } from "../shared/types";
import { findTabStrip, isTokenPage, pageMint } from "./tokenPage";

/**
 * The bubble map as a tab on a coin's page (user ask 2026-10-25): a "Bubble map" tab at the end of
 * the site's own tab strip (Trades, Holders, Top Traders…) opens the coin's latest map over the
 * tab area, the same map the side panel draws. Without a strip it is a small button in the
 * corner. Everything sits in closed shadow roots and is written with DOM calls only.
 */

/** An open map is read again this often, as the side panel re-reads one. */
const REFRESH_MS = 30_000;

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

const MAP_CSS = `${panelCss.replace(/:root/g, ":host")}
:host { all: initial; position: fixed; z-index: 2147482000; display: block; color-scheme: dark; }
.shell { background: var(--bg); color: var(--ink); border: 1px solid #2a2d38; border-radius: 12px; overflow: auto;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 24px 60px -16px rgba(0,0,0,.85); padding: 10px 12px 12px;
  display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; height: 100%; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.title { font: 500 10.5px/1.6 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.close { all: unset; cursor: pointer; color: var(--dim); font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 5px; }
.close:hover { color: var(--ink); background: #1b1d25; }
.bm-svg { max-height: 420px; }
`;

export class MapTab {
  private readonly tabHost = document.createElement("trench-overlay-maptab");
  private readonly tabButton = document.createElement("button");
  private readonly tabVars = document.createElement("style");
  private readonly mapHost = document.createElement("trench-overlay-map");
  private readonly mapVars = document.createElement("style");
  private readonly shell = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly title = document.createElement("span");
  private observer: MutationObserver | null = null;
  private frame = 0;
  private urlTimer: number | undefined;
  private refreshTimer: number | undefined;
  private mint: string | null = null;
  private strip: Element | null = null;
  private open = false;
  private readAt = 0;

  constructor(
    private readonly site: Site,
    private readonly ask: (mint: string) => Promise<BubbleAnswer | null>,
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
    this.title.className = "title";
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close the bubble map");
    close.addEventListener("click", () => this.setOpen(false));
    top.append(this.title, close);
    this.shell.append(top, this.body);
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
    this.mapVars.textContent = `:host { --model: ${c.model}; --filter: ${c.filter}; --risk: ${c.risk}; --ok: ${c.ok}; --mid: ${c.mid}; --hi: ${c.hi}; }`;
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
      this.readAt = 0;
      if (this.open) void this.load();
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
    window.clearInterval(this.refreshTimer);
    if (!open) {
      this.mapHost.remove();
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
    void this.load();
    this.refreshTimer = window.setInterval(() => void this.load(), REFRESH_MS);
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

  private async load(): Promise<void> {
    const mint = this.mint;
    if (!mint) return;
    if (this.readAt === 0) {
      this.title.textContent = "TrenchScanner · bubble map";
      this.body.replaceChildren(note("Reading the map…"));
    }
    const answer = await this.ask(mint);
    if (mint !== this.mint || !this.open) return;
    this.readAt = Date.now();
    if (!answer) {
      if (!this.body.querySelector(".bubble"))
        this.body.replaceChildren(note("Couldn't reach TrenchScanner. Retrying…"));
      return;
    }
    if (answer.problem === "untracked") {
      this.body.replaceChildren(note("TrenchScanner hasn't scanned this coin."));
    } else if (answer.problem === "disconnected" || answer.problem === "refused") {
      this.body.replaceChildren(note("Connect the extension in its side panel to see bubble maps."));
    } else if (answer.problem !== null) {
      if (!this.body.querySelector(".bubble"))
        this.body.replaceChildren(note("Couldn't reach TrenchScanner. Retrying…"));
    } else {
      this.title.textContent = `TrenchScanner · ${answer.map?.symbol ?? "bubble map"}`;
      this.body.replaceChildren(bubbleMapView(answer.map));
    }
  }
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = text;
  return p;
}
