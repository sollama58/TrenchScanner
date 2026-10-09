import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tokensage");

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
  /** Rules 0.15.0+: the inputs that agree on this label (name, symbol, description, image, x, trend, db). */
  inputs?: string[];
  /** Rules 0.15.0+: coins with this label in the hour before the read. */
  wave_1h?: number | null;
}

export interface TokenSageFlag {
  code: string;
  severity?: "info" | "warn" | "high";
  detail?: string;
}

/**
 * Flags whose severity TokenSage has lowered, mapped to today's severity, so a stored read made
 * by older rules counts and shows the same as a fresh one. Rules 0.23.0 made recycled_x_account
 * info (it was high): an account's age, renames and link reuse are context, not a verdict
 * (notes/tokensage-brief-2026-10-08-x-account-weighting.md).
 */
const FLAG_SEVERITY_NOW: Readonly<Record<string, "info" | "warn" | "high">> = {
  recycled_x_account: "info",
};

/** A flag's severity under today's rules: TokenSage's own, unless it has since lowered it. */
export function tokenSageFlagSeverity(code: unknown, severity: unknown): string {
  if (typeof code === "string" && FLAG_SEVERITY_NOW[code] !== undefined) return FLAG_SEVERITY_NOW[code];
  return typeof severity === "string" ? severity : "info";
}

/**
 * True when a versions.rules string ("0.23.0-full", "0.19.0") is at least `min` ("0.23.0").
 * False on null or anything unparseable, which reads as older rules.
 */
export function tokenSageRulesAtLeast(version: string | null | undefined, min: string): boolean {
  const parts = (v: string) =>
    v
      .match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number) ?? null;
  const have = version ? parts(version) : null;
  const want = parts(min);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!;
  return true;
}

/**
 * TokenSage suggests trusting the logo's top visual class (image.labels[0], rules 0.25.0+) from
 * this score up; below it the picture is unclear.
 */
export const TOKENSAGE_LOGO_MIN_SCORE = 0.5;

/** Rules 0.23.0 made x.credibility gentler on renamed, made-for-coin and late-reused accounts. */
export const TOKENSAGE_GENTLE_CREDIBILITY_RULES = "0.23.0";

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
  /**
   * `how` is kept open; rules 0.28.0 added "contract": the post carries the coin's mint
   * (matched case-sensitively), read as fit 1.0 and verdict "about_this_coin".
   */
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
  /** Rules 0.15.0+: what the fit rests on (post_text, post_image, cashtag, profile_name, profile_bio, profile_image). */
  basis?: string[];
}

/** One shareholder of a coin's creator fee (rules 0.19.0+). */
export interface TokenSageFeeRecipient {
  address?: string | null;
  share?: number | null;
  share_bps?: number | null;
  /** creator | wallet | github | charity | x | pump | social | program | unresolved; kept open. */
  kind?: string | null;
  is_creator?: boolean | null;
  platform?: string | null;
  /** GitHub: the numeric account id (null from rules 0.21.0 when it isn't a plain id). */
  user_id?: string | number | null;
  /** Always null from rules 0.22.0 (logins are no longer looked up); older reads may carry one. */
  github_login?: string | null;
  url?: string | null;
  charity_config_id?: string | null;
  /** GitHub/social: SOL claimed across all its coins. Charity: what this coin donated, in its quote token. */
  lifetime_received?: number | null;
}

/**
 * Where a pump.fun coin's creator fee goes (TokenSage rules 0.19.0, market.creator_fee).
 * `destination` is the one-word answer: creator | holder_rewards | wallet | split | github |
 * charity | cashback, rarely social | other | unknown; kept open, and anything unknown reads as
 * "redirected, see summary". Current as of the read: a mutable split can still change.
 */
export interface TokenSageCreatorFee {
  destination?: string | null;
  /** direct | sharing_config | holder_rewards | cashback; kept open. */
  mechanism?: string | null;
  creator_fee_bps?: number | null;
  admin?: string | null;
  sharing_config?: string | null;
  sharing_version?: number | null;
  mutable?: boolean | null;
  split?: boolean | null;
  /** Share of the fee per recipient kind; sums to 1. */
  shares?: Record<string, number> | null;
  recipients?: TokenSageFeeRecipient[] | null;
  /** One sentence to show as is, e.g. "creator fees go to the coin's holders (holder rewards coin)". */
  summary?: string | null;
}

