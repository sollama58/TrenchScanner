import { fetchJson } from "./httpClient.js";

/**
 * Client for TokenSage (https://github.com/sollama58/TokenSage), the user's own API that reads a
 * token's name, ticker, image and X link and says what the coin is about. The contract is
 * TokenSage's openapi.v1.json (schema_version "1"); only the parts TrenchScanner reads are typed
 * here, and every field is optional so a new or missing one never breaks parsing. Adding fields
 * or labels is a compatible change on their side, so category and flag labels are kept as plain
 * strings rather than a closed union.
 *
 * Everything TokenSage returns in `raw`, `summary`, `x.text` and `image.ocr` is untrusted text
 * from the token's launcher: escape it wherever it is shown.
 */

export type TokenSageDepth = "basic" | "full";

export interface TokenSageCategory {
  label: string;
  confidence: number;
}

export interface TokenSageFlag {
  code: string;
  severity?: "info" | "warn" | "high";
  detail?: string;
}

/** One X account the analysis names (post author, quoted or replied-to author). */
export interface TokenSageXAccount {
  role?: string;
  handle?: string | null;
  name?: string | null;
  followers?: number | null;
  verified_type?: string | null;
}

/** A quoted or replied-to post (rules 0.9.0+, full depth). */
export interface TokenSageXPost {
  id?: string | null;
  url?: string | null;
  /** "ok" | "deleted" | "failed"; a failed parent still names its author. */
  status?: string;
  author?: TokenSageXAccount | null;
  text?: string | null;
  created_at?: string | null;
  predates_token_by_s?: number | null;
}

/** How well the linked post or profile matches the token (rules 0.6.0+, full depth only). */
export interface TokenSageXMatch {
  name?: { score?: number; how?: string; detail?: string } | null;
  ticker?: { score?: number; how?: string; detail?: string } | null;
  image?: { score?: number; best_distance?: number | null; media_checked?: number; detail?: string } | null;
  referent?: {
    x_label?: string | null;
    x_kind?: string | null;
    agrees?: boolean | null;
    confidence?: number;
  } | null;
  x_categories?: TokenSageCategory[];
  fit?: number;
  /** "about_this_coin" | "related" | "unrelated" | "unknown"; kept open for new values. */
  verdict?: string;
}

/**
 * One Analysis document (schema_version "1"). Typed from TokenSage's openapi.v1.json and checked
 * against real responses (fixtures/tokensage/). Every field is optional and may be null: a
 * partial answer (mint not yet on-chain, analysed from our hints) has no market data, a basic
 * answer has `x.status: "not_fetched"` and `x.match: null`, and new fields can appear at any
 * time. `market.creator` is here for completeness only: creator history is not a model input.
 */
