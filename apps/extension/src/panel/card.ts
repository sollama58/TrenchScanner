import { isMintAddress } from "../shared/mint";
import type { OverlaySettings, OverlayToken, Site } from "../shared/types";
import type { RowVerdict } from "../shared/verdict";

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

/** When the token was last alerted for this reader. */
export function alertedAt(token: OverlayToken): string | null {
  const times = [...token.modelCalls.map((c) => c.at), ...token.filterMatches.map((m) => m.at)];
  return times.sort().at(-1) ?? null;
}

export function tokenCard(
  token: OverlayToken,
  verdict: RowVerdict,
  settings: OverlaySettings,
  now = Date.now(),
): HTMLElement {
  const card = el("article", `card ${verdict.ring ?? ""}`.trim());
  const valid = isMintAddress(token.mint);

  const head = el("div", "top");
  const name = el("div", "name");
  name.append(
    el("b", "", token.symbol ?? "?"),
    el("span", "mint", `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`),
  );
  const when = alertedAt(token);
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

  const first = token.modelCalls[0]?.mcapUsd ?? token.filterMatches[0]?.mcapUsd ?? null;
  const nowMcap = token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
  const change =
    first === null || nowMcap === null || first === 0
      ? ""
      : ` (${nowMcap >= first ? "+" : ""}${Math.round(((nowMcap - first) / first) * 100)}%)`;
  card.append(line(first === null ? "Market cap" : `Alerted ${usd(first)}`, `now ${usd(nowMcap)}${change}`));

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

  const open = el("div", "open");
  if (valid) {
    for (const site of Object.keys(SITE_NAMES) as Site[]) {
      if (settings.sites[site]) open.append(link(SITE_NAMES[site], siteUrl(site, token.mint), "site"));
    }
    open.append(
      link("TrenchScanner", `https://trenchscanner.app/?sage=${encodeURIComponent(token.mint)}`, "site ts"),
    );
  }
  card.append(open);
  return card;
}
