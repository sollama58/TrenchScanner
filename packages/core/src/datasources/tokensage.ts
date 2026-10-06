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

export interface TokenSageAnalysis {
  schema_version?: string;
  mint: string;
  referent?: { label: string; kind?: string; desc?: string | null; confidence?: number } | null;
  categories?: TokenSageCategory[];
  ticker_explanation?: string | null;
  copy_of?: { ticker?: string | null; name?: string | null; mint?: string | null; signals?: string[] }[];
  x?: {
    relation?: string | null;
    status?: string;
    predates_token_by_s?: number | null;
    reuse_count?: number;
    author?: { handle?: string | null; followers?: number | null; verified_type?: string | null } | null;
    /** How well the linked post or profile matches the token (rules 0.6.0+, full depth only). */
    match?: {
      name?: { score: number; how?: string };
      ticker?: { score: number; how?: string };
      image?: { score: number; best_distance?: number | null; media_checked?: number };
      referent?: {
        x_label?: string | null;
        x_kind?: string | null;
        agrees?: boolean | null;
        confidence?: number;
      };
      x_categories?: TokenSageCategory[];
      fit?: number;
      verdict?: "about_this_coin" | "related" | "unrelated" | "unknown";
    } | null;
  } | null;
  trend?: { matched?: boolean; terms?: { term: string; spike?: number | null; source: string }[] };
  flags?: TokenSageFlag[];
  summary?: string;
  caveats?: string[];
  depth: TokenSageDepth;
  analyzed_at: string;
  versions?: { rules?: string; lexicon?: string };
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
  summary: string | null;
  flags: string[];
  xFit: number | null;
  xVerdict: string | null;
  rulesVersion: string | null;
  analyzedAt: Date | null;
}

function clip(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
}

export function narrativeFieldsFromAnalysis(
  analysis: TokenSageAnalysis,
  status: "complete" | "partial",
): TokenNarrativeFields {
  const categories = (analysis.categories ?? [])
    .filter((c) => typeof c?.label === "string" && Number.isFinite(c.confidence))
    .map((c) => ({ label: c.label.slice(0, 80), confidence: Math.min(1, Math.max(0, c.confidence)) }))
    .slice(0, 20);
  const flags = [
    ...new Set((analysis.flags ?? []).map((f) => f?.code).filter((c): c is string => typeof c === "string")),
  ]
    .map((c) => c.slice(0, 60))
    .slice(0, 30);
  const analyzedAt = analysis.analyzed_at ? new Date(analysis.analyzed_at) : null;
  const match = analysis.x?.match;
  const known = match?.verdict !== undefined && match.verdict !== "unknown";
  const fit = known && typeof match?.fit === "number" && Number.isFinite(match.fit) ? match.fit : null;
  return {
    depth: analysis.depth === "full" ? "full" : "basic",
    status,
    categories,
    referentLabel: clip(analysis.referent?.label),
    referentKind: clip(analysis.referent?.kind),
    summary: clip(analysis.summary),
    flags,
    xFit: fit === null ? null : Math.min(1, Math.max(0, fit)),
    xVerdict: known ? clip(match?.verdict) : null,
    rulesVersion: clip(analysis.versions?.rules),
    analyzedAt: analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : null,
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