export interface TokenSageAnalysis {
  schema_version?: string;
  mint?: string;
  created_at?: string | null;
  launchpad?: string;
  market?: {
    complete?: boolean | null;
    curve_progress?: number | null;
    graduated_pool?: string | null;
    creator?: string | null;
    is_mayhem_mode?: boolean | null;
    quote_mint?: string | null;
    /** The token the coin trades against (rules 0.9.0+); null when the quote mint is unknown. */
    pair?: {
      mint?: string | null;
      symbol?: string | null;
      name?: string | null;
      /** "sol" | "stablecoin" | "lst" | "major" | "token" | "tokenized_stock"; kept open. */
      kind?: string | null;
      /** The stock ticker of a tokenized stock (TSLAx -> TSLA). */
      underlying?: string | null;
      source?: string | null;
      builds_on?: boolean | null;
      builds_on_detail?: string | null;
      referent?: TokenSageAnalysis["referent"];
      categories?: TokenSageCategory[];
    } | null;
  } | null;
  raw?: {
    name?: string | null;
    symbol?: string | null;
    description?: string | null;
    image_url?: string | null;
    twitter?: string | null;
    telegram?: string | null;
    website?: string | null;
  } | null;
  referent?: {
    label?: string;
    kind?: string;
    desc?: string | null;
    source?: string | null;
    confidence?: number;
    /** Which inputs point at the referent: name, symbol, description, image, x, trend, chain, db. */
    supported_by?: string[];
  } | null;
  categories?: TokenSageCategory[];
  ticker_explanation?: string | null;
  /**
   * Coins this one copies or builds on. `recent: true` = it copies a coin launched 5 min - 30
   * days earlier (a live copycat, flag `copycat`); `false` = it references an established coin
   * (flag `references_known_coin`, info only). Analyses before rules 0.10.0 have no `recent`.
   */
  copy_of?: {
    ticker?: string | null;
    name?: string | null;
    mint?: string | null;
    signals?: string[];
    created_at?: string | null;
    recent?: boolean;
  }[];
  image?: {
    status?: string;
    phash?: string | null;
    ocr?: string[];
    near_duplicates?: unknown[];
    animated?: boolean | null;
  } | null;
  x?: {
    ref?: {
      kind?: string;
      tweet_id?: string | null;
      community_id?: string | null;
      url_handle?: string | null;
    } | null;
    object_time?: string | null;
    relation?: string | null;
    /** "ok" | "not_fetched" | ...; anything but "ok" means the post was not read. */
    status?: string;
    text?: string | null;
    predates_token_by_s?: number | null;
    reuse_count?: number;
    author?: (TokenSageXAccount & { user_id?: string | null; joined?: string | null }) | null;
    quoted?: TokenSageXPost | null;
    replied_to?: TokenSageXPost | null;
    accounts?: TokenSageXAccount[];
    match?: TokenSageXMatch | null;
  } | null;
  trend?: { matched?: boolean; terms?: { term: string; spike?: number | null; source: string }[] } | null;
  flags?: TokenSageFlag[];
  summary?: string;
  evidence?: {
    kind?: string;
    label?: string;
    weight?: number;
    detail?: string;
    source?: string;
    url?: string | null;
    where?: string | null;
  }[];
  caveats?: string[];
  depth?: TokenSageDepth;
  analyzed_at?: string;
  versions?: { rules?: string; lexicon?: string; known_coins?: string } | null;
}

export type TokenSageItemStatus = "complete" | "partial" | "pending" | "failed" | "invalid";

export interface TokenSageBatchItem {
  ca: string;
  status: TokenSageItemStatus;
  analysis?: TokenSageAnalysis | null;
  job_id?: number | null;
  /** On a "failed" item: "quota_exceeded" / "overloaded" when that item was turned away. */
  error?: string | null;
  retry_after_s?: number | null;
}

/**
 * What TrenchScanner already knows about a mint, sent with the request so TokenSage can skip
 * its own metadata fetch (and answer for a mint not yet visible on-chain). Untrusted launcher
 * text, validated on TokenSage's side exactly like fetched metadata.
 */
export interface TokenSageHints {
  name?: string;
  symbol?: string;
  description?: string;
  image_url?: string;
  twitter?: string;
  website?: string;
  /** ISO 8601. */
  created_at?: string;
}

export interface TokenSageJob {
  job_id: number;
  status: "pending" | "running" | "done" | "failed";
  /** On a failed job: "<code>: <detail>", e.g. "token_not_found: no account found on-chain". */
  error?: string | null;
}

export interface TokenSageBatchResult {
  items: TokenSageBatchItem[];
  /** X-Quota-Full-Remaining: full-depth analyses this key may still start today. Null if absent. */
  fullRemaining: number | null;
}

/** POST /v1/tokens:batch takes at most this many CAs. */
export const TOKENSAGE_BATCH_MAX = 50;

/** Summary/referent text is clipped to this before it is stored. */
const MAX_TEXT = 500;