/**
 * One Analysis document (schema_version "1"). Typed from TokenSage's openapi.v1.json and checked
 * against real responses (fixtures/tokensage/). Every field is optional and may be null: a
 * partial answer (mint not yet on-chain, analysed from our hints) has no market data, a basic
 * answer has `x.status: "not_fetched"` and `x.match: null`, and new fields can appear at any
 * time. `market.creator` is here for completeness only: creator history is not a model input
 * (user decision 2026-10-04), so nothing here keys on it. From rules 0.19.0 it is always a wallet
 * or null (the sharing config's admin on a fee-shared coin), and the raw curve field moved to
 * `creator_onchain`.
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
    /** Rules 0.19.0+: the raw bonding-curve creator field (a PDA on fee-shared and holder-rewards coins). */
    creator_onchain?: string | null;
    /** Rules 0.19.0+: "wallet" | "sharing_config" | "holder_rewards_pda" | "unknown"; kept open. */
    creator_kind?: string | null;
    /**
     * Rules 0.19.0+: where pump.fun's creator fee goes. Absent on older reads and null on a
     * non-pump.fun mint or a read made before the coin was on-chain; both mean "not known".
     */
    creator_fee?: TokenSageCreatorFee | null;
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
      /**
       * Rules 0.27.0+: the pair token is itself a pump.fun coin, read from its own bonding curve.
       * Null for SOL, stablecoins and majors (ZEC and PUMP count as majors), and when not known.
       */
      pumpfun?: boolean | null;
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
    /**
     * "famous_animal" | "meme" | "person" | "coin" | "event" | "concept" | "place" | "other", and
     * from rules 0.17.0 "animal" | "media" | "project" | "object" | "organization"; kept open.
     */
    kind?: string;
    /**
     * Rules 0.17.0+: only the kind is known ("frog", "cat", "launchpad"), at confidence 0.3-0.49
     * and with no wave. Absent or false on a named referent (0.5-0.69 from one input, 0.7+ when
     * two or more independent inputs agree).
     */
    generic?: boolean;
    desc?: string | null;
    source?: string | null;
    confidence?: number;
    /** Which inputs point at the referent: name, symbol, description, image, x, trend, chain, db. */
    supported_by?: string[];
    /** Rules 0.15.0+: how many coins TokenSage resolved to this referent in the hours before the read. */
    wave?: {
      launches_1h?: number | null;
      launches_6h?: number | null;
      launches_24h?: number | null;
      first_seen_at?: string | null;
      rank_24h?: number | null;
    } | null;
  } | null;
  categories?: TokenSageCategory[];
  /**
   * Rules 0.20.0+: the coin's strongest top-level theme (animal, celebrity, ...), its own or
   * inherited from the coin it copies. `derivative` is the main category only when the coin has
   * no theme at all; null when categories is empty. Absent on older reads.
   */
  main_category?: TokenSageCategory | null;
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
    /**
     * On a recent same-name copy: this coin's place by launch time among the coins with that
     * name or ticker launched within rank_window_hours of it (1 = earliest), out of rank_of.
     */
    rank?: number | null;
    rank_of?: number | null;
    rank_window_hours?: number | null;
    /** Rules 0.15.0+: seconds from the copied coin's launch to this one's, and its curve at the read. */
    original_age_s?: number | null;
    original_market?: {
      complete?: boolean | null;
      curve_progress?: number | null;
      graduated_pool?: string | null;
      as_of?: string | null;
    } | null;
    match?: string[];
    image_distance?: number | null;
  }[];
  /**
   * Rules 0.15.0+: which copy of what this coin is. `kind` is "original", "early_copy" (rank <= 3
   * and the original under 6 h old), "late_copy" (rank > 10 or the original over 24 h old),
   * "copy" (between), "reference" (builds on an established coin) or "unknown". The siblings
   * counts take in same-name, same-ticker and near-identical-logo coins launched before this one.
   */
  lineage?: {
    kind?: string;
    of_mint?: string | null;
    of_name?: string | null;
    of_ticker?: string | null;
    of_created_at?: string | null;
    rank?: number | null;
    rank_of?: number | null;
    window_hours?: number | null;
    siblings_1h?: number | null;
    siblings_6h?: number | null;
    siblings_24h?: number | null;
    logo_reuse_24h?: number | null;
    logo_first_seen_at?: string | null;
  } | null;
  image?: {
    status?: string;
    phash?: string | null;
    ocr?: string[];
    near_duplicates?: unknown[];
    animated?: boolean | null;
    /**
     * Rules 0.25.0+, full depth: the three visual classes the logo is closest to, best first
     * (dog, cat, pepe_wojak, text_logo, ... 25 in all; kept open). What the picture looks like,
     * not what the coin is about: the theme is still main_category. Empty at basic depth and
     * when the logo couldn't be read. Scores are each 0-1 and need not sum to 1.
     */
    labels?: { label?: string; score?: number; model?: string }[];
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
    /** Rules 0.15.0+: the author's or profile's account, apart from how well it fits the coin. */
    account?: {
      created_at?: string | null;
      age_at_launch_s?: number | null;
      posts_total?: number | null;
      posts_about_coin?: number | null;
      name_changes?: number | null;
      verified_type?: string | null;
      made_for_coin?: boolean | null;
    } | null;
    /**
     * Rules 0.15.0+: 0-1 from account age, followers, posting history and verification. Context
     * about the account, not about what the post says. Rules 0.23.0 made it gentler: a renamed or
     * made-for-coin account costs x0.85 (was x0.5) and late link reuse floors at x0.75 (was x0.4),
     * so values from before and after that change don't compare.
     */
    credibility?: number | null;
    /** Rules 0.15.0+: this coin's place among the coins that linked the same post or profile (1 = first). */
    reuse_rank?: number | null;
    reuse_first_at?: string | null;
  } | null;
  trend?: {
    matched?: boolean;
    /** Rules 0.15.0+: strength of the hit, 0-1. */
    score?: number | null;
    /**
     * One hit per source: "wikipedia", "google_trends", "news", and from rules 0.18.0 "x_trends"
     * (X's trending topics: rank 1-50 and hours listed) and "bluesky" (posts in 24 h from at
     * least 3 accounts). Kept open: TokenSage adds sources without a schema bump.
     */
    terms?: {
      term: string;
      source: string;
      spike?: number | null;
      score?: number | null;
      seen_at?: string | null;
      /** Which input hit: "name", "description", ... and from rules 0.18.0 "symbol" (the ticker). */
      matched_on?: string | null;
      /** Rules 0.18.0+: true when one rare word of the name matched inside a longer trending label. */
      partial?: boolean | null;
      searches?: number | null;
      rank?: number | null;
      hours?: number | null;
      posts?: number | null;
      headline?: string | null;
    }[];
    /**
     * Rules 0.15.0+, full reads: each source's status ("ok", "stale", "failed", "skipped", "unavailable");
     * five entries from 0.18.0. `detail` says why a source was skipped (an everyday-word name).
     */
    sources?: {
      source?: string;
      status?: string;
      as_of?: string | null;
      terms?: number | null;
      detail?: string | null;
    }[];
  } | null;
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
  /**
   * On a failed job: "<code>: <detail>", e.g. "token_not_found: no account found on-chain".
   * From rules 0.28.0 a job whose worker crashed job_max_attempts times ends failed with
   * "worker died" (before, it stayed pending for good).
   */
  error?: string | null;
}

