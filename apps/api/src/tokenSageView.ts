import type { TokenSageAnalysis } from "@trenchscanner/core";
import { topCategory } from "./routes/adminInsights.js";

/**
 * TokenSage's read of one token, shaped for the dashboard's TokenSage view (GET
 * /tokens/:mint/sage, opened from a card or a Telegram alert's link). A curated slice of the
 * stored Analysis document rather than the document itself: the parts worth showing a reader,
 * clipped, with the creator wallet and the raw social links left out (a creator-fee recipient
 * other than the creator keeps its address, linked to Solscan, as TokenSage suggests). Every string here is
 * launcher-supplied or derived from it, so the page renders it as text, never as HTML.
 *
 * It carries TokenSage's interpretation only. The Narrative seat's agrees/warns note is a model
 * call (switched off on the cards until it is better trained) and is deliberately not part of it.
 */

export interface SageView {
  mint: string;
  token: {
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    firstSeenAt: string | null;
  } | null;
  /** "ok": a read is stored; "failed": TokenSage gave a definitive no; "none": nothing yet. */
  status: "ok" | "failed" | "none";
  failReason: string | null;
  read: SageRead | null;
  /** Market cap at each stored scan, oldest first, for the chart. */
  marketCap: { t: string; usd: number }[];
  /** How the models' calls on coins in this coin's top narrative graded over the last week. */
  track: SageTrack | null;
}

export interface SageRead {
  depth: string;
  analyzedAt: string | null;
  rulesVersion: string | null;
  launchpad: string | null;
  curveProgress: number | null;
  pair: { kind: string | null; symbol: string | null } | null;
  creatorFee: SageCreatorFee | null;
  summary: string | null;
  tickerExplanation: string | null;
  referent: {
    label: string;
    kind: string | null;
    desc: string | null;
    confidence: number | null;
    generic: boolean;
    supportedBy: string[];
    wave: {
      launches1h: number | null;
      launches6h: number | null;
      launches24h: number | null;
      rank24h: number | null;
    } | null;
  } | null;
  categories: { label: string; confidence: number; inputs: string[] }[];
  lineage: {
    kind: string;
    ofName: string | null;
    ofTicker: string | null;
    ofMint: string | null;
    rank: number | null;
    rankOf: number | null;
    siblings1h: number | null;
    siblings6h: number | null;
    siblings24h: number | null;
    logoReuse24h: number | null;
  } | null;
  copyOf: { ticker: string | null; name: string | null; mint: string | null; recent: boolean | null }[];
  x: {
    url: string | null;
    read: boolean;
    relation: string | null;
    text: string | null;
    postedAt: string | null;
    author: {
      handle: string | null;
      name: string | null;
      followers: number | null;
      verified: string | null;
    } | null;
    predatesTokenS: number | null;
    reuseCount: number | null;
    reuseRank: number | null;
    credibility: number | null;
    accountAgeS: number | null;
    madeForCoin: boolean | null;
    verdict: string | null;
    fit: number | null;
    basis: string[];
  } | null;
  trend: {
    matched: boolean;
    score: number | null;
    terms: {
      term: string;
      source: string;
      score: number | null;
      rank: number | null;
      headline: string | null;
    }[];
  } | null;
  flags: { code: string; severity: string; detail: string | null }[];
  evidence: { label: string; weight: number; detail: string | null; where: string | null }[];
  caveats: string[];
}

/** Where the coin's creator fee goes (TokenSage rules 0.19.0, market.creator_fee). */
export interface SageCreatorFee {
  /** creator | holder_rewards | wallet | split | github | charity | cashback | ...; kept open. */
  destination: string;
  mechanism: string | null;
  /** TokenSage's one-line summary, shown as is. */
  summary: string | null;
  /** True while the admin can still change the split. */
  mutable: boolean | null;
  /** Share of the fee per recipient kind, largest first. */
  shares: { kind: string; share: number }[];
  recipients: {
    kind: string;
    share: number | null;
    /** The GitHub login, or a shortened wallet address; null for the creator's own wallet. */
    label: string | null;
    /** https://github.com/<login>, api.github.com/user/<id>, or the wallet on Solscan. */
    url: string | null;
    /** GitHub: SOL claimed across all its coins. Charity: what this coin donated, in its quote token. */
    lifetimeReceived: number | null;
  }[];
}

export interface SageTrackDay {
  day: string;
  alerts: number;
  graded: number;
  won2x: number;
}

export interface SageTrack {
  label: string;
  /** Per UTC day: coins read under the label, and the models' calls on them. */
  days: (SageTrackDay & { count: number })[];
  /** The same days across every category, for comparison. */
  all: SageTrackDay[];
}

/** One LighthouseDayLabel row, as the track needs it. */
export interface DayLabelRow {
  day: Date;
  label: string;
  count: number;
  alerts: number;
  graded: number;
  won2x: number;
}

