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
  error?: string | null;
}

export interface TokenSageJob {
  job_id: number;
  status: "pending" | "running" | "done" | "failed";
  ca?: string | null;
  depth?: TokenSageDepth | null;
  result?: { status?: string; analysis?: TokenSageAnalysis | null } | null;
  error?: string | null;
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
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /**
   * Prefetch: cached analyses come back at once, the rest as `pending` with a job id. Never
   * waits. No retries here: a 429/503 means "skip this cycle", and the caller backs off.
   */
  async batch(cas: string[], depth: TokenSageDepth): Promise<TokenSageBatchItem[]> {
    const body = await fetchJson<{ items?: TokenSageBatchItem[] }>(`${this.baseUrl}/v1/tokens:batch`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ cas: cas.slice(0, TOKENSAGE_BATCH_MAX), depth }),
      timeoutMs: this.timeoutMs,
      retries: 0,
    });
    return Array.isArray(body.items) ? body.items : [];
  }

  /** Polls one job. Polling does not count against TokenSage's daily quotas. */
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

/** What a TokenNarrative row stores, derived from one Analysis document. */
export interface TokenNarrativeFields {
  depth: TokenSageDepth;
  status: "complete" | "partial";
  categories: TokenSageCategory[];
  referentLabel: string | null;
  referentKind: string | null;
  summary: string | null;
  flags: string[];
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
  return {
    depth: analysis.depth === "full" ? "full" : "basic",
    status,
    categories,
    referentLabel: clip(analysis.referent?.label),
    referentKind: clip(analysis.referent?.kind),
    summary: clip(analysis.summary),
    flags,
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
