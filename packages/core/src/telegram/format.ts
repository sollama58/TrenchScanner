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
  /** The token's logo (https), when a source had one. Sent as the message's photo. */
  imageUrl: string | null;
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
/** Telegram caps a photo caption at 1024 characters; a longer alert goes as plain text. */
export const CAPTION_MAX_CHARS = 1024;
/** A digest lists this many tokens in full and counts the rest. */
export const DIGEST_MAX_ENTRIES = 12;

/**
 * The parts of an alert a chat can switch off, in the order the card shows them. The chat's
 * TelegramChat.hidden lists the keys it turned off; everything else is on.
 */
export const ALERT_PARTS = ["image", "stats", "conviction", "reasons", "filters", "mint", "links"] as const;
export type AlertPart = (typeof ALERT_PARTS)[number];
export const ALERT_PART_LABELS: Record<AlertPart, string> = {
  image: "the token's picture",
  stats: "market cap, holders, volume and age",
  conviction: "each model's conviction line",
  reasons: "the strongest call's reasons",
  filters: "which filter caught it, with the score",
  mint: "the mint address",
  links: "the trade links",
};
export type AlertParts = Record<AlertPart, boolean>;

export function isAlertPart(key: string): key is AlertPart {
  return (ALERT_PARTS as readonly string[]).includes(key);
}

/** Which parts are on, from a chat's hidden list. Unknown keys are ignored. */
export function alertParts(hidden: readonly string[] = []): AlertParts {
  const off = new Set(hidden);
  return Object.fromEntries(ALERT_PARTS.map((p) => [p, !off.has(p)])) as AlertParts;
}

export const ALL_PARTS: AlertParts = alertParts();

/** One message, ready to send: the HTML and the photo to put above it, if any. */
export interface AlertMessage {
  html: string;
  imageUrl: string | null;
}

/** The longest side of the picture sent with an alert, in px. Telegram shows it at about this size. */
export const ALERT_IMAGE_PX = 640;

/**
 * The token's logo as the URL to fetch for the alert, or nothing. Launchers' images are IPFS
 * files on whichever public gateway the launcher used (ipfs.io rate-limits with 429s, and the
 * files are often megabytes); an IPFS image is read through Pump.fun's Pinata gateway instead,
 * resized there, the same trick the dashboard's thumbnails use. Anything else must be https.
 */
