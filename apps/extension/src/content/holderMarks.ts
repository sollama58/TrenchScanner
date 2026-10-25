import { mintsIn } from "../shared/mint";
import { colorsOf, type TooltipPrefs } from "../shared/tooltip";
import type { OverlayBubbleHolder, OverlayBubbleMap, Site } from "../shared/types";
import { isTokenPage, pageMint } from "./tokenPage";

/**
 * Our wallet markers on a coin's page (user ask 2026-10-25): beside each wallet the page names
 * that is among the coin's top holders on TrenchScanner's bubble map, a small chip with what the
 * map knows of it (its cluster, same-minute funding, sniper, fresh or block-zero wallet, CEX
 * funding, ties to the dev). A chip opens the bubble map tab. The holders list is the target, but
 * any place on the page that names such a wallet gets one, the trades list included.
 *
 * A wallet is found by a link naming it in full (an explorer or the site's own wallet page), or by
 * text that is the full address or its short form ("2Q3j…PryF") matching one top holder only. The
 * chips sit in closed shadow roots and are written with DOM calls only.
 */

/** The coin's map is read again this often while its page is open. */
const MAP_MS = 60_000;
/** The page is looked over at most this often, however much it re-renders. */
const SCAN_MS = 600;
/** A short form: up to 6 characters, an ellipsis, up to 6 characters. */
const SHORT = /^([1-9A-HJ-NP-Za-km-z]{3,6})\s?(?:\.{2,3}|…)\s?([1-9A-HJ-NP-Za-km-z]{3,6})$/;
const FULL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cluster colours, by cluster index: one per funder on the map. */
const CLUSTER_COLORS = [
  "#ff7a35",
  "#3fd7c9",
  "#b48cff",
  "#ffd166",
  "#ff5fa2",
  "#5cc8ff",
  "#8be36b",
  "#ff9b6a",
];

const CHIP_CSS = `
:host { all: initial; display: inline-flex; vertical-align: middle; margin-left: 4px; }
button { all: unset; cursor: pointer; display: inline-flex; gap: 3px; align-items: center; }
b { font: 600 9.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 0 4px; border-radius: 4px;
  color: var(--t); background: color-mix(in srgb, var(--t) 16%, transparent); border: 1px solid color-mix(in srgb, var(--t) 45%, transparent); }
button:focus-visible { outline: 2px solid var(--c-link); outline-offset: 1px; border-radius: 4px; }
`;

interface Tag {
  text: string;
  color: string;
  why: string;
}

/** What the map says of one holder, as chips; none for a plain one. */
export function holderTags(
  holder: OverlayBubbleHolder,
  map: OverlayBubbleMap,
  colors: { risk: string; mid: string; link: string },
): Tag[] {
  const tags: Tag[] = [];
  if (holder.cluster !== null) {
    const c = map.clusters[holder.cluster];
    tags.push({
      text: `C${holder.cluster + 1}`,
      color: CLUSTER_COLORS[holder.cluster % CLUSTER_COLORS.length]!,
      why: c
        ? `Cluster ${holder.cluster + 1}: ${c.count} wallets one funder paid for, ${c.pct.toFixed(1)}% of supply${c.creatorLinked ? ", linked to the creator" : ""}`
        : `Cluster ${holder.cluster + 1}`,
    });
  }
  if (holder.sameTime !== null)
    tags.push({ text: "SAME", color: colors.mid, why: "Funded in the same minute as other top holders" });
  if (holder.trait === "blockZero")
    tags.push({ text: "B0", color: colors.risk, why: "Bought in the launch block" });
  if (holder.trait === "sniper") tags.push({ text: "SNPR", color: colors.risk, why: "Sniper" });
  if (holder.trait === "fresh") tags.push({ text: "FRESH", color: colors.mid, why: "Fresh wallet" });
  if (holder.trait === "empty")
    tags.push({ text: "EMPTY", color: colors.mid, why: "Wallet holding nothing else" });
  if (holder.cex) tags.push({ text: "CEX", color: colors.link, why: "Funded from an exchange" });
  if (holder.creatorTied) tags.push({ text: "DEV", color: colors.risk, why: "Tied to the dev" });
  return tags;
}

/** The holder a piece of text names: its full address, or a short form only one holder fits. */
export function holderNamed(text: string, holders: ReadonlyMap<string, OverlayBubbleHolder>): string | null {
  const t = text.trim();
  if (FULL.test(t)) return holders.has(t) ? t : null;
  const short = SHORT.exec(t);
  if (!short) return null;
  let found: string | null = null;
  for (const wallet of holders.keys()) {
    if (!wallet.startsWith(short[1]!) || !wallet.endsWith(short[2]!)) continue;
    if (found) return null;
    found = wallet;
  }
  return found;
}

export class HolderMarks {
  private observer: MutationObserver | null = null;
  private timer: number | undefined;
  private urlTimer: number | undefined;
  private lastScan = 0;
  private mint: string | null = null;
  private map: OverlayBubbleMap | null = null;
  private mapAt = 0;
  private reading = false;
  private holders = new Map<string, OverlayBubbleHolder>();
  /** Each marked element, its chip and the wallet it names. */
  private readonly marks = new Map<Element, { host: HTMLElement; wallet: string; key: string }>();

