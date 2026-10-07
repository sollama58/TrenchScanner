/**
 * The text of a Telegram alert. HTML parse mode, so every piece of token or filter text is
 * escaped: a coin named "<b>" must not format the message, let alone break it.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AlertToken {
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  firstSeenAt: Date | null;
}

export interface AlertSnapshot {
  marketCapUsd: number;
  holderCount: number | null;
  volume1hUsd: number | null;
}

/** One model's call on the token, as the message names it. */
export interface AlertCall {
  modelName: string;
  /** 0-100. */
  confidence: number;
  tier: string | null;
  /** The 2x rate of recent calls ranked like this one, in percent; null when unknown. */
  calibratedPct: number | null;
  reasons: string[];
  /** The Narrative seat's note on the card: "agrees" | "warns" | null. */
  narrativeVerdict: string | null;
}

/** Everything about one token that happened since the last look, folded into one message. */
export interface AlertCard {
  token: AlertToken;
  snapshot: AlertSnapshot | null;
  /** The user's filters that caught it (names), with the match score. */
  filters: { name: string; score: number }[];
  calls: AlertCall[];
  /** When the newest of the above was raised. */
  raisedAt: Date;
}

export interface AlertLinks {
  /** The dashboard, e.g. https://trenchscanner.app; empty for no link. */
  dashboardUrl: string;
}

export const MAX_REASONS = 3;

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

export function ageText(firstSeenAt: Date | null, now: number): string | null {
  if (!firstSeenAt) return null;
  const mins = Math.max(0, Math.round((now - firstSeenAt.getTime()) / 60_000));
  if (mins < 60) return `${mins}m old`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m old`;
  return `${Math.floor(hours / 24)}d old`;
}

function tokenLabel(t: AlertToken): string {
  if (t.symbol) return `$${t.symbol}`;
  if (t.name) return t.name;
  return `${t.mintAddress.slice(0, 4)}…${t.mintAddress.slice(-4)}`;
}

function tradeLinks(mint: string, links: AlertLinks): string {
  const m = encodeURIComponent(mint);
  const out: string[] = [];
  if (links.dashboardUrl)
    out.push(`<a href="${escapeHtml(links.dashboardUrl.replace(/\/$/, ""))}/#live">TrenchScanner</a>`);
  out.push(`<a href="https://trade.padre.gg/trade/solana/${m}">Terminal</a>`);
  out.push(`<a href="https://axiom.trade/t/${m}">Axiom</a>`);
  out.push(`<a href="https://gmgn.ai/sol/token/${m}">GMGN</a>`);
  return out.join(" · ");
}

/** The one-line "who raised it" headline. */
export function headline(card: AlertCard): string {
  const models = card.calls.map((c) => c.modelName);
  const filters = card.filters.map((f) => f.name);
  if (models.length > 0 && filters.length > 0) {
    return `${models.join(" + ")} called it and your filter caught it`;
  }
  if (models.length === 1) return `${models[0]} called it`;
  if (models.length > 1) return `${models.join(" + ")} called it`;
  if (filters.length === 1) return `caught by “${filters[0]}”`;
  return `caught by ${filters.length} of your filters`;
}

/** One alert as a Telegram HTML message. */
export function formatAlert(card: AlertCard, links: AlertLinks, now = Date.now()): string {
  const t = card.token;
  const icon = card.calls.length > 0 ? "🟢" : "🎯";
  const lines: string[] = [];
  lines.push(`${icon} <b>${escapeHtml(tokenLabel(t))}</b> — ${escapeHtml(headline(card))}`);

  const facts: string[] = [];
  if (t.name && t.symbol) facts.push(escapeHtml(t.name));
  if (card.snapshot) facts.push(`${usd(card.snapshot.marketCapUsd)} mcap`);
  const age = ageText(t.firstSeenAt, now);
  if (age) facts.push(age);
  if (card.snapshot?.holderCount != null) facts.push(`${card.snapshot.holderCount} holders`);
  if (card.snapshot?.volume1hUsd != null) facts.push(`${usd(card.snapshot.volume1hUsd)} vol 1h`);
  if (facts.length > 0) lines.push(facts.join(" · "));

  for (const call of card.calls) {
    const bits = [`${escapeHtml(call.modelName)}: ${Math.round(call.confidence)}% conviction`];
    if (call.tier === "high") bits.push("high conviction");
    if (call.calibratedPct !== null) bits.push(`${Math.round(call.calibratedPct)}% of calls like it 2x'd`);
    if (call.narrativeVerdict === "agrees") bits.push("Narrative agrees");
    if (call.narrativeVerdict === "warns") bits.push("⚠️ Narrative warns");
    lines.push(bits.join(" · "));
    for (const reason of call.reasons.slice(0, MAX_REASONS)) lines.push(`• ${escapeHtml(reason)}`);
  }
  for (const f of card.filters) {
    if (card.calls.length > 0) lines.push(`🎯 “${escapeHtml(f.name)}” · score ${Math.round(f.score)}`);
    else lines.push(`score ${Math.round(f.score)}`);
  }

  lines.push(`<code>${escapeHtml(t.mintAddress)}</code>`);
  lines.push(tradeLinks(t.mintAddress, links));
  return lines.join("\n");
}

/** Many alerts at once become one message, so a burst never floods a chat. */
export function formatDigest(cards: AlertCard[], links: AlertLinks): string {
  const lines = [`⚡ <b>${cards.length} new alerts</b>`];
  for (const card of cards) {
    const who = headline(card);
    const mcap = card.snapshot ? ` · ${usd(card.snapshot.marketCapUsd)}` : "";
    lines.push(
      `• <b>${escapeHtml(tokenLabel(card.token))}</b> — ${escapeHtml(who)}${mcap} · <code>${escapeHtml(card.token.mintAddress)}</code>`,
    );
  }
  if (links.dashboardUrl) {
    lines.push(`<a href="${escapeHtml(links.dashboardUrl.replace(/\/$/, ""))}/#live">Open the Live feed</a>`);
  }
  return lines.join("\n");
}

export function formatTestMessage(links: AlertLinks): string {
  return formatAlert(
    {
      token: {
        mintAddress: "So11111111111111111111111111111111111111112",
        symbol: "TEST",
        name: "Test alert",
        firstSeenAt: null,
      },
      snapshot: { marketCapUsd: 42_000, holderCount: 120, volume1hUsd: 18_000 },
      filters: [{ name: "your filter", score: 71 }],
      calls: [],
      raisedAt: new Date(),
    },
    links,
  ).replace("🎯", "🔔");
}
