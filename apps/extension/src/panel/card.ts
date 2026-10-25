import { isMintAddress } from "../shared/mint";
import type { OverlaySafety, OverlaySettings, OverlayToken, Site } from "../shared/types";
import { firstAlert, type RowVerdict } from "../shared/verdict";

/**
 * One alerted token in the panel. Text from the token (names, filter names, the AI's reasoning)
 * is written with textContent only, never as HTML: whoever launched a token chose its name.
 * Site links are built from a valid mint only, on fixed hosts.
 */

export const SITE_NAMES: Record<Site, string> = { axiom: "Axiom", terminal: "Terminal", gmgn: "GMGN" };

/** Each site's token page (the same pages the web app links to, apps/web/src/appearance.ts). */
export function siteUrl(site: Site, mint: string): string {
  const m = encodeURIComponent(mint);
  if (site === "axiom") return `https://axiom.trade/t/${m}`;
  if (site === "terminal") return `https://trade.padre.gg/trade/solana/${m}`;
  return `https://gmgn.ai/sol/token/${m}`;
}

/** The coin's token view on TrenchScanner, bubble map and all (the site's ?token= link). */
export function trenchUrl(mint: string): string {
  return `https://trenchscanner.app/?token=${encodeURIComponent(mint)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(text: string, href: string, className = ""): HTMLAnchorElement {
  const a = el("a", className, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function line(left: string | Node, right: string, rightClass = ""): HTMLDivElement {
  const row = el("div", "line");
  const l = el("span", "l");
  l.append(left);
  row.append(l, el("span", `r ${rightClass}`.trim(), right));
  return row;
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** The square sizes the two image CDNs resize to (as apps/web/src/format.ts, checked 2026-10-14/23). */
const DEXSCREENER_SIZES = [64, 128, 160, 256, 800];
const PUMP_SIZES = [32, 40, 48, 64, 86, 96, 128, 256, 300, 400];

/**
 * Where to load a token's image from, in order: DexScreener's small thumbnail, Pump.fun's CDN for
 * a Pump.fun mint, then the launcher's own URL. https only; empty when there is nothing to show.
 */
export function imageSources(token: OverlayToken, size: number): string[] {
  const out: string[] = [];
  let url: URL | null;
  try {
    url = token.image ? new URL(token.image) : null;
  } catch {
    url = null;
  }
  if (
    url &&
    url.protocol === "https:" &&
    url.hostname === "cdn.dexscreener.com" &&
    url.searchParams.has("width")
  ) {
    const fit = DEXSCREENER_SIZES.find((s) => s >= size) ?? 800;
    if (fit < Number(url.searchParams.get("width"))) {
      const thumb = new URL(url);
      thumb.searchParams.set("width", String(fit));
      thumb.searchParams.set("height", String(fit));
      thumb.searchParams.set("quality", "80");
      out.push(thumb.toString());
    }
  }
  if (isMintAddress(token.mint) && token.mint.endsWith("pump")) {
    const fit = PUMP_SIZES.find((s) => s >= size) ?? 400;
    out.push(`https://images.pump.fun/coin-image/${token.mint}?variant=${fit}x${fit}`);
  }
  if (url && url.protocol === "https:") out.push(url.toString());
  return [...new Set(out)];
}

/** The token's image, moving to the next source on error, and its initials when none loads. */
function avatar(token: OverlayToken): HTMLElement {
  const box = el("span", "avatar", (token.symbol ?? "?").slice(0, 2).toUpperCase());
  const sources = imageSources(token, 64);
  if (sources.length === 0) return box;
  const img = el("img");
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  let next = 0;
  img.addEventListener("error", () => {
    if (next < sources.length) img.src = sources[next++]!;
    else img.remove();
  });
  img.addEventListener("load", () => box.classList.add("loaded"));
  img.src = sources[next++]!;
  box.append(img);
  return box;
}

/** The address, shortened, that copies the whole address when clicked. */
function copyButton(mint: string): HTMLButtonElement {
  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const button = el("button", "ca", short);
  button.type = "button";
  button.title = "Copy the contract address";
  button.setAttribute("aria-label", `Copy contract address ${short}`);
  let reset: number | undefined;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(mint).then(
      () => {
        button.textContent = "Copied";
        button.classList.add("done");
        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          button.textContent = short;
          button.classList.remove("done");
        }, 1200);
      },
      () => (button.textContent = "Copy failed"),
    );
  });
  return button;
}

