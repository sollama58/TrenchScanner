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

/**
 * What a caption counts against that cap: Telegram measures the text left once the HTML is
 * parsed, so the tags and the links' hrefs are free and an escape is one character.
 */
export function captionLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, "_").length;
}
/** A digest lists this many tokens in full and counts the rest. */
export const DIGEST_MAX_ENTRIES = 12;

/**
 * The parts of an alert a chat can switch off, in the order the card shows them. The chat's
 * TelegramChat.hidden lists the keys it turned off; everything else is on.
 */
export const ALERT_PARTS = [
  "image",
  "stats",
  "holders",
  "volume",
  "age",
  "conviction",
  "calibrated",
  "reasons",
  "filters",
  "mint",
  "links",
  "sage",
] as const;
export type AlertPart = (typeof ALERT_PARTS)[number];
export const ALERT_PART_LABELS: Record<AlertPart, string> = {
  image: "the token's picture",
  stats: "the market cap",
  holders: "the holder count",
  volume: "the last hour's volume",
  age: "how old the token is",
  conviction: "each model's conviction line",
  calibrated: "how often calls like it 2x'd",
  reasons: "the strongest call's reasons",
  filters: "which filter caught it, with the score",
  mint: "the mint address",
  links: "the trade links",
  sage: "the link to TokenSage's read of the coin",
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

/** A round amount without the decimal: $5k, $25k, $1.5m. */
export function shortUsd(n: number): string {
  if (n >= 1e6) return `$${Number((n / 1e6).toFixed(2))}m`;
  if (n >= 1e3) return `$${Number((n / 1e3).toFixed(1))}k`;
  return `$${Math.round(n)}`;
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

/**
 * The dashboard link that opens the token's TokenSage view (apps/web/src/sage.ts reads `?sage=`),
 * or null without a dashboard URL. Telegram can't show the view itself, so the alert links to it.
 */
export function sageUrl(mint: string, links: AlertLinks): string | null {
  const base = links.dashboardUrl.replace(/\/$/, "");
  return base ? `${base}/?sage=${encodeURIComponent(mint)}` : null;
}

function sageLink(mint: string, links: AlertLinks, text: string): string | null {
  const url = sageUrl(mint, links);
  return url ? `<a href="${escapeHtml(url)}">${text}</a>` : null;
}

/** The rule under an alert's title: a visual break that costs a handful of caption characters. */
export const DIVIDER = "━━━━━━━━━━━━━━";

function dashboardLink(links: AlertLinks, text: string): string | null {
  const base = links.dashboardUrl.replace(/\/$/, "");
  return base ? `<a href="${escapeHtml(base)}/#live">${text}</a>` : null;
}

/**
 * The trade, chart and explorer links an alert can carry; each chat picks its own (TelegramChat
 * .links), the first three by default, as the Live feed's quick links.
 */
export const ALERT_LINKS = ["terminal", "axiom", "gmgn", "dexscreener", "birdeye", "solscan"] as const;
export type AlertLink = (typeof ALERT_LINKS)[number];
export const DEFAULT_ALERT_LINKS: readonly AlertLink[] = ["terminal", "axiom", "gmgn"];
export const ALERT_LINK_LABELS: Record<AlertLink, string> = {
  terminal: "Terminal",
  axiom: "Axiom",
  gmgn: "GMGN",
  dexscreener: "DexScreener",
  birdeye: "Birdeye",
  solscan: "Solscan",
};

export function alertLinkUrl(link: AlertLink, mint: string): string {
  const m = encodeURIComponent(mint);
  switch (link) {
    case "terminal":
      return `https://trade.padre.gg/trade/solana/${m}`;
    case "axiom":
      return `https://axiom.trade/t/${m}`;
    case "gmgn":
      return `https://gmgn.ai/sol/token/${m}`;
    case "dexscreener":
      return `https://dexscreener.com/solana/${m}`;
    case "birdeye":
      return `https://birdeye.so/token/${m}?chain=solana`;
    case "solscan":
      return `https://solscan.io/token/${m}`;
  }
}

export function isAlertLink(key: string): key is AlertLink {
  return (ALERT_LINKS as readonly string[]).includes(key);
}

/** How a chat's alerts are laid out, and which links they carry. */
export interface AlertStyle {
  /** "full" is the whole card; "compact" drops the rule, the reasons and the bars, a few lines in all. */
  layout: "full" | "compact";
  links: readonly AlertLink[];
}

export const DEFAULT_STYLE: AlertStyle = { layout: "full", links: DEFAULT_ALERT_LINKS };

/** A chat row's style, with anything unknown dropped and the links kept in their menu order. */
export function alertStyle(
  row: { layout?: string | null; links?: readonly string[] | null } = {},
): AlertStyle {
  const chosen = new Set(row.links ?? DEFAULT_ALERT_LINKS);
  return {
    layout: row.layout === "compact" ? "compact" : "full",
    links: ALERT_LINKS.filter((l) => chosen.has(l)),
  };
}

function tradeLinks(mint: string, style: AlertStyle): string | null {
  if (style.links.length === 0) return null;
  return style.links
    .map((l) => `<a href="${escapeHtml(alertLinkUrl(l, mint))}">${ALERT_LINK_LABELS[l]}</a>`)
    .join("  │  ");
}

/** A 0-100 conviction as ten blocks, e.g. ▰▰▰▰▰▰▰▱▱▱ for 72. */
export function convictionBar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
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

/** The numbers, two to a line so they read as a small grid on a phone. */
function factsLines(card: AlertCard, now: number, parts: AlertParts, compact: boolean): string | null {
  const facts: string[] = [];
  if (parts.stats && card.snapshot) facts.push(`💰 MC <b>${usd(card.snapshot.marketCapUsd)}</b>`);
  if (parts.holders && card.snapshot?.holderCount != null)
    facts.push(`👥 <b>${card.snapshot.holderCount}</b> holders`);
  if (parts.volume && card.snapshot?.volume1hUsd != null)
    facts.push(`📊 Vol 1h <b>${usd(card.snapshot.volume1hUsd)}</b>`);
  const age = parts.age ? ageText(card.token.firstSeenAt, now) : null;
  if (age) facts.push(`⏱ ${age}`);
  if (facts.length === 0) return null;
  if (compact) return facts.join("  ·  ");
  const lines: string[] = [];
  for (let i = 0; i < facts.length; i += 2) lines.push(facts.slice(i, i + 2).join("   ·   "));
  return lines.join("\n");
}

function callLines(call: AlertCall, withReasons: boolean, parts: AlertParts, compact: boolean): string[] {
  const pct = Math.round(call.confidence);
  if (compact) {
    const bits = [
      `🤖 <b>${escapeHtml(call.modelName)}</b> <b>${pct}%</b>${call.tier === "high" ? " 🔥" : ""}`,
    ];
    if (parts.calibrated && call.calibratedPct !== null)
      bits.push(`${Math.round(call.calibratedPct)}% like it 2x'd`);
    if (call.narrativeVerdict === "agrees") bits.push("📝 agrees");
    if (call.narrativeVerdict === "warns") bits.push("⚠️ warns");
    return [bits.join("  ·  ")];
  }
  let head = `🤖 <b>${escapeHtml(call.modelName)}</b>  ${convictionBar(pct)}  <b>${pct}%</b> conviction`;
  if (call.tier === "high") head += "  🔥 high";
  const lines = [head];
  if (parts.calibrated && call.calibratedPct !== null)
    lines.push(`     ${Math.round(call.calibratedPct)}% of calls like it 2x'd`);
  if (call.narrativeVerdict === "agrees") lines.push("     📝 Narrative agrees");
  if (call.narrativeVerdict === "warns") lines.push("     ⚠️ Narrative warns");
  const reasons = withReasons ? call.reasons.slice(0, MAX_REASONS).map((r) => `▸ ${escapeHtml(r)}`) : [];
  if (reasons.length > 0) lines.push(`<blockquote>${reasons.join("\n")}</blockquote>`);
  return lines;
}

/**
 * One alert as a Telegram HTML message: the token and who raised it over a rule, the numbers,
 * each model's call (strongest first, with a conviction bar) and its reasons, each filter that
 * caught it (highest score first), then the mint to copy, the places to trade and the reads.
 * Blank lines between the blocks; short enough to ride as a photo caption. The compact layout
 * keeps the same facts in a few lines: no rule, no bars, no reasons, the filters on one line.
 */
export function formatAlert(
  card: AlertCard,
  links: AlertLinks,
  now = Date.now(),
  parts: AlertParts = ALL_PARTS,
  style: AlertStyle = DEFAULT_STYLE,
): string {
  const compact = style.layout === "compact";
  const c = strongestFirst(card);
  const t = c.token;
  const icon = c.calls.length > 0 ? "🟢" : "🎯";
  const title =
    t.name && t.symbol && !compact
      ? `${icon} <b>${escapeHtml(tokenLabel(t))}</b>  ·  ${escapeHtml(t.name)}`
      : `${icon} <b>${escapeHtml(tokenLabel(t))}</b>`;
  const sections: string[] = [
    compact
      ? `${title}  ·  <i>${escapeHtml(headline(c))}</i>`
      : `${title}\n<i>${escapeHtml(headline(c))}</i>\n${DIVIDER}`,
  ];

  const facts = factsLines(c, now, parts, compact);
  if (facts) sections.push(facts);

  // The strongest call carries the reasons; the others go without, which keeps the whole
  // message inside a photo caption.
  const calls: string[] = [];
  const withReasons = (i: number) => i === 0 && parts.reasons && !compact;
  if (parts.conviction)
    c.calls.forEach((call, i) => calls.push(...callLines(call, withReasons(i), parts, compact)));
  else if (withReasons(0) && c.calls[0])
    calls.push(...callLines(c.calls[0], true, parts, false).filter((l) => l.startsWith("<blockquote>")));
  if (calls.length > 0) sections.push(calls.join("\n"));

  if (parts.filters && c.filters.length > 0)
    sections.push(
      compact
        ? `🎯 ${c.filters.map((f) => `“${escapeHtml(f.name)}” <b>${Math.round(f.score)}</b>`).join("  ·  ")}`
        : c.filters
            .map((f) => `🎯 <b>“${escapeHtml(f.name)}”</b>  ·  score <b>${Math.round(f.score)}</b>`)
            .join("\n"),
    );

  const tail: string[] = [];
  if (parts.mint) tail.push(`<code>${escapeHtml(t.mintAddress)}</code>`);
  const trade = parts.links ? tradeLinks(t.mintAddress, style) : null;
  if (trade) tail.push(trade);
  const reads: string[] = [];
  const dash = parts.links ? dashboardLink(links, "TrenchScanner") : null;
  if (dash) reads.push(dash);
  const sage = parts.sage ? sageLink(t.mintAddress, links, "TokenSage read") : null;
  if (sage) reads.push(`🔮 ${sage}`);
  if (reads.length > 0) tail.push(reads.join("   "));
  if (tail.length > 0) sections.push(tail.join("\n"));
  // The rule closes the title block, so the numbers sit right under it; blank lines elsewhere.
  const [head, ...body] = sections;
  if (compact) return sections.join("\n");
  return body.length > 0 ? `${head}\n${body.join("\n\n")}` : head!;
}

/** One alert, with the token's picture above it when there is one. */
export function alertMessage(
  card: AlertCard,
  links: AlertLinks,
  now = Date.now(),
  parts: AlertParts = ALL_PARTS,
  style: AlertStyle = DEFAULT_STYLE,
): AlertMessage {
  return {
    html: formatAlert(card, links, now, parts, style),
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
 * strongest call is the first line a person reads, and each entry
 * links straight to the terminal.
 */
export function formatDigest(
  cards: AlertCard[],
  links: AlertLinks,
  parts: AlertParts = ALL_PARTS,
  style: AlertStyle = DEFAULT_STYLE,
): string {
  const ranked = sortCards(cards);
  const lines = [`⚡ <b>${cards.length} new alerts</b>  ·  strongest first`, DIVIDER];
  ranked.slice(0, DIGEST_MAX_ENTRIES).forEach((card, i) => {
    const icon = card.calls.length > 0 ? "🟢" : "🎯";
    const rank = `<b>${i + 1}.</b>`;
    const bits = [
      `${rank} ${icon} <b>${escapeHtml(tokenLabel(card.token))}</b>`,
      escapeHtml(digestWho(card)),
    ];
    if (parts.stats && card.snapshot) bits.push(usd(card.snapshot.marketCapUsd));
    // The chat's first link, so a chat that trades on Axiom gets Axiom here too.
    const first = style.links[0];
    if (parts.links && first)
      bits.push(`<a href="${escapeHtml(alertLinkUrl(first, card.token.mintAddress))}">trade ↗</a>`);
    else if (parts.mint) bits.push(`<code>${escapeHtml(card.token.mintAddress)}</code>`);
    // A blank line between entries, so a wrapped entry doesn't run into the next one.
    lines.push(...(i > 0 ? [""] : []), bits.join(" · "));
  });
  if (ranked.length > DIGEST_MAX_ENTRIES) lines.push(`… and ${ranked.length - DIGEST_MAX_ENTRIES} more`);
  const dash = dashboardLink(links, "Open the Live feed");
  if (dash) lines.push("", dash);
  return lines.join("\n");
}

/** A digest, pictured with the strongest token's logo when it has one. */
export function digestMessage(
  cards: AlertCard[],
  links: AlertLinks,
  parts: AlertParts = ALL_PARTS,
  style: AlertStyle = DEFAULT_STYLE,
): AlertMessage {
  const top = parts.image ? sortCards(cards).find((c) => alertImage(c.token) !== null) : undefined;
  return { html: formatDigest(cards, links, parts, style), imageUrl: top ? alertImage(top.token) : null };
}

/** The sample alert the Filters tab sends, pictured with the app's own icon. */
export function formatTestMessage(
  links: AlertLinks,
  parts: AlertParts = ALL_PARTS,
  style: AlertStyle = DEFAULT_STYLE,
): AlertMessage {
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
    style,
  ).replace(/^🎯 <b>/, "🔔 <b>");
  return { html, imageUrl: parts.image && base.startsWith("https://") ? `${base}/icon-512.png` : null };
}