  constructor(
    private readonly site: Site,
    private prefs: TooltipPrefs,
    private readonly deps: {
      holders(mint: string): Promise<OverlayBubbleMap | null>;
      openMap(): void;
    },
  ) {}

  start(): void {
    this.observer = new MutationObserver((records) => {
      // Our own chips coming and going are no reason to look again.
      if (
        records.every((r) =>
          [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeName === "TRENCH-OVERLAY-HOLDER"),
        )
      )
        return;
      this.schedule();
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Single-page sites change coin without a reload.
    this.urlTimer = window.setInterval(() => this.schedule(), 1_000);
    this.schedule();
  }

  stop(): void {
    this.observer?.disconnect();
    window.clearInterval(this.urlTimer);
    window.clearTimeout(this.timer);
    this.clear();
  }

  applyPrefs(prefs: TooltipPrefs): void {
    this.prefs = prefs;
    for (const mark of this.marks.values()) mark.key = "";
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.lastScan + SCAN_MS - Date.now());
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.lastScan = Date.now();
      this.sync();
    }, wait);
  }

  private clear(): void {
    for (const mark of this.marks.values()) mark.host.remove();
    this.marks.clear();
  }

  private sync(): void {
    const on = this.prefs.holderMarks.enabled && isTokenPage(this.site, location.pathname);
    const mint = on ? pageMint(document, this.site, location.pathname) : null;
    if (mint !== this.mint) {
      this.mint = mint;
      this.map = null;
      this.holders.clear();
      this.mapAt = 0;
      this.clear();
    }
    if (!mint) return;
    if (!this.reading && Date.now() - this.mapAt >= MAP_MS) void this.load(mint);
    this.mark();
  }

  private async load(mint: string): Promise<void> {
    this.reading = true;
    const map = await this.deps.holders(mint).catch(() => null);
    this.reading = false;
    this.mapAt = Date.now();
    if (mint !== this.mint) return;
    this.map = map;
    this.holders = new Map((map?.holders ?? []).map((h) => [h.wallet, h]));
    for (const mark of this.marks.values()) mark.key = "";
    this.mark();
  }

  /** Puts a chip beside each wallet the map knows something of, and takes away stale ones. */
  private mark(): void {
    const seen = new Set<Element>();
    if (this.map && this.holders.size > 0) {
      for (const [el, wallet] of this.findWallets()) {
        const holder = this.holders.get(wallet)!;
        const tags = holderTags(holder, this.map, colorsOf(this.prefs));
        if (tags.length === 0) continue;
        seen.add(el);
        this.chip(el, wallet, holder, tags);
      }
    }
    for (const [el, mark] of this.marks) {
      if (seen.has(el) && el.isConnected) continue;
      mark.host.remove();
      this.marks.delete(el);
    }
  }

  /** The page's elements that name a top holder: links naming one in full, then text naming one. */
  private findWallets(): Map<Element, string> {
    const found = new Map<Element, string>();
    for (const link of document.body.querySelectorAll("a[href]")) {
      if (link.closest("trench-overlay-holder")) continue;
      const wallet = mintsIn(link.getAttribute("href") ?? "").find((w) => this.holders.has(w));
      if (wallet && wallet !== this.mint) found.set(link, wallet);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (text.length < 7 || text.length > 50) continue;
      const wallet = holderNamed(text, this.holders);
      const el = node.parentElement;
      if (!wallet || !el || wallet === this.mint) continue;
      // Inside a link already marked, the link speaks for it.
      if ([...found.keys()].some((l) => l.contains(el))) continue;
      found.set(el, wallet);
    }
    return found;
  }

  private chip(el: Element, wallet: string, holder: OverlayBubbleHolder, tags: Tag[]): void {
    const key = `${wallet}|${tags.map((t) => `${t.text}${t.color}`).join(",")}|${holder.pct}`;
    let mark = this.marks.get(el);
    if (mark && mark.key === key && mark.host.previousSibling === el) return;
    if (!mark) {
      const host = document.createElement("trench-overlay-holder");
      host.attachShadow({ mode: "closed" });
      mark = { host, wallet, key: "" };
      this.marks.set(el, mark);
    }
    if (mark.key !== key) {
      mark.key = key;
      mark.wallet = wallet;
      const fresh = document.createElement("trench-overlay-holder");
      const root = fresh.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      const c = colorsOf(this.prefs);
      style.textContent = `${CHIP_CSS} :host { --c-link: ${c.link}; }`;
      const button = document.createElement("button");
      button.type = "button";
      button.title = [
        `TrenchScanner bubble map: ${holder.pct.toFixed(2)}% of supply`,
        ...tags.map((t) => t.why),
        "Click to open the bubble map",
      ].join("\n");
      for (const tag of tags) {
        const b = document.createElement("b");
        b.textContent = tag.text;
        b.style.setProperty("--t", tag.color);
        button.append(b);
      }
      button.addEventListener("click", (e) => {
        // A chip inside the site's row link would otherwise follow it too.
        e.preventDefault();
        e.stopPropagation();
        this.deps.openMap();
      });
      root.append(style, button);
      mark.host.replaceWith(fresh);
      mark.host = fresh;
    }
    if (mark.host.previousSibling !== el) el.after(mark.host);
  }
}