export interface TokenSageClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class TokenSageClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: TokenSageClientOptions) {
    // A bare host ("tokensage-api.onrender.com") would be fetched as a relative URL and fail; an
    // http:// one redirects to https, and a redirected POST loses its body and auth header.
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    this.baseUrl = /^https?:\/\//i.test(trimmed)
      ? trimmed.replace(/^http:\/\/(?!localhost|127\.0\.0\.1)/i, "https://")
      : `https://${trimmed}`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /**
   * Prefetch: cached analyses come back at once, the rest as `pending` with a job id. Never
   * waits. Re-sending a pending mint joins its open job for free (no quota) and returns the
   * analysis once it is done, so this doubles as the poll. No retries here: a 429/503 means
   * "skip this cycle", and the caller backs off.
   */
  async batch(
    entries: { ca: string; hints?: TokenSageHints }[],
    depth: TokenSageDepth,
  ): Promise<TokenSageBatchResult> {
    let fullRemaining: number | null = null;
    const items = entries
      .slice(0, TOKENSAGE_BATCH_MAX)
      .map((e) => (e.hints ? { ca: e.ca, hints: e.hints } : { ca: e.ca }));
    const body = await fetchJson<{ items?: TokenSageBatchItem[] }>(`${this.baseUrl}/v1/tokens:batch`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ items, depth }),
      timeoutMs: this.timeoutMs,
      retries: 0,
      onHeaders: (h) => {
        const raw = h.get("x-quota-full-remaining");
        const n = raw === null ? NaN : Number(raw);
        fullRemaining = Number.isFinite(n) ? n : null;
      },
    });
    return { items: Array.isArray(body.items) ? body.items : [], fullRemaining };
  }

  /**
   * One job's state. Used only when a re-sent mint comes back under a new job id: the old job
   * ended without an analysis, and its error says whether asking again can help.
   */
  async job(jobId: number): Promise<TokenSageJob> {
    return fetchJson<TokenSageJob>(`${this.baseUrl}/v1/jobs/${encodeURIComponent(String(jobId))}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      retries: 0,
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...extra };
  }
}

/** The hints for a mint from what discovery stored on its Token row; empty fields are left out. */
export function tokenSageHints(token: {
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  firstSeenAt?: Date | null;
}): TokenSageHints | undefined {
  const hints: TokenSageHints = {};
  if (token.name) hints.name = token.name.slice(0, 200);
  if (token.symbol) hints.symbol = token.symbol.slice(0, 50);
  if (token.description) hints.description = token.description.slice(0, 2_000);
  if (token.imageUrl?.startsWith("https://")) hints.image_url = token.imageUrl;
  if (token.twitterUrl) hints.twitter = token.twitterUrl;
  if (token.websiteUrl) hints.website = token.websiteUrl;
  if (token.firstSeenAt && !Number.isNaN(token.firstSeenAt.getTime())) {
    hints.created_at = token.firstSeenAt.toISOString();
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** What a TokenNarrative row stores, derived from one Analysis document. */
export interface TokenNarrativeFields {
  depth: TokenSageDepth;
  status: "complete" | "partial";
  categories: TokenSageCategory[];
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  /** Inputs that point at the referent (referent.supported_by); two or more is far stronger. */
  referentSupport: string[];
  summary: string | null;
  flags: string[];
  xFit: number | null;
  xVerdict: string | null;
  /** market.pair.kind and symbol: what the coin trades against ("sol", "token", ...). */
  pairKind: string | null;
  pairSymbol: string | null;
  /**
   * True when the coin copies a coin launched in the last 30 days (copy_of[].recent), false
   * when it copies nothing recent, null for analyses made before TokenSage said which.
   */
  copiesRecent: boolean | null;
  rulesVersion: string | null;
  analyzedAt: Date | null;
}

/** Postgres text and jsonb reject NUL characters, and launcher text can carry them. */
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;

function clip(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.replace(NUL, "").trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** Distinct non-empty strings from a list, each at most 60 characters. */
function labels(value: unknown, max: number): string[] {
  return [
    ...new Set(
      asArray(value)
        .map(clip)
        .filter((v): v is string => v !== null)
        .map((v) => v.slice(0, 60)),
    ),
  ].slice(0, max);
}

/**
 * Reads the parts of one Analysis document that a TokenNarrative row stores. Built to survive
 * anything TokenSage might send: missing, null or wrongly typed fields fall back to empty, and
 * unknown fields are ignored. Throws on nothing.
 */
export function narrativeFieldsFromAnalysis(
  analysis: TokenSageAnalysis,
  status: "complete" | "partial",
): TokenNarrativeFields {
  const doc = asRecord(analysis) ?? {};
  const categories: TokenSageCategory[] = [];
  for (const raw of asArray(doc.categories)) {
    const c = asRecord(raw);
    const label = clip(c?.label);
    const confidence = unit(c?.confidence);
    if (label !== null && confidence !== null) categories.push({ label: label.slice(0, 80), confidence });
    if (categories.length >= 20) break;
  }
  const flags = labels(
    asArray(doc.flags).map((f) => asRecord(f)?.code),
    30,
  );
  const analyzedAt = typeof doc.analyzed_at === "string" ? new Date(doc.analyzed_at) : null;
  const referent = asRecord(doc.referent);
  const match = asRecord(asRecord(doc.x)?.match);
  const verdict = clip(match?.verdict);
  const known = verdict !== null && verdict !== "unknown" ? verdict.slice(0, 40) : null;
  const pair = asRecord(asRecord(doc.market)?.pair);
  const copies = asArray(doc.copy_of).map(asRecord);
  const marked = copies.filter((c) => typeof c?.recent === "boolean");
  const copiesRecent =
    copies.length === 0 ? false : marked.length > 0 ? marked.some((c) => c!.recent === true) : null;
  return {
    depth: doc.depth === "full" ? "full" : "basic",
    status,
    categories,
    referentLabel: clip(referent?.label),
    referentKind: clip(referent?.kind),
    referentConfidence: referent ? unit(referent.confidence) : null,
    referentSupport: labels(referent?.supported_by, 10),
    summary: clip(doc.summary),
    flags,
    xFit: known !== null ? unit(match?.fit) : null,
    xVerdict: known,
    pairKind: clip(pair?.kind)?.slice(0, 40) ?? null,
    pairSymbol: clip(pair?.symbol)?.slice(0, 40) ?? null,
    copiesRecent,
    rulesVersion: clip(asRecord(doc.versions)?.rules),
    analyzedAt: analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : null,
  };
}

/**
 * The Analysis document as it is kept in TokenNarrative.analysis: NUL characters removed (jsonb
 * rejects them) and anything that isn't plain JSON dropped. Null if it isn't an object.
 */
export function storableAnalysis(analysis: unknown): Record<string, unknown> | null {
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.replace(NUL, "");
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean" || value === null) return value;
    if (depth > 20) return null;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    const record = asRecord(value);
    if (!record) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined) out[k.replace(NUL, "")] = clean(v, depth + 1);
    }
    return out;
  };
  return asRecord(analysis) ? (clean(analysis, 0) as Record<string, unknown>) : null;
}

/** What a narrative card shows besides the stored columns, read from the Analysis document. */
export interface NarrativeDetails {
  /** Only when the coin trades against another token or a tokenized stock (SOL/USDC pairs: null). */
  pair: {
    kind: string;
    symbol: string | null;
    name: string | null;
    underlying: string | null;
    buildsOn: boolean;
  } | null;
  /** The posts around the linked one: what it quotes and what it replies to. */
  postContext: {
    relation: "quoted" | "replied_to";
    status: string | null;
    handle: string | null;
    name: string | null;
    text: string | null;
    url: string | null;
  }[];
  accounts: {
    role: string | null;
    handle: string | null;
    name: string | null;
    followers: number | null;
    verifiedType: string | null;
  }[];
  /** Live copycat (recent: true, warn) vs reference to an established coin (false, info). */
  copies: { ticker: string | null; name: string | null; recent: boolean | null }[];
  referentSupport: string[];
}

/** Display text: NUL-free, trimmed, clipped. Still untrusted: render it as text, never as HTML. */
function text(value: unknown, max: number): string | null {
  return clip(value)?.slice(0, max) ?? null;
}

function httpsUrl(value: unknown): string | null {
  const v = text(value, 300);
  return v !== null && /^https:\/\//i.test(v) ? v : null;
}

const PAIR_KINDS_SHOWN = new Set(["token", "tokenized_stock"]);

/** Reads the card details out of an Analysis document; never throws, whatever it is given. */
export function narrativeDetails(analysis: unknown): NarrativeDetails {
  const doc = asRecord(analysis) ?? {};
  const pairRec = asRecord(asRecord(doc.market)?.pair);
  const pairKind = text(pairRec?.kind, 40);
  const x = asRecord(doc.x);
  const account = (a: Record<string, unknown> | null) => ({
    handle: text(a?.handle, 40),
    name: text(a?.name, 80),
  });
  const postContext: NarrativeDetails["postContext"] = [];
  for (const relation of ["replied_to", "quoted"] as const) {
    const post = asRecord(x?.[relation]);
    if (!post) continue;
    postContext.push({
      relation,
      status: text(post.status, 20),
      ...account(asRecord(post.author)),
      text: text(post.text, 280),
      url: httpsUrl(post.url),
    });
  }
  return {
    pair:
      pairKind !== null && PAIR_KINDS_SHOWN.has(pairKind)
        ? {
            kind: pairKind,
            symbol: text(pairRec?.symbol, 40),
            name: text(pairRec?.name, 80),
            underlying: text(pairRec?.underlying, 20),
            buildsOn: pairRec?.builds_on === true,
          }
        : null,
    postContext,
    accounts: asArray(x?.accounts)
      .map(asRecord)
      .filter((a): a is Record<string, unknown> => a !== null)
      .slice(0, 10)
      .map((a) => ({
        role: text(a.role, 30),
        ...account(a),
        followers: typeof a.followers === "number" && Number.isFinite(a.followers) ? a.followers : null,
        verifiedType: text(a.verified_type, 20),
      })),
    copies: asArray(doc.copy_of)
      .map(asRecord)
      .filter((c): c is Record<string, unknown> => c !== null)
      .slice(0, 5)
      .map((c) => ({
        ticker: text(c.ticker, 20),
        name: text(c.name, 80),
        recent: typeof c.recent === "boolean" ? c.recent : null,
      })),
    referentSupport: labels(asRecord(doc.referent)?.supported_by, 10),
  };
}

const DEPTH_RANK: Record<string, number> = { basic: 0, full: 1 };

/** True when a stored analysis at `have` already covers a request at `want`. */
export function narrativeDepthCovers(have: string | null | undefined, want: TokenSageDepth): boolean {
  if (!have) return false;
  return (DEPTH_RANK[have] ?? -1) >= DEPTH_RANK[want]!;
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

/**
 * A launcher-written social link, made safe to store: only absolute https URLs are kept, and a
 * bare X handle ("@foo" or "foo", which Pump.fun allows in its `twitter` field) becomes its
 * https://x.com/ URL. Anything else is null.
 */
export function normalizeSocialUrl(
  raw: string | null | undefined,
  kind: "twitter" | "website",
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > 300) return null;
  if (kind === "twitter" && /^@?[A-Za-z0-9_]{1,15}$/.test(value)) {
    return `https://x.com/${value.replace(/^@/, "")}`;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  if (
    kind === "twitter" &&
    !X_HOSTS.has(url.hostname.toLowerCase()) &&
    url.hostname.toLowerCase() !== "t.co"
  ) {
    return null;
  }
  return url.toString();
}
