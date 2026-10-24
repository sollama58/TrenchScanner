import { isMintAddress } from "../shared/mint";
import type { BuddyCoin, OverlaySettings, OverlayToken } from "../shared/types";
import { verdictFor } from "../shared/verdict";
import { ago, tokenCard } from "./card";

/**
 * Trade Buddy (user ask 2026-10-24): each coin the reader's wallet bought, from any venue, as its
 * token card with the PnL the site's TRADES panel prices, and for Pro Mode accounts a trade box,
 * collapsed until opened. The box never trades here: the extension holds no wallet. Each button
 * opens the coin's Trade panel on TrenchScanner filled in, where the wallet signs it as every Pro
 * trade is signed (2FA and the guard included).
 */

/** The buy amounts the box offers, in SOL, and the sell shares, in percent of the holding. */
export const BUY_PRESETS = [0.1, 0.25, 0.5, 1];
export const SELL_PRESETS = [25, 50, 100];

/** The coin's Trade panel on TrenchScanner, filled in with one side and amount; null for a bad mint. */
export function tradeUrl(mint: string, side: "buy" | "sell", amount: number): string | null {
  if (!isMintAddress(mint)) return null;
  const url = new URL("https://trenchscanner.app/");
  url.searchParams.set("trade", mint);
  url.searchParams.set(side, String(amount));
  return url.toString();
}

export function sol(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  return `${value.toFixed(abs >= 100 ? 0 : abs >= 1 ? 2 : 3)} SOL`;
}

/** Whole coins, shortened: 1.2M, 340K, 12.5. */
export function amount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(value >= 10 ? 0 : 1);
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

function row(left: string, right: string, rightClass = ""): HTMLDivElement {
  const line = el("div", "line");
  line.append(el("span", "l", left), el("span", `r ${rightClass}`.trim(), right));
  return line;
}

/** The token card's data for a coin with no scan yet: its name and picture alone. */
function bareToken(coin: BuddyCoin): OverlayToken {
  return {
    mint: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    image: coin.image,
    liveMcapUsd: coin.nowMcapUsd,
    stats: null,
    modelCalls: [],
    filterMatches: [],
    ai: null,
  };
}

/** The PnL lines: the result so far, what went in and out, and what the wallet holds. */
export function pnlBlock(coin: BuddyCoin): HTMLElement {
  const box = el("div", "pnl");
  if (coin.mismatch) {
    box.append(
      row("PnL", "Can't tell", "warn"),
      el(
        "p",
        "note",
        "Your wallet doesn't match the trades read for this coin (coins sent in, or a trade too old to read).",
      ),
    );
  } else {
    const up = (coin.pnlSol ?? 0) >= 0;
    const pctText = coin.pnlPct === null ? "" : ` (${up ? "+" : ""}${Math.round(coin.pnlPct)}%)`;
    const value = coin.pnlSol === null ? "–" : `${up ? "+" : ""}${sol(coin.pnlSol)}${pctText}`;
    box.append(row(coin.closed ? "Result" : "PnL", value, coin.pnlSol === null ? "" : up ? "up" : "down"));
  }
  const flows = `In ${sol(coin.spentSol)}${coin.gotSol > 0 ? ` · out ${sol(coin.gotSol)}` : ""}`;
  const held = coin.chainHeld ?? coin.held;
  box.append(row(coin.closed ? "Sold out" : `Holding ${amount(held)}`, flows));
  return box;
}

/** The Pro trade box: buy amounts and sell shares, each a link to the filled-in Trade panel. */
export function tradeBox(coin: BuddyCoin, symbol: string): HTMLDetailsElement {
  const box = el("details", "trade");
  box.append(el("summary", "", `Trade ${symbol}`));
  const buys = el("div", "presets");
  buys.append(el("span", "l", "Buy"));
  for (const amountSol of BUY_PRESETS) {
    const href = tradeUrl(coin.mint, "buy", amountSol);
    if (!href) continue;
    const a = el("a", "preset buy", `${amountSol} SOL`);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Open the Trade panel on TrenchScanner to buy ${amountSol} SOL of ${symbol}`;
    buys.append(a);
  }
  box.append(buys);
  if (!coin.closed) {
    const sells = el("div", "presets");
    sells.append(el("span", "l", "Sell"));
    for (const share of SELL_PRESETS) {
      const href = tradeUrl(coin.mint, "sell", share);
      if (!href) continue;
      const a = el("a", "preset sell", share === 100 ? "All" : `${share}%`);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `Open the Trade panel on TrenchScanner to sell ${share}% of your ${symbol}`;
      sells.append(a);
    }
    box.append(sells);
  }
  box.append(
    el("p", "note", "Opens TrenchScanner's Trade panel filled in. Your wallet confirms the trade there."),
  );
  return box;
}

/** One Trade Buddy coin: its token card with the entry as its anchor, the PnL, and the trade box. */
export function buddyCard(
  coin: BuddyCoin,
  settings: OverlaySettings,
  pro: boolean,
  now = Date.now(),
): HTMLElement {
  const token = coin.token ?? bareToken(coin);
  const card = tokenCard(token, verdictFor(token, settings), settings, now, {
    label: "Bought at",
    mcapUsd: coin.entryMcapUsd,
    nowMcapUsd: coin.nowMcapUsd,
    at: coin.lastTradeAt,
  });
  card.classList.add("buddy", coin.closed ? "closed" : "held");
  const when = card.querySelector(".when");
  if (when) {
    when.textContent = `${coin.closed ? "sold" : "bought"} ${ago(coin.closed ? coin.lastTradeAt : coin.entryAt, now)} ago`;
  }
  const foot = card.querySelector(".foot");
  const pnl = pnlBlock(coin);
  if (foot) card.insertBefore(pnl, foot);
  else card.append(pnl);
  if (pro && isMintAddress(coin.mint)) card.append(tradeBox(coin, token.symbol ?? "it"));
  if (coin.priceSource === "stored" && coin.priceAt && !coin.closed) {
    pnl.append(el("p", "note", `Priced at the last stored price, ${ago(coin.priceAt, now)} ago.`));
  }
  return card;
}