export interface TokenSageBatchResult {
  items: TokenSageBatchItem[];
  /** X-Quota-Full-Remaining: full-depth analyses this key may still start today. Null if absent. */
  fullRemaining: number | null;
}

/** POST /v1/tokens:batch takes at most this many CAs. */
export const TOKENSAGE_BATCH_MAX = 50;
/**
 * The mints the prefetch sends per batch call. TokenSage enqueues a batch's items one by one
 * (a transaction and a quota lock each), so a full 50 under load took longer than the 8 s
 * timeout: on 2026-10-08 most full batches timed out and the backlog only grew. Smaller calls
 * finish, and the flush sends a couple of them per pass.
 */
export const TOKENSAGE_PREFETCH_CHUNK = 20;
/**
 * A batch call's timeout, at least this however short TOKENSAGE_TIMEOUT_MS is: the call does up
 * to TOKENSAGE_PREFETCH_CHUNK enqueues on TokenSage's side and nothing waits on it.
 */
export const TOKENSAGE_BATCH_MIN_TIMEOUT_MS = 20_000;

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
      timeoutMs: Math.max(this.timeoutMs, TOKENSAGE_BATCH_MIN_TIMEOUT_MS),
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
      timeoutMs: Math.max(this.timeoutMs, TOKENSAGE_BATCH_MIN_TIMEOUT_MS),
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
  /** main_category.label (rules 0.20.0+); null on older reads and when there are no categories. */
  mainCategory: string | null;
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  /** Inputs that point at the referent (referent.supported_by); two or more is far stronger. */
  referentSupport: string[];
  /**
   * Rules 0.17.0+: true when only the referent's kind is known (referent.generic), false on a
   * named referent (and on every referent from older rules, which were all named), null without
   * a referent.
   */
  referentGeneric: boolean | null;
  summary: string | null;
  flags: string[];
  xFit: number | null;
  xVerdict: string | null;
  /** market.pair.kind and symbol: what the coin trades against ("sol", "token", ...). */
  pairKind: string | null;
  pairSymbol: string | null;
  /**
   * Rules 0.27.0+ (market.pair.pumpfun): the pair token is itself a pump.fun coin. Null for SOL,
   * stablecoins and majors, on older reads, and when TokenSage doesn't know.
   */
  pairPumpfun: boolean | null;
  /**
   * Rules 0.25.0+, full reads (image.labels): the logo's best visual class ("dog", "text_logo",
   * ...; kept open) and its score 0-1. What the picture looks like, not what the coin is about.
   * Null at basic depth, when the logo couldn't be read, and on older reads.
   */
  logoLabel: string | null;
  logoScore: number | null;
  /**
   * True when the coin copies a coin launched in the last 30 days (copy_of[].recent), false
   * when it copies nothing recent, null for analyses made before TokenSage said which.
   */
  copiesRecent: boolean | null;
  /**
   * How the linked X post relates to the coin (x.relation: "launch_announcement",
   * "official_account", "narrative_reference", "spoofed", "search_only"; kept open). Null when
   * the post was not read (basic depth, no link, or a fetch that failed).
   */
  xRelation: string | null;
  /** The post author's follower count, when the post was read. */
  xAuthorFollowers: number | null;
  /** Seconds the linked post predates the token's creation (negative: posted after launch). */
  xPredatesTokenS: number | null;
  /** How many other coins have linked the same post (x.reuse_count). */
  xReuseCount: number | null;
  /** The name matched a Wikipedia or news spike (trend.matched); null until the full read says. */
  trendMatched: boolean | null;
  /**
   * Rules 0.15.0+ (TokenNarrative's columns of the same names, all null on older reads): the
   * coin's lineage, the coin it copies, how many coins shared its name, ticker or logo before
   * it, the referent wave, how many inputs agree on the main category (the top one before rules 0.20.0), the X account's
   * credibility and age, and the trend score.
   */
  lineageKind: string | null;
  lineageRank: number | null;
  lineageRankOf: number | null;
  lineageOfMint: string | null;
  originalAgeS: number | null;
  originalCurveProgress: number | null;
  originalComplete: boolean | null;
  siblings1h: number | null;
  siblings6h: number | null;
  siblings24h: number | null;
  logoReuse24h: number | null;
  waveLaunches1h: number | null;
  waveLaunches6h: number | null;
  waveLaunches24h: number | null;
  waveRank24h: number | null;
  topCategoryInputs: number | null;
  xCredibility: number | null;
  xAccountAgeS: number | null;
  xAccountMadeForCoin: boolean | null;
  xReuseRank: number | null;
  trendScore: number | null;
  /**
   * Rules 0.19.0+ (market.creator_fee): where the coin's creator fee goes (creator,
   * holder_rewards, wallet, split, github, charity, cashback, ...; kept open), how it is routed,
   * the creator's own share of it (0-1), whether the split can still change, and TokenSage's
   * one-line summary. All null when the read has no creator_fee (older rules, a non-pump.fun
   * mint, or a coin read before it was on-chain): missing and null mean the same.
   */
  feeDestination: string | null;
  feeMechanism: string | null;
  feeCreatorShare: number | null;
  feeMutable: boolean | null;
  feeSummary: string | null;
  /**
   * Flag counts by severity, so a reader needs no catalogue of codes. 0 when there are none.
   * Severity as of today's rules (tokenSageFlagSeverity): recycled_x_account counts as info.
   */
  highFlagCount: number;
  warnFlagCount: number;
  rulesVersion: string | null;
  /** versions.lexicon: some TokenSage changes ship without a rules bump and split only on this. */
  lexiconVersion: string | null;
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
  const flagRecords = asArray(doc.flags).map(asRecord);
  const flags = labels(
    flagRecords.map((f) => f?.code),
    30,
  );
  const severityCount = (severity: string) =>
    flagRecords.filter((f) => f !== null && tokenSageFlagSeverity(f.code, f.severity) === severity).length;
  const analyzedAt = typeof doc.analyzed_at === "string" ? new Date(doc.analyzed_at) : null;
  const referent = asRecord(doc.referent);
  const x = asRecord(doc.x);
  const match = asRecord(x?.match);
  const verdict = clip(match?.verdict);
  // Only a post that was actually read says anything about the link; anything else is unknown.
  const xRead = x !== null && x.status === "ok";
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  const trend = asRecord(doc.trend);
  const known = verdict !== null && verdict !== "unknown" ? verdict.slice(0, 40) : null;
  const pair = asRecord(asRecord(doc.market)?.pair);
  const copies = asArray(doc.copy_of).map(asRecord);
  const marked = copies.filter((c) => typeof c?.recent === "boolean");
  const copiesRecent =
    copies.length === 0 ? false : marked.length > 0 ? marked.some((c) => c!.recent === true) : null;
  // Rules 0.15.0+. The lineage names the original; its age and curve ride on the matching
  // copy_of item (or the first that carries them).
  const lineage = asRecord(doc.lineage);
  const lineageOfMint = clip(lineage?.of_mint)?.slice(0, 64) ?? null;
  const original =
    copies.find((c) => c !== null && lineageOfMint !== null && c.mint === lineageOfMint) ??
    copies.find((c) => c !== null && typeof c.original_age_s === "number") ??
    null;
  const originalMarket = asRecord(original?.original_market);
  const wave = asRecord(referent?.wave);
  // Rules 0.20.0+ name the main category; older reads fall back to the one TokenSage is surest of.
  const main = asRecord(doc.main_category);
  const mainCategory = clip(main?.label)?.slice(0, 80) ?? null;
  const top =
    (mainCategory !== null ? main : null) ??
    asArray(doc.categories)
      .map(asRecord)
      .filter((c): c is Record<string, unknown> => c !== null && unit(c.confidence) !== null)
      .sort((a, b) => unit(b.confidence)! - unit(a.confidence)!)[0];
  const account = xRead ? asRecord(x.account) : null;
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  const fee = creatorFeeFields(asRecord(asRecord(doc.market)?.creator_fee));
  const logo = asArray(asRecord(doc.image)?.labels)
    .map(asRecord)
    .map((l) => ({ label: clip(l?.label)?.slice(0, 40) ?? null, score: unit(l?.score) }))
    .filter((l): l is { label: string; score: number } => l.label !== null && l.score !== null)
    .sort((a, b) => b.score - a.score)[0];
  return {
    ...fee,
    pairPumpfun: bool(pair?.pumpfun),
    logoLabel: logo?.label ?? null,
    logoScore: logo?.score ?? null,
    lineageKind: clip(lineage?.kind)?.slice(0, 40) ?? null,
    lineageRank: count(lineage?.rank),
    lineageRankOf: count(lineage?.rank_of),
    lineageOfMint,
    originalAgeS: count(original?.original_age_s),
    originalCurveProgress: unit(originalMarket?.curve_progress),
    originalComplete: bool(originalMarket?.complete),
    siblings1h: count(lineage?.siblings_1h),
    siblings6h: count(lineage?.siblings_6h),
    siblings24h: count(lineage?.siblings_24h),
    logoReuse24h: count(lineage?.logo_reuse_24h),
    waveLaunches1h: count(wave?.launches_1h),
    waveLaunches6h: count(wave?.launches_6h),
    waveLaunches24h: count(wave?.launches_24h),
    waveRank24h: count(wave?.rank_24h),
    topCategoryInputs: top && Array.isArray(top.inputs) ? top.inputs.length : null,
    xCredibility: xRead ? unit(x.credibility) : null,
    xAccountAgeS: count(account?.age_at_launch_s),
    // The account block says so directly; the x_account_made_for_coin flag (info) says the same.
    xAccountMadeForCoin:
      bool(account?.made_for_coin) ?? (xRead && flags.includes("x_account_made_for_coin") ? true : null),
    xReuseRank: xRead ? count(x.reuse_rank) : null,
    trendScore: unit(trend?.score),
    depth: doc.depth === "full" ? "full" : "basic",
    status,
    categories,
    mainCategory,
    referentLabel: clip(referent?.label),
    referentKind: clip(referent?.kind),
    referentConfidence: referent ? unit(referent.confidence) : null,
    referentSupport: labels(referent?.supported_by, 10),
    referentGeneric: referent ? referent.generic === true : null,
    summary: clip(doc.summary),
    flags,
    xFit: known !== null ? unit(match?.fit) : null,
    xVerdict: known,
    pairKind: clip(pair?.kind)?.slice(0, 40) ?? null,
    pairSymbol: clip(pair?.symbol)?.slice(0, 40) ?? null,
    copiesRecent,
    xRelation: xRead ? (clip(x.relation)?.slice(0, 40) ?? null) : null,
    xAuthorFollowers: xRead ? count(asRecord(x.author)?.followers) : null,
    xPredatesTokenS: xRead ? count(x.predates_token_by_s) : null,
    xReuseCount: xRead ? count(x.reuse_count) : null,
    trendMatched: trend !== null && typeof trend.matched === "boolean" ? trend.matched : null,
    highFlagCount: severityCount("high"),
    warnFlagCount: severityCount("warn"),
    rulesVersion: clip(asRecord(doc.versions)?.rules),
    lexiconVersion: clip(asRecord(doc.versions)?.lexicon)?.slice(0, 40) ?? null,
    analyzedAt: analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : null,
  };
}