/** The safety screen's verdict on the newest scan, and why it fails (user ask 2026-10-25). */
export function safetyLine(safety: OverlaySafety): HTMLElement {
  const row = line("Safety screen", safety.passed ? "Passed" : "Failed", safety.passed ? "up" : "down");
  if (safety.passed || safety.reasons.length === 0) return row;
  const box = el("div", "safety");
  const why = safety.reasons.map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join(". ");
  box.append(row, el("p", "safety-why", `${why}.`));
  return box;
}

/** When the token alerted this reader: its first call or match, as the card's "Alerted at" cap. */
export function alertedAt(token: OverlayToken): string | null {
  return firstAlert(token)?.at ?? null;
}

export function tokenCard(
  token: OverlayToken,
  verdict: RowVerdict,
  settings: OverlaySettings,
  now = Date.now(),
  /** The market cap the move is measured from, in place of the first alert's (Trade Buddy's entry). */
  anchor?: { label: string; mcapUsd: number | null; nowMcapUsd?: number | null; at?: string },
): HTMLElement {
  const card = el("article", `card ${verdict.ring ?? ""}`.trim());
  const valid = isMintAddress(token.mint);

  const head = el("div", "top");
  const name = el("div", "name");
  name.append(avatar(token), el("b", "", token.symbol ?? "?"));
  if (token.name && token.name !== token.symbol) name.append(el("span", "full", token.name));
  const when = anchor?.at ?? alertedAt(token);
  head.append(name, el("span", "when", when ? ago(when, now) : ""));
  card.append(head);

  const tags = el("div", "tags");
  for (const call of token.modelCalls) {
    const odds = call.calibratedPct === null ? "" : ` ${Math.round(call.calibratedPct)}%`;
    tags.append(el("span", "tag tm", `${call.name ?? call.model}${odds}`));
  }
  for (const match of token.filterMatches) tags.append(el("span", "tag tf", match.filterName));
  if (token.ai) {
    const buy = token.ai.decision === "buy";
    tags.append(el("span", `tag ${buy ? "tb" : "tn"}`, `AI ${token.ai.decision.toUpperCase()}`));
  }
  card.append(tags);

  const first = anchor ? anchor.mcapUsd : (firstAlert(token)?.mcapUsd ?? null);
  const nowMcap = anchor?.nowMcapUsd ?? token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
  const moved = first === null || nowMcap === null || first === 0 ? null : (nowMcap - first) / first;
  const change = moved === null ? "" : ` (${moved >= 0 ? "+" : ""}${Math.round(moved * 100)}%)`;
  // Green since the alert when up, red when down.
  const trend = moved === null ? "" : moved >= 0 ? "up" : "down";
  card.append(
    line(
      first === null ? "Market cap" : `${anchor?.label ?? "Alerted"} ${usd(first)}`,
      `now ${usd(nowMcap)}${change}`,
      trend,
    ),
  );

  if (token.safety) card.append(safetyLine(token.safety));

  if (verdict.flags.length > 0) {
    const flags = el("div", "flags");
    for (const flag of verdict.flags)
      flags.append(el("span", `chip ${flag.level}`, `${flag.short} ${flag.text}`));
    card.append(flags);
  }

  if (token.ai?.reasoning) {
    const why = el("details", "why");
    why.append(el("summary", "", "Why the AI said so"), el("p", "", token.ai.reasoning));
    card.append(why);
  }

  const foot = el("div", "foot");
  const open = el("div", "open");
  if (valid) {
    for (const site of Object.keys(SITE_NAMES) as Site[]) {
      if (settings.sites[site]) open.append(link(SITE_NAMES[site], siteUrl(site, token.mint), "site"));
    }
    open.append(link("TrenchScanner", trenchUrl(token.mint), "site ts"));
  }
  foot.append(open);
  if (valid) foot.append(copyButton(token.mint));
  card.append(foot);
  return card;
}