export function alertImage(token: Pick<AlertToken, "imageUrl">): string | null {
  const url = token.imageUrl?.trim() ?? "";
  if (!/^https:\/\/\S+$/.test(url)) return null;
  const cid =
    /^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{46,})\/?(?:[?#].*)?$/.exec(url)?.[1] ??
    /^https:\/\/([A-Za-z0-9]{46,})\.ipfs\.[^/]+\/?(?:[?#].*)?$/.exec(url)?.[1];
  // Also re-encoded as JPEG there: Telegram takes JPEG and PNG as a photo but balks at the GIFs,
  // WebPs and SVGs launchers upload, and a JPEG is the smallest of the lot.
  return cid
    ? `https://pump.mypinata.cloud/ipfs/${cid}?img-width=${ALERT_IMAGE_PX}&img-height=${ALERT_IMAGE_PX}&img-fit=scale-down&img-format=jpeg`
    : url;
}

/**
 * How much a card deserves the top of a digest: a model call outranks a filter match alone, a
 * stronger conviction outranks a weaker one, and among filter-only cards the higher score wins.
 */
export function cardRank(card: AlertCard): number {
  if (card.calls.length > 0) {
    const best = Math.max(...card.calls.map((c) => c.confidence + (c.tier === "high" ? 50 : 0)));
    return 1_000 + best + Math.min(card.calls.length - 1, 5) * 10;
  }
  return Math.max(0, ...card.filters.map((f) => f.score));
}

/** Best first; ties go to the newer alert. */
export function sortCards(cards: AlertCard[]): AlertCard[] {
  return [...cards].sort((a, b) => cardRank(b) - cardRank(a) || b.raisedAt.getTime() - a.raisedAt.getTime());
}

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

function strongestFirst(card: AlertCard): AlertCard {
  return {
    ...card,
    calls: [...card.calls].sort((a, b) => b.confidence - a.confidence),
    filters: [...card.filters].sort((a, b) => b.score - a.score),
  };
}

function factsLine(card: AlertCard, now: number): string | null {
  const facts: string[] = [];
  if (card.snapshot) facts.push(`💰 ${usd(card.snapshot.marketCapUsd)} mcap`);
  if (card.snapshot?.holderCount != null) facts.push(`👥 ${card.snapshot.holderCount} holders`);
  if (card.snapshot?.volume1hUsd != null) facts.push(`📊 ${usd(card.snapshot.volume1hUsd)} vol 1h`);
  const age = ageText(card.token.firstSeenAt, now);
  if (age) facts.push(`⏱ ${age}`);
  return facts.length > 0 ? facts.join("  ·  ") : null;
}

function callLines(call: AlertCall, withReasons: boolean): string[] {
  const bits = [`🤖 <b>${escapeHtml(call.modelName)}</b>`, `${Math.round(call.confidence)}% conviction`];
  if (call.tier === "high") bits.push("🔥 high conviction");
  if (call.calibratedPct !== null) bits.push(`${Math.round(call.calibratedPct)}% of calls like it 2x'd`);
  if (call.narrativeVerdict === "agrees") bits.push("📝 Narrative agrees");
  if (call.narrativeVerdict === "warns") bits.push("⚠️ Narrative warns");
  const lines = [bits.join(" · ")];
  const reasons = withReasons ? call.reasons.slice(0, MAX_REASONS).map((r) => `• ${escapeHtml(r)}`) : [];
  if (reasons.length > 0) lines.push(`<blockquote>${reasons.join("\n")}</blockquote>`);
  return lines;
}

/**
 * One alert as a Telegram HTML message: the token and who raised it, the numbers, each model's
 * call (strongest first) with its reasons, each filter that caught it (highest score first), then
 * the mint to copy and the places to trade. Short enough to ride as a photo caption.
 */
export function formatAlert(
  card: AlertCard,
  links: AlertLinks,
  now = Date.now(),
  parts: AlertParts = ALL_PARTS,
): string {
  const c = strongestFirst(card);
  const t = c.token;
  const icon = c.calls.length > 0 ? "🟢" : "🎯";
  const title =
    t.name && t.symbol
      ? `${icon} <b>${escapeHtml(tokenLabel(t))}</b> · ${escapeHtml(t.name)}`
      : `${icon} <b>${escapeHtml(tokenLabel(t))}</b>`;
  const sections: string[] = [`${title}\n<i>${escapeHtml(headline(c))}</i>`];

  const facts = parts.stats ? factsLine(c, now) : null;
  if (facts) sections.push(facts);

  const raised: string[] = [];
  // The strongest call carries the reasons; the others are one line each, which keeps the whole
  // message inside a photo caption.
  if (parts.conviction)
    c.calls.forEach((call, i) => raised.push(...callLines(call, i === 0 && parts.reasons)));
  else if (parts.reasons && c.calls[0]) raised.push(...callLines(c.calls[0], true).slice(1));
  if (parts.filters)
    for (const f of c.filters) raised.push(`🎯 “${escapeHtml(f.name)}” · score ${Math.round(f.score)}`);
  if (raised.length > 0) sections.push(raised.join("\n"));

  const tail: string[] = [];
  if (parts.mint) tail.push(`<code>${escapeHtml(t.mintAddress)}</code>`);
  if (parts.links) tail.push(tradeLinks(t.mintAddress, links));
  if (tail.length > 0) sections.push(tail.join("\n"));
  return sections.join("\n\n");
}

/** One alert, with the token's picture above it when there is one. */
export function alertMessage(
  card: AlertCard,
  links: AlertLinks,
  now = Date.now(),
  parts: AlertParts = ALL_PARTS,
): AlertMessage {
  return {
    html: formatAlert(card, links, now, parts),
    imageUrl: parts.image ? alertImage(card.token) : null,
  };
}

function digestWho(card: AlertCard): string {
  if (card.calls.length > 0) {
    const calls = [...card.calls].sort((a, b) => b.confidence - a.confidence);
    const best = calls[0]!;
    const names = calls.map((k) => k.modelName).join(" + ");
    const pct = `${Math.round(best.confidence)}%${best.tier === "high" ? " 🔥" : ""}`;
    return card.filters.length > 0 ? `${names} ${pct} + your filter` : `${names} ${pct}`;
  }
  const top = [...card.filters].sort((a, b) => b.score - a.score)[0];
  return top ? `“${top.name}” score ${Math.round(top.score)}` : "caught by your filters";
}

/**
 * Many alerts at once become one message, so a burst never floods a chat. Best first, so the
 * strongest call is the first line a person reads, and each line links straight to the terminal.
 */
export function formatDigest(cards: AlertCard[], links: AlertLinks, parts: AlertParts = ALL_PARTS): string {
  const ranked = sortCards(cards);
  const lines = [`⚡ <b>${cards.length} new alerts</b> · strongest first`, ""];
  ranked.slice(0, DIGEST_MAX_ENTRIES).forEach((card, i) => {
    const icon = card.calls.length > 0 ? "🟢" : "🎯";
    const bits = [
      `${i + 1}. ${icon} <b>${escapeHtml(tokenLabel(card.token))}</b>`,
      escapeHtml(digestWho(card)),
    ];
    if (parts.stats && card.snapshot) bits.push(usd(card.snapshot.marketCapUsd));
    const m = encodeURIComponent(card.token.mintAddress);
    if (parts.links) bits.push(`<a href="https://trade.padre.gg/trade/solana/${m}">trade</a>`);
    else if (parts.mint) bits.push(`<code>${escapeHtml(card.token.mintAddress)}</code>`);
    lines.push(bits.join(" · "));
  });
  if (ranked.length > DIGEST_MAX_ENTRIES) lines.push(`… and ${ranked.length - DIGEST_MAX_ENTRIES} more`);
  if (links.dashboardUrl) {
    lines.push(
      "",
      `<a href="${escapeHtml(links.dashboardUrl.replace(/\/$/, ""))}/#live">Open the Live feed</a>`,
    );
  }
  return lines.join("\n");
}

/** A digest, pictured with the strongest token's logo when it has one. */
export function digestMessage(
  cards: AlertCard[],
  links: AlertLinks,
  parts: AlertParts = ALL_PARTS,
): AlertMessage {
  const top = parts.image ? sortCards(cards).find((c) => alertImage(c.token) !== null) : undefined;
  return { html: formatDigest(cards, links, parts), imageUrl: top ? alertImage(top.token) : null };
}

/** The sample alert the Filters tab sends, pictured with the app's own icon. */
export function formatTestMessage(links: AlertLinks, parts: AlertParts = ALL_PARTS): AlertMessage {
  const base = links.dashboardUrl.replace(/\/$/, "");
  const html = formatAlert(
    {
      token: {
        mintAddress: "So11111111111111111111111111111111111111112",
        symbol: "TEST",
        name: "Test alert",
        firstSeenAt: null,
        imageUrl: null,
      },
      snapshot: { marketCapUsd: 42_000, holderCount: 120, volume1hUsd: 18_000 },
      filters: [{ name: "your filter", score: 71 }],
      calls: [],
      raisedAt: new Date(),
    },
    links,
    Date.now(),
    parts,
  ).replace("🎯 <b>", "🔔 <b>");
  return { html, imageUrl: parts.image && base.startsWith("https://") ? `${base}/icon-512.png` : null };
}