/** Fee destinations where the creator wallet gets none of the fee and no split is involved. */
const FEE_TO_OTHERS_ONLY = new Set(["holder_rewards", "cashback"]);

/** The creator-fee columns from market.creator_fee (rules 0.19.0+); all null without one. */
function creatorFeeFields(
  fee: Record<string, unknown> | null,
): Pick<
  TokenNarrativeFields,
  "feeDestination" | "feeMechanism" | "feeCreatorShare" | "feeMutable" | "feeSummary"
> {
  const destination = clip(fee?.destination)?.slice(0, 40) ?? null;
  if (!fee || destination === null) {
    return {
      feeDestination: null,
      feeMechanism: null,
      feeCreatorShare: null,
      feeMutable: null,
      feeSummary: null,
    };
  }
  const shares = asRecord(fee.shares);
  // The shares say it outright; without them, a direct fee is all the creator's and a holder-
  // rewards or cashback fee none of it. An unreadable config ("unknown") says nothing.
  const creatorShare = shares
    ? (unit(shares.creator) ?? 0)
    : destination === "creator"
      ? 1
      : FEE_TO_OTHERS_ONLY.has(destination)
        ? 0
        : null;
  return {
    feeDestination: destination,
    feeMechanism: clip(fee.mechanism)?.slice(0, 40) ?? null,
    feeCreatorShare: destination === "unknown" ? null : creatorShare,
    feeMutable: typeof fee.mutable === "boolean" ? fee.mutable : null,
    feeSummary: clip(fee.summary)?.slice(0, 300) ?? null,
  };
}