const MAX_SUMMARY = 900;
const MAX_TEXT = 320;
const MAX_CATEGORIES = 8;
const MAX_EVIDENCE = 8;
const MAX_FLAGS = 10;
const MAX_TERMS = 6;
const MAX_CAVEATS = 5;
const MAX_COPIES = 3;
const MAX_FEE_RECIPIENTS = 10;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GITHUB_URL = /^https:\/\/(github\.com\/[A-Za-z0-9-]{1,39}|api\.github\.com\/user\/\d{1,15})$/;

/**
 * market.creator_fee as the view shows it; null when the read has none (older rules, a
 * non-pump.fun mint, a coin read before it was on-chain): missing and null mean the same.
 */
export function sageCreatorFee(fee: unknown): SageCreatorFee | null {
  if (!fee || typeof fee !== "object" || Array.isArray(fee)) return null;
  const f = fee as NonNullable<NonNullable<TokenSageAnalysis["market"]>["creator_fee"]>;
  const destination = clip(f.destination, 30);
  if (!destination) return null;
  const shares =
    f.shares && typeof f.shares === "object" && !Array.isArray(f.shares)
      ? Object.entries(f.shares)
          .filter((e): e is [string, number] => num(e[1]) !== null && e[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_FEE_RECIPIENTS)
          .map(([kind, share]) => ({ kind: clip(kind, 20) ?? "other", share: Math.min(1, share) }))
      : [];
  const recipients = (Array.isArray(f.recipients) ? f.recipients : [])
    .filter((r) => r && typeof r === "object")
    .slice(0, MAX_FEE_RECIPIENTS)
    .map((r) => {
      const kind = clip(r.kind, 20) ?? "unresolved";
      const own = r.is_creator === true || kind === "creator";
      const address = typeof r.address === "string" && BASE58.test(r.address) ? r.address : null;
      const github = typeof r.url === "string" && GITHUB_URL.test(r.url) ? r.url : null;
      const login = clip(r.github_login, 39);
      return {
        kind,
        share: num(r.share),
        label: own
          ? null
          : login && /^[A-Za-z0-9-]+$/.test(login)
            ? login
            : address
              ? `${address.slice(0, 4)}…${address.slice(-4)}`
              : null,
        url: own ? null : (github ?? (address ? `https://solscan.io/account/${address}` : null)),
        lifetimeReceived: num(r.lifetime_received),
      };
    });
  return {
    destination,
    mechanism: clip(f.mechanism, 30),
    summary: clip(f.summary),
    mutable: typeof f.mutable === "boolean" ? f.mutable : null,
    shares,
    recipients,
  };
}

function clip(text: unknown, max = MAX_TEXT): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown, max = 10): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, max) : [];
}