/**
 * The most of one Analysis document TokenNarrative.analysis keeps, as serialized JSON. A read is
 * a few KB; the free-text members (the launcher's own text, echoed back) are the only ones that
 * grow without bound, and one oversized row would be read back on every card and admin view of
 * the token. Over the cap the document is stored without them (STORED_ANALYSIS_TRIMMED_PATHS);
 * still over it, not at all - the columns narrativeFieldsFromAnalysis derived are kept either way.
 */
export const STORED_ANALYSIS_MAX_BYTES = 64 * 1024;
/**
 * Dropped first from an oversized document, in order: the free-text members nothing stored
 * derives from (narrativeFieldsFromAnalysis reads none of them; narrativeDetails reads the quoted
 * and replied-to post text, clipped to 280 chars, so those go last).
 */
const STORED_ANALYSIS_TRIMMED_PATHS: readonly (readonly string[])[] = [
  ["raw"],
  ["evidence"],
  ["caveats"],
  ["image", "ocr"],
  ["image", "near_duplicates"],
  ["x", "text"],
  ["x", "quoted", "text"],
  ["x", "replied_to", "text"],
];

/**
 * The Analysis document as it is kept in TokenNarrative.analysis: NUL characters removed (jsonb
 * rejects them), anything that isn't plain JSON dropped, and no larger than
 * STORED_ANALYSIS_MAX_BYTES. Null if it isn't an object, or can't be brought under the cap.
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
  if (!asRecord(analysis)) return null;
  const doc = clean(analysis, 0) as Record<string, unknown>;
  const size = JSON.stringify(doc).length;
  if (size <= STORED_ANALYSIS_MAX_BYTES) return doc;

  let dropped = 0;
  for (const path of STORED_ANALYSIS_TRIMMED_PATHS) {
    let holder: Record<string, unknown> | null = doc;
    for (const key of path.slice(0, -1)) holder = holder ? asRecord(holder[key]) : null;
    const leaf = path[path.length - 1]!;
    if (holder && holder[leaf] !== undefined) {
      delete holder[leaf];
      dropped += 1;
    }
  }
  const trimmedSize = JSON.stringify(doc).length;
  const mint = typeof doc.mint === "string" ? doc.mint : undefined;
  if (trimmedSize <= STORED_ANALYSIS_MAX_BYTES) {
    logger.warn("TokenSage analysis over the stored size cap; stored without its free text", {
      mint,
      bytes: size,
      trimmedBytes: trimmedSize,
      dropped,
    });
    return doc;
  }
  logger.warn("TokenSage analysis over the stored size cap even trimmed; not stored", {
    mint,
    bytes: size,
    trimmedBytes: trimmedSize,
  });
  return null;
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
    /** Rules 0.27.0+: the pair token is itself a pump.fun coin; null when not known. */
    pumpfun: boolean | null;
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
  /**
   * Live copycat (recent: true, warn) vs reference to an established coin (false, info). On a
   * recent same-name copy, rank / rankOf / rankWindowHours read "3rd of 41 within 24 h".
   */
  copies: {
    ticker: string | null;
    name: string | null;
    recent: boolean | null;
    rank: number | null;
    rankOf: number | null;
    rankWindowHours: number | null;
  }[];
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

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** A copycat rank, kept only when it is a whole place within its count ("3rd of 41"). */
function copyRank(c: Record<string, unknown>) {
  const rank = positiveInt(c.rank);
  const rankOf = positiveInt(c.rank_of);
  const ok = rank !== null && rankOf !== null && rank <= rankOf;
  return {
    rank: ok ? rank : null,
    rankOf: ok ? rankOf : null,
    rankWindowHours: ok ? positiveInt(c.rank_window_hours) : null,
  };
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
            pumpfun: typeof pairRec?.pumpfun === "boolean" ? pairRec.pumpfun : null,
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
        ...copyRank(c),
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