/** A link to the X post or profile, only ever to x.com / twitter.com over https. */
export function xUrl(doc: TokenSageAnalysis): string | null {
  const id = doc.x?.ref?.tweet_id;
  if (typeof id === "string" && /^\d{1,25}$/.test(id)) return `https://x.com/i/status/${id}`;
  const raw = doc.raw?.twitter?.trim() ?? "";
  return /^https:\/\/(www\.)?(x|twitter)\.com\/[^\s"'<>]+$/i.test(raw) ? raw : null;
}

/** The read itself, from the stored Analysis document; null when there is none to show. */
export function sageRead(doc: TokenSageAnalysis | null | undefined, depth: string): SageRead | null {
  if (!doc || typeof doc !== "object") return null;
  const ref = doc.referent;
  const lin = doc.lineage;
  const x = doc.x;
  const xRead = x?.status === "ok";
  const url = xUrl(doc);
  const categories = (Array.isArray(doc.categories) ? doc.categories : [])
    .filter((c) => typeof c?.label === "string" && typeof c.confidence === "number")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_CATEGORIES)
    .map((c) => ({ label: c.label, confidence: c.confidence, inputs: strings(c.inputs) }));
  const evidence = (Array.isArray(doc.evidence) ? doc.evidence : [])
    .filter((e) => typeof e?.label === "string" && typeof e.weight === "number" && e.weight > 0)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    // The same label from the same place (an entity matched twice) shows once, at its strongest.
    .filter((e, i, all) => all.findIndex((o) => o.label === e.label && o.where === e.where) === i)
    .slice(0, MAX_EVIDENCE)
    .map((e) => ({ label: e.label!, weight: e.weight!, detail: clip(e.detail), where: clip(e.where, 40) }));
  return {
    depth,
    analyzedAt: typeof doc.analyzed_at === "string" ? doc.analyzed_at : null,
    rulesVersion: clip(doc.versions?.rules, 20),
    launchpad: clip(doc.launchpad, 40),
    curveProgress: num(doc.market?.curve_progress),
    pair: doc.market?.pair
      ? { kind: clip(doc.market.pair.kind, 30), symbol: clip(doc.market.pair.symbol, 20) }
      : null,
    creatorFee: sageCreatorFee(doc.market?.creator_fee),
    summary: clip(doc.summary, MAX_SUMMARY),
    tickerExplanation: clip(doc.ticker_explanation),
    referent:
      ref && typeof ref.label === "string" && ref.label.trim()
        ? {
            label: clip(ref.label, 80)!,
            kind: clip(ref.kind, 30),
            desc: clip(ref.desc),
            confidence: num(ref.confidence),
            generic: ref.generic === true,
            supportedBy: strings(ref.supported_by),
            wave: ref.wave
              ? {
                  launches1h: num(ref.wave.launches_1h),
                  launches6h: num(ref.wave.launches_6h),
                  launches24h: num(ref.wave.launches_24h),
                  rank24h: num(ref.wave.rank_24h),
                }
              : null,
          }
        : null,
    categories,
    lineage:
      lin && typeof lin.kind === "string"
        ? {
            kind: lin.kind,
            ofName: clip(lin.of_name, 80),
            ofTicker: clip(lin.of_ticker, 30),
            ofMint: clip(lin.of_mint, 50),
            rank: num(lin.rank),
            rankOf: num(lin.rank_of),
            siblings1h: num(lin.siblings_1h),
            siblings6h: num(lin.siblings_6h),
            siblings24h: num(lin.siblings_24h),
            logoReuse24h: num(lin.logo_reuse_24h),
          }
        : null,
    copyOf: (Array.isArray(doc.copy_of) ? doc.copy_of : []).slice(0, MAX_COPIES).map((c) => ({
      ticker: clip(c?.ticker, 30),
      name: clip(c?.name, 80),
      mint: clip(c?.mint, 50),
      recent: typeof c?.recent === "boolean" ? c.recent : null,
    })),
    x:
      x && (xRead || url)
        ? {
            url,
            read: xRead,
            relation: clip(x.relation, 40),
            text: xRead ? clip(x.text, 400) : null,
            postedAt: typeof x.object_time === "string" ? x.object_time : null,
            author: x.author
              ? {
                  handle: clip(x.author.handle, 40),
                  name: clip(x.author.name, 80),
                  followers: num(x.author.followers),
                  verified: clip(x.author.verified_type, 20),
                }
              : null,
            predatesTokenS: num(x.predates_token_by_s),
            reuseCount: num(x.reuse_count),
            reuseRank: num(x.reuse_rank),
            credibility: num(x.credibility),
            accountAgeS: num(x.account?.age_at_launch_s),
            madeForCoin: typeof x.account?.made_for_coin === "boolean" ? x.account.made_for_coin : null,
            verdict: clip(x.match?.verdict, 30),
            fit: num(x.match?.fit),
            basis: strings(x.match?.basis),
          }
        : null,
    trend: doc.trend
      ? {
          matched: doc.trend.matched === true,
          score: num(doc.trend.score),
          terms: (Array.isArray(doc.trend.terms) ? doc.trend.terms : [])
            .filter((t) => typeof t?.term === "string" && typeof t.source === "string")
            .slice(0, MAX_TERMS)
            .map((t) => ({
              term: clip(t.term, 80)!,
              source: clip(t.source, 30)!,
              score: num(t.score),
              rank: num(t.rank),
              headline: clip(t.headline, 200),
            })),
        }
      : null,
    flags: (Array.isArray(doc.flags) ? doc.flags : [])
      .filter((f) => typeof f?.code === "string")
      .slice(0, MAX_FLAGS)
      .map((f) => ({ code: f.code, severity: f.severity ?? "info", detail: clip(f.detail) })),
    evidence,
    caveats: strings(doc.caveats, MAX_CAVEATS)
      .map((c) => clip(c))
      .filter((c): c is string => c !== null),
  };
}

/**
 * The week's record for the coin's top narrative, next to every narrative's. Days with nothing
 * read under the label still appear (zeros), so the two series line up.
 */
export function sageTrack(rows: DayLabelRow[], categories: unknown): SageTrack | null {
  const label = topCategory(categories);
  if (!label) return null;
  const all = new Map<string, SageTrackDay>();
  const mine = new Map<string, SageTrackDay & { count: number }>();
  for (const r of rows) {
    const day = r.day.toISOString().slice(0, 10);
    const a = all.get(day) ?? { day, alerts: 0, graded: 0, won2x: 0 };
    a.alerts += r.alerts;
    a.graded += r.graded;
    a.won2x += r.won2x;
    all.set(day, a);
    if (r.label === label)
      mine.set(day, { day, count: r.count, alerts: r.alerts, graded: r.graded, won2x: r.won2x });
  }
  if (mine.size === 0) return null;
  const days = [...all.keys()].sort();
  return {
    label,
    days: days.map((day) => mine.get(day) ?? { day, count: 0, alerts: 0, graded: 0, won2x: 0 }),
    all: days.map((day) => all.get(day)!),
  };
}
