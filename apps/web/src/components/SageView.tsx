import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { usePolling } from "../hooks";
import { ago, shortAddress, tokenThumb, usd } from "../format";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, LockIcon, SageIcon } from "./Icons";
import { Skeleton } from "./Charts";
import { closeSage, SAGE_PARAM } from "../sage";

/**
 * The TokenSage view: TokenSage's interpretation of one token (what it is about, why, which copy
 * of what, its X link, trends and flags), with charts from what TrenchScanner stores alongside
 * it. Opened from a card's TokenSage button or a Telegram alert's link (src/sage.ts). The data is
 * GET /tokens/:mint/sage (apps/api/src/tokenSageView.ts). Every string is launcher-derived and is
 * rendered as text.
 *
 * This is TokenSage's read only, not a call: the Narrative seat's agrees/warns note stays off
 * until that seat is better trained.
 */

/** Mirrors apps/api/src/tokenSageView.ts. */
export interface SageView {
  mint: string;
  token: {
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    firstSeenAt: string | null;
  } | null;
  status: "ok" | "failed" | "expired" | "none";
  failReason: string | null;
  read: SageRead | null;
  marketCap: { t: string; usd: number }[];
  track: SageTrack | null;
}

export interface SageRead {
  depth: string;
  analyzedAt: string | null;
  rulesVersion: string | null;
  launchpad: string | null;
  curveProgress: number | null;
  /** What the coin trades against; kind "token" is another coin (rules 0.27.0: any pump.fun coin). */
  pair: {
    kind: string | null;
    symbol: string | null;
    name: string | null;
    pumpfun: boolean | null;
    buildsOn: boolean;
    about: string | null;
  } | null;
  /** The logo's best visual class (rules 0.25.0+, full reads), when its score is 0.5 or more. */
  logo: { label: string; score: number } | null;
  /** Where the creator fee goes (rules 0.19.0); null on older reads. */
  creatorFee: {
    destination: string;
    mechanism: string | null;
    summary: string | null;
    mutable: boolean | null;
    shares: { kind: string; share: number }[];
    recipients: {
      kind: string;
      share: number | null;
      label: string | null;
      url: string | null;
      lifetimeReceived: number | null;
    }[];
  } | null;
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
  /** The coin's one theme: main_category (rules 0.20.0+), else the most confident category. */
  mainCategory: { label: string; confidence: number } | null;
  /**
   * How the coin relates to another, shown apart from its theme: the lineage kind when it copies
   * or builds on one, else "copy" from copy_of[] or a derivative category. Null on an original.
   */
  copyMark: string | null;
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

interface TrackDay {
  day: string;
  alerts: number;
  graded: number;
  won2x: number;
}
export interface SageTrack {
  label: string;
  days: (TrackDay & { count: number })[];
  all: TrackDay[];
}

/** The inputs TokenSage can read, in the order the view lists them. */
const INPUTS: { id: string; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "symbol", label: "Ticker" },
  { id: "description", label: "Description" },
  { id: "image", label: "Image" },
  { id: "x", label: "X" },
  { id: "trend", label: "Trends" },
  { id: "db", label: "Known coins" },
];

const LINEAGE: Record<string, { text: string; tone: "good" | "warn" | "neutral" }> = {
  original: { text: "Original", tone: "good" },
  early_copy: { text: "Early copy", tone: "neutral" },
  copy: { text: "Copy", tone: "warn" },
  late_copy: { text: "Late copy", tone: "warn" },
  reference: { text: "Builds on a known coin", tone: "neutral" },
};

/** TokenSage's logo classes (image.labels) as the tag reads them; others fall back to words(). */
const LOGO_CLASS: Record<string, string> = {
  bear_bull: "bear or bull",
  animal_other: "an animal",
  pepe_wojak: "Pepe / Wojak",
  meme_other: "a meme",
  elon: "Elon",
  person: "a person",
  cartoon_char: "a cartoon character",
  coin_logo: "a coin logo",
  text_logo: "text",
  screenshot: "a screenshot",
  flag: "a flag",
  crude: "crude art",
  object: "an object",
  politician: "a politician",
};

/** TokenSage's creator-fee destinations, as the view's tag names them. Kept open. */
const FEE_DESTINATION: Record<string, string> = {
  creator: "Goes to the creator",
  holder_rewards: "Goes to holders",
  wallet: "Goes to another wallet",
  split: "Split between wallets",
  github: "Goes to a GitHub account",
  charity: "Goes to charity",
  cashback: "Goes back to traders",
  social: "Goes to a social account",
  other: "Redirected",
  unknown: "Not readable",
};

/** Who a share of the fee goes to, by recipient kind. */
const FEE_RECIPIENT: Record<string, string> = {
  creator: "The creator",
  wallet: "Another wallet",
  github: "GitHub account",
  charity: "Charity (donate.gg)",
  x: "X account",
  pump: "pump.fun",
  social: "Social account",
  program: "A program",
  unresolved: "Unresolved",
};

const RELATION: Record<string, string> = {
  launch_announcement: "Launch announcement",
  official_account: "The coin's own account",
  narrative_reference: "A post the coin references",
  spoofed: "Spoofed",
};

const VERDICT: Record<string, string> = {
  about_this_coin: "About this coin",
  related: "Related",
  unrelated: "Unrelated",
};

const TREND_SOURCE: Record<string, string> = {
  wikipedia: "Wikipedia",
  google_trends: "Google Trends",
  news: "News",
  x_trends: "X trending",
  bluesky: "Bluesky",
};

export function words(label: string): string {
  const t = label.replace(/_/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** "animal/squirrel" -> "Animal · squirrel". */
export function categoryText(label: string): string {
  const [top, ...rest] = label.split("/");
  return [words(top ?? label), ...rest.map((r) => r.replace(/_/g, " "))].join(" · ");
}

/** A span of seconds in one unit: 45s, 12m, 3h, 2d. */
export function span(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  if (s < 2 * 31_536_000) return `${Math.round(s / 86_400)}d`;
  return `${Math.round(s / 31_536_000)}y`;
}

export function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** A SOL (or quote-token) amount: fee claims are often a fraction of one. */
export function amount(n: number): string {
  if (n >= 1e3) return count(n);
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
  if (n > 0 && n < 0.01) return "<0.01";
  return n.toFixed(2).replace(/\.?0+$/, "");
}

const pct0 = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Mounted once by the app. Renders the view for the mint in the address bar, if any: the read
 * for a subscriber, a prompt to connect for a guest.
 */
export function SageHost({
  mint,
  guest,
  onConnect,
}: {
  mint: string;
  guest: boolean;
  onConnect: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal sage-modal"
      aria-labelledby="sage-title"
      onClose={closeSage}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      {guest ? (
        <SageLocked onClose={() => ref.current?.close()} onConnect={onConnect} />
      ) : (
        <SageBody mint={mint} onClose={() => ref.current?.close()} />
      )}
    </dialog>
  );
}

function SageLocked({ onClose, onConnect }: { onClose: () => void; onConnect: () => void }) {
  return (
    <div className="about-body sage-locked">
      <header className="about-head">
        <h2 id="sage-title" className="sage-brand sage-title" tabIndex={-1} autoFocus>
          <SageIcon size={18} /> TokenSage read
        </h2>
        <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      <span className="paywall-icon">
        <LockIcon size={22} />
      </span>
      <p>
        TokenSage reads every coin&apos;s name, ticker, image and X link and says what it is about, which copy
        of what it is, and what looks off. Connect a wallet with access to open it.
      </p>
      <button
        className="button primary"
        // Not closed first: closing drops ?sage from the address bar, and the view is meant to
        // open after the sign-in. Leaving guest mode unmounts this dialog anyway.
        onClick={onConnect}
      >
        Connect wallet
      </button>
    </div>
  );
}

function SageBody({ mint, onClose }: { mint: string; onClose: () => void }) {
  // Refreshed while open: a quick read can be followed by the deep read a minute later.
  const { data, error } = usePolling<SageView>(`/tokens/${encodeURIComponent(mint)}/sage`, 60_000);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const t = data?.token;
  const r = data?.read ?? null;
  const label = t?.symbol ? `$${t.symbol}` : (t?.name ?? shortAddress(mint));
  const img = t?.imageUrl?.startsWith("https://") ? tokenThumb(t.imageUrl, 128) : null;

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set(SAGE_PARAM, mint);
    void navigator.clipboard?.writeText(url.toString()).then(() => {
      setShared(true);
      window.setTimeout(() => setShared(false), 1200);
    });
  };
  const copyMint = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="about-body sage-body">
      <header className="sage-head">
        <div className="sage-token">
          {img ? (
            <img className="avatar" src={img} alt="" width={44} height={44} referrerPolicy="no-referrer" />
          ) : (
            <span className="avatar placeholder">{label.replace("$", "").slice(0, 2)}</span>
          )}
          <div>
            <h2 id="sage-title" className="sage-title" tabIndex={-1} autoFocus>
              {label}
              {t?.name && t.symbol && <span className="token-name"> {t.name}</span>}
            </h2>
            <div className="sage-sub">
              <span className="sage-brand">
                <SageIcon size={13} /> TokenSage read
              </span>
              {r && (
                <>
                  <span className={`pill${r.depth === "full" ? " pill-model" : ""}`}>
                    {r.depth === "full" ? "Deep read" : "Quick read"}
                  </span>
                  {r.analyzedAt && <span className="when">{ago(r.analyzedAt)}</span>}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="sage-actions">
          <button
            type="button"
            className="ghost icon-btn"
            onClick={copyLink}
            title="Copy a link to this view"
            aria-label="Copy a link to this view"
          >
            {shared ? <CheckIcon size={15} /> : <ExternalIcon size={15} />}
          </button>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>

      {!data && !error && <Skeleton lines={6} />}
      {error && !data && (
        <p className="error">
          {error instanceof ApiError && error.status === 402
            ? "TokenSage reads come with a subscription."
            : error instanceof ApiError && error.status === 401
              ? "Sign in to open TokenSage reads."
              : `Couldn't load the read: ${error.message}`}
        </p>
      )}
      {data && !r && (
        <p className="muted sage-empty">
          {data.status === "failed"
            ? `TokenSage couldn't read this coin${data.failReason ? ` (${data.failReason})` : ""}.`
            : data.status === "expired"
              ? "TokenSage read this coin, but its reads are kept for three weeks and this one has been cleared."
              : "TokenSage hasn't read this coin yet. Reads usually land within a minute or two of launch."}
        </p>
      )}

      {r && <SageReadView read={r} view={data!} />}

      <footer className="sage-foot">
        <button className="mint" onClick={copyMint} title="Copy mint address">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "Copied" : shortAddress(mint)}
        </button>
        <span className="faint small">
          TokenSage&apos;s interpretation, not a buy signal
          {r?.rulesVersion ? ` · rules ${r.rulesVersion}` : ""}
        </span>
      </footer>
    </div>
  );
}

function SageReadView({ read: r, view }: { read: SageRead; view: SageView }) {
  const ref = r.referent;
  const supported = new Set(ref?.supportedBy ?? []);
  const lineage = r.lineage ? LINEAGE[r.lineage.kind] : undefined;
  // The copy mark rides beside the theme: a copy of an animal coin reads as animal, marked a copy.
  const copy = r.copyMark ? (LINEAGE[r.copyMark] ?? LINEAGE.copy) : undefined;
  // Paired with another coin: launched into its community. SOL, stablecoins and majors: no badge.
  const pairToken = r.pair?.kind === "token" ? r.pair : null;
  const high = r.flags.filter((f) => f.severity === "high");
  const others = r.flags.filter((f) => f.severity !== "high");
  const readAt = r.analyzedAt ? Date.parse(r.analyzedAt) : null;
  return (
    <>
      <section className="sage-hero">
        <ConfidenceRing value={ref?.confidence ?? null} />
        <div className="sage-hero-text">
          <span className="sage-eyebrow">
            {ref ? (ref.generic ? "A kind of coin" : "Refers to") : "Referent"}
          </span>
          <h3 className="sage-referent">{ref ? ref.label : "No clear referent"}</h3>
          {ref?.kind && <span className="pill">{words(ref.kind)}</span>}
          {(r.mainCategory || copy || pairToken || r.logo) && (
            <div className="sage-marks">
              {r.mainCategory && (
                <span
                  className="sage-tag"
                  title={`Main category: ${categoryText(r.mainCategory.label)}, ${pct0(r.mainCategory.confidence)} confidence`}
                >
                  {categoryText(r.mainCategory.label)}
                </span>
              )}
              {copy && <span className={`sage-tag tone-${copy.tone}`}>{copy.text}</span>}
              {pairToken && (
                <span
                  className="sage-tag tone-neutral"
                  title={
                    `Trades against ${pairToken.symbol ? `$${pairToken.symbol}` : "another coin"}` +
                    `${pairToken.name ? ` (${pairToken.name})` : ""} instead of SOL` +
                    `${pairToken.about ? `; it is about ${pairToken.about}` : ""}` +
                    `${pairToken.buildsOn ? "; this coin's name builds on it" : ""}`
                  }
                >
                  Paired with {pairToken.symbol ? `$${pairToken.symbol}` : "another coin"}
                  {pairToken.pumpfun ? " (pump.fun coin)" : ""}
                </span>
              )}
              {r.logo && (
                <span
                  className="sage-tag tone-neutral"
                  title={`What the logo looks like, ${pct0(r.logo.score)} sure. Not what the coin is about.`}
                >
                  Logo: {LOGO_CLASS[r.logo.label] ?? words(r.logo.label)}
                </span>
              )}
            </div>
          )}
          {ref?.desc && <p className="sage-desc">{ref.desc}</p>}
          {r.tickerExplanation && <p className="sage-ticker small">{r.tickerExplanation}</p>}
        </div>
      </section>

      <div className="sage-inputs" aria-label="Which inputs point at the referent">
        {INPUTS.map((i) => (
          <span
            key={i.id}
            className={`sage-input${supported.has(i.id) ? " on" : ""}`}
            title={supported.has(i.id) ? `${i.label} points at the referent` : `${i.label}: no support`}
          >
            {supported.has(i.id) && <CheckIcon size={11} />}
            {i.label}
          </span>
        ))}
      </div>

      {(high.length > 0 || others.length > 0) && (
        <ul className="sage-flags">
          {[...high, ...others].map((f) => (
            <li key={f.code} className={`sage-flag sev-${f.severity}`}>
              <span className="sage-flag-code">
                {f.severity === "high" ? "▲ " : f.severity === "warn" ? "● " : "○ "}
                {words(f.code)}
              </span>
              {f.detail && <span className="sage-flag-detail">{f.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {r.summary && <blockquote className="sage-summary">{r.summary}</blockquote>}

      <div className="sage-grid">
        {r.categories.length > 0 && (
          <section className="sage-card">
            <h4>What it&apos;s about</h4>
            <WeightBars
              rows={r.categories.map((c) => ({
                key: c.label,
                label: categoryText(c.label),
                value: c.confidence,
                title:
                  c.inputs.length > 0
                    ? `${categoryText(c.label)}: ${pct0(c.confidence)} confidence, from ${c.inputs.join(", ")}`
                    : `${categoryText(c.label)}: ${pct0(c.confidence)} confidence`,
              }))}
            />
          </section>
        )}
        {r.evidence.length > 0 && (
          <section className="sage-card">
            <h4>Strongest evidence</h4>
            <WeightBars
              series={2}
              rows={r.evidence.map((e, i) => ({
                key: `${e.label}-${i}`,
                label: categoryText(e.label) + (e.where ? ` · ${e.where}` : ""),
                value: Math.min(1, e.weight),
                title: e.detail ?? undefined,
              }))}
            />
          </section>
        )}
      </div>

      {(r.lineage || ref?.wave) && (
        <section className="sage-card">
          <h4>
            Lineage and crowd
            {lineage && <span className={`sage-tag tone-${lineage.tone}`}>{lineage.text}</span>}
          </h4>
          <LineageText read={r} />
          <CrowdChart read={r} />
        </section>
      )}

      {r.creatorFee && <FeeCard fee={r.creatorFee} />}

      {r.x && <XCard x={r.x} />}

      {r.trend && (r.trend.matched || r.trend.terms.length > 0) && (
        <section className="sage-card">
          <h4>
            Trending
            {r.trend.score !== null && (
              <span className="sage-tag tone-neutral">strength {pct0(r.trend.score)}</span>
            )}
          </h4>
          <ul className="sage-terms">
            {r.trend.terms.map((t, i) => (
              <li key={`${t.term}-${t.source}-${i}`} title={t.headline ?? undefined}>
                <strong>{t.term}</strong>
                <span className="muted small">
                  {TREND_SOURCE[t.source] ?? words(t.source)}
                  {t.rank !== null ? ` · #${t.rank}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.marketCap.length >= 3 && (
        <section className="sage-card">
          <h4>Market cap since we started scanning</h4>
          <McapChart points={view.marketCap} readAt={readAt} />
        </section>
      )}

      {view.track && <TrackChart track={view.track} />}

      {r.caveats.length > 0 && (
        <ul className="sage-caveats faint small">
          {r.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** TokenSage's lower-case fragment as a sentence. */
function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

/** Where the creator fee goes: TokenSage's sentence, each recipient's share, and links. */
function FeeCard({ fee }: { fee: NonNullable<SageRead["creatorFee"]> }) {
  const named = fee.recipients.filter((r) => r.label !== null || r.lifetimeReceived !== null);
  return (
    <section className="sage-card">
      <h4>
        Creator fee
        <span className="sage-tag tone-neutral">
          {FEE_DESTINATION[fee.destination] ?? FEE_DESTINATION.other}
        </span>
        {fee.mutable && <span className="sage-tag tone-neutral">Split can still change</span>}
      </h4>
      {fee.summary && <p>{sentence(fee.summary)}</p>}
      {fee.shares.length > 1 && (
        <WeightBars
          rows={fee.shares.map((s) => ({
            key: s.kind,
            label: FEE_RECIPIENT[s.kind] ?? words(s.kind),
            value: s.share,
          }))}
        />
      )}
      {named.length > 0 && (
        <ul className="sage-terms">
          {named.map((r, i) => (
            <li key={`${r.kind}-${i}`}>
              {r.url ? (
                <a href={r.url} target="_blank" rel="noopener noreferrer">
                  {r.label ?? FEE_RECIPIENT[r.kind] ?? words(r.kind)}
                </a>
              ) : (
                <strong>{r.label ?? FEE_RECIPIENT[r.kind] ?? words(r.kind)}</strong>
              )}
              <span className="muted small">
                {FEE_RECIPIENT[r.kind] ?? words(r.kind)}
                {r.share !== null ? ` · ${pct0(r.share)}` : ""}
                {r.lifetimeReceived !== null
                  ? r.kind === "charity"
                    ? ` · ${amount(r.lifetimeReceived)} donated by this coin`
                    : ` · ${amount(r.lifetimeReceived)} SOL claimed across its coins`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The referent's confidence as a ring, 0-100%. */
function ConfidenceRing({ value }: { value: number | null }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, value ?? 0));
  return (
    <svg
      className="sage-ring"
      viewBox="0 0 84 84"
      role="img"
      aria-label={value === null ? "No referent confidence" : `Referent confidence ${pct0(value)}`}
    >
      <defs>
        <linearGradient id="sage-ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-a)" />
          <stop offset="1" stopColor="var(--brand-b)" />
        </linearGradient>
      </defs>
      <circle cx="42" cy="42" r={r} className="ring-track" />
      <circle
        cx="42"
        cy="42"
        r={r}
        className="sage-ring-arc"
        strokeDasharray={`${c * frac} ${c}`}
        transform="rotate(-90 42 42)"
      />
      <text x="42" y="44" textAnchor="middle" className="sage-ring-value">
        {value === null ? "–" : pct0(value)}
      </text>
      <text x="42" y="58" textAnchor="middle" className="sage-ring-sub">
        sure
      </text>
    </svg>
  );
}

/** Horizontal 0-1 bars, one series, with the value at the end. */
function WeightBars({
  rows,
  series = 1,
}: {
  rows: { key: string; label: string; value: number; title?: string }[];
  series?: 1 | 2;
}) {
  return (
    <div className={`sage-bars s${series}`}>
      {rows.map((row) => (
        <div className="sage-bar" key={row.key} title={row.title}>
          <span className="sage-bar-label">{row.label}</span>
          <span className="sage-bar-track">
            <span className="sage-bar-fill" style={{ width: `${Math.max(2, row.value * 100)}%` }} />
          </span>
          <span className="sage-bar-value num">{pct0(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

function LineageText({ read: r }: { read: SageRead }) {
  const l = r.lineage;
  const of = l?.ofTicker ? `$${l.ofTicker}` : (l?.ofName ?? r.copyOf[0]?.name ?? null);
  const parts: string[] = [];
  if (l && of && l.kind !== "original" && l.kind !== "unknown") {
    parts.push(
      l.kind === "reference"
        ? `Builds on ${of}.`
        : `Copies ${of}${l.rank !== null && l.rankOf !== null ? `, #${l.rank} of ${l.rankOf} by launch time` : ""}.`,
    );
  } else if (l?.kind === "original") {
    parts.push("The first coin with this name, ticker and logo.");
  } else if (!l && r.copyOf[0]) {
    const c = r.copyOf[0];
    parts.push(
      `${c.recent ? "Copies" : "Builds on"} ${c.ticker ? `$${c.ticker}` : (c.name ?? "an earlier coin")}.`,
    );
  }
  if (l?.logoReuse24h)
    parts.push(
      `Its logo was used by ${l.logoReuse24h} other coin${l.logoReuse24h === 1 ? "" : "s"} in the last day.`,
    );
  const w = r.referent?.wave;
  if (w?.rank24h) parts.push(`${r.referent!.label} is the #${w.rank24h} theme of the last 24 hours.`);
  return parts.length > 0 ? <p className="small muted">{parts.join(" ")}</p> : null;
}

/** Namesakes launched before it and coins on the same theme, over 1h / 6h / 24h. */
function CrowdChart({ read: r }: { read: SageRead }) {
  const l = r.lineage;
  const w = r.referent?.wave;
  const windows = [
    { id: "1h", a: l?.siblings1h ?? null, b: w?.launches1h ?? null },
    { id: "6h", a: l?.siblings6h ?? null, b: w?.launches6h ?? null },
    { id: "24h", a: l?.siblings24h ?? null, b: w?.launches24h ?? null },
  ];
  const hasA = windows.some((x) => x.a !== null);
  const hasB = windows.some((x) => x.b !== null);
  if (!hasA && !hasB) return null;
  const max = Math.max(1, ...windows.flatMap((x) => [x.a ?? 0, x.b ?? 0]));
  const H = 96;
  return (
    <div className="sage-crowd">
      <div className="sage-crowd-plot" role="img" aria-label="Namesakes and same-theme launches by window">
        {windows.map((x) => (
          <div className="sage-crowd-group" key={x.id}>
            <div className="sage-crowd-bars" style={{ height: H }}>
              {hasA && (
                <CrowdBar
                  value={x.a}
                  max={max}
                  h={H}
                  series={1}
                  title={`Last ${x.id}: ${x.a ?? "–"} coins with its name, ticker or logo launched before it`}
                />
              )}
              {hasB && (
                <CrowdBar
                  value={x.b}
                  max={max}
                  h={H}
                  series={2}
                  title={`Last ${x.id}: ${x.b ?? "–"} coins TokenSage tied to ${r.referent?.label ?? "the same referent"}`}
                />
              )}
            </div>
            <span className="sage-crowd-x">{x.id}</span>
          </div>
        ))}
      </div>
      <div className="legend small">
        {hasA && (
          <span className="key">
            <i className="swatch s1" /> Namesakes before it
          </span>
        )}
        {hasB && (
          <span className="key">
            <i className="swatch s2" /> Same theme
          </span>
        )}
      </div>
    </div>
  );
}

function CrowdBar({
  value,
  max,
  h,
  series,
  title,
}: {
  value: number | null;
  max: number;
  h: number;
  series: 1 | 2;
  title: string;
}) {
  const px = value ? Math.max(3, (value / max) * (h - 16)) : 0;
  return (
    <span className="sage-crowd-col" title={title}>
      <span className="sage-crowd-val num">{value ?? "–"}</span>
      <span className={`sage-crowd-fill s${series}`} style={{ height: px }} />
    </span>
  );
}

function XCard({ x }: { x: NonNullable<SageRead["x"]> }) {
  const a = x.author;
  const verdict = x.verdict ? (VERDICT[x.verdict] ?? words(x.verdict)) : null;
  return (
    <section className="sage-card sage-x">
      <h4>
        X link
        {x.relation && (
          <span className="sage-tag tone-neutral">{RELATION[x.relation] ?? words(x.relation)}</span>
        )}
        {verdict && (
          <span
            className={`sage-tag tone-${x.verdict === "unrelated" ? "warn" : x.verdict === "about_this_coin" ? "good" : "neutral"}`}
          >
            {verdict}
            {x.fit !== null ? ` · fit ${pct0(x.fit)}` : ""}
          </span>
        )}
      </h4>
      {!x.read && (
        <p className="small muted">Not opened yet: the deep read opens the linked post or profile.</p>
      )}
      {a && (a.handle || a.name) && (
        <div className="sage-x-author">
          <strong>{a.name ?? `@${a.handle}`}</strong>
          {a.handle && <span className="muted">@{a.handle}</span>}
          {a.verified && a.verified !== "none" && <span className="pill">{words(a.verified)} check</span>}
          {a.followers !== null && <span className="muted">{count(a.followers)} followers</span>}
        </div>
      )}
      {x.text && <blockquote className="sage-x-text">{x.text}</blockquote>}
      <dl className="sage-x-facts">
        {x.predatesTokenS !== null && (
          <div>
            <dt>Posted</dt>
            <dd>
              {x.predatesTokenS >= 0
                ? `${span(x.predatesTokenS)} before launch`
                : `${span(x.predatesTokenS)} after launch`}
            </dd>
          </div>
        )}
        {x.accountAgeS !== null && (
          <div>
            <dt>Account age at launch</dt>
            <dd>
              {span(x.accountAgeS)}
              {x.madeForCoin ? " · made for the coin" : ""}
            </dd>
          </div>
        )}
        {x.reuseCount !== null && x.reuseCount > 0 && (
          <div>
            <dt>Also linked by</dt>
            <dd>
              {x.reuseCount} other coin{x.reuseCount === 1 ? "" : "s"}
              {x.reuseRank !== null ? ` · this one #${x.reuseRank}` : ""}
            </dd>
          </div>
        )}
        {x.basis.length > 0 && (
          <div>
            <dt>Fit rests on</dt>
            <dd>{x.basis.map(words).join(", ")}</dd>
          </div>
        )}
      </dl>
      {x.credibility !== null && (
        <div
          className="sage-meter"
          title="Context about the account, not a verdict on the post: TokenSage's 0-100% from its age, followers, posting history and verification. Reads before rules 0.23 scored renamed and made-for-coin accounts much lower."
        >
          <span className="small muted">Account credibility (context)</span>
          <span className="sage-bar-track">
            <span className="sage-bar-fill" style={{ width: `${Math.max(2, x.credibility * 100)}%` }} />
          </span>
          <span className="num small">{pct0(x.credibility)}</span>
        </div>
      )}
      {x.url && (
        <a className="sage-x-link small" href={x.url} target="_blank" rel="noopener noreferrer">
          Open on X <ExternalIcon size={11} />
        </a>
      )}
    </section>
  );
}

/** Market cap at each scan as an area, with the moment TokenSage read it marked. Hover for values. */
function McapChart({ points, readAt }: { points: { t: string; usd: number }[]; readAt: number | null }) {
  const W = 600;
  const H = 150;
  const PAD = { l: 4, r: 4, t: 12, b: 18 };
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const geo = useMemo(() => {
    const ts = points.map((p) => Date.parse(p.t));
    const t0 = ts[0]!;
    const t1 = Math.max(t0 + 1, ts[ts.length - 1]!);
    const lo = Math.min(...points.map((p) => p.usd));
    const hi = Math.max(...points.map((p) => p.usd));
    const span = Math.max(hi - lo, hi * 0.05, 1);
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - (lo - span * 0.08)) / (span * 1.16)) * (H - PAD.t - PAD.b);
    const xy = points.map((p, i) => [x(ts[i]!), y(p.usd)] as const);
    const line = xy.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
    const area = `${line} L${xy[xy.length - 1]![0].toFixed(1)},${H - PAD.b} L${xy[0]![0].toFixed(1)},${H - PAD.b} Z`;
    const readX = readAt !== null && readAt >= t0 && readAt <= t1 ? x(readAt) : null;
    return { ts, t0, t1, xy, line, area, readX, hi, lo };
  }, [points, readAt]);
  const onMove = (e: React.PointerEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xy.length; i++)
      if (Math.abs(geo.xy[i]![0] - px) < Math.abs(geo.xy[best]![0] - px)) best = i;
    setHover(best);
  };
  const h = hover !== null ? geo.xy[hover] : null;
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="sage-mcap">
      <div className="sage-mcap-readout small">
        {hover !== null ? (
          <>
            <strong className="num">{usd(points[hover]!.usd)}</strong>
            <span className="muted"> at {fmtTime(geo.ts[hover]!)}</span>
          </>
        ) : (
          <>
            <strong className="num">{usd(points[points.length - 1]!.usd)}</strong>
            <span className="muted"> latest · high {usd(geo.hi)}</span>
          </>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="sage-mcap-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Market cap from ${usd(points[0]!.usd)} to ${usd(points[points.length - 1]!.usd)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="sage-mcap-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={0} x2={W} y1={H - PAD.b} y2={H - PAD.b} className="sage-axis" />
        <path d={geo.area} fill="url(#sage-mcap-grad)" />
        <path d={geo.line} className="sage-mcap-line" vectorEffect="non-scaling-stroke" />
        {geo.readX !== null && (
          <g>
            <line
              x1={geo.readX}
              x2={geo.readX}
              y1={PAD.t - 6}
              y2={H - PAD.b}
              className="sage-read-mark"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
        {h && (
          <g>
            <line
              x1={h[0]}
              x2={h[0]}
              y1={PAD.t}
              y2={H - PAD.b}
              className="sage-cross"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>
      {h && (
        <span className="sage-dot" style={{ left: `${(h[0] / W) * 100}%`, top: `${(h[1] / H) * 100}%` }} />
      )}
      <div className="sage-mcap-x faint small">
        <span>{fmtTime(geo.t0)}</span>
        {geo.readX !== null && <span className="sage-read-key">┆ TokenSage read</span>}
        <span>{fmtTime(geo.t1)}</span>
      </div>
    </div>
  );
}

/** The week's 2x rate for model calls on coins in this narrative, next to all calls, per day. */
function TrackChart({ track }: { track: SageTrack }) {
  const rate = (d: TrackDay) => (d.graded > 0 ? d.won2x / d.graded : null);
  const mine = track.days.reduce((s, d) => ({ g: s.g + d.graded, w: s.w + d.won2x, n: s.n + d.count }), {
    g: 0,
    w: 0,
    n: 0,
  });
  const all = track.all.reduce((s, d) => ({ g: s.g + d.graded, w: s.w + d.won2x }), { g: 0, w: 0 });
  const rows = track.days.map((d, i) => ({
    day: d.day,
    a: rate(d),
    b: rate(track.all[i]!),
    d,
    all: track.all[i]!,
  }));
  const max = Math.max(0.1, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  const top = Math.ceil(max * 10) / 10;
  const H = 110;
  const name = words(track.label);
  const dayText = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
  return (
    <section className="sage-card">
      <h4>
        {name} coins this week
        {mine.g > 0 && (
          <span className="sage-tag tone-neutral">
            {pct0(mine.w / mine.g)} of {mine.g} calls 2x&apos;d
            {all.g > 0 ? ` · all calls ${pct0(all.w / all.g)}` : ""}
          </span>
        )}
      </h4>
      <p className="small muted">
        {count(mine.n)} {name.toLowerCase()} coins read this week. Each day: the share of the models&apos;
        graded calls that doubled, on {name.toLowerCase()} coins and on all coins.
      </p>
      <div
        className="sage-track"
        role="img"
        aria-label={`Daily 2x rate of calls on ${name} coins and all coins`}
      >
        <div className="sage-track-axis faint small">
          <span>{pct0(top)}</span>
          <span>0%</span>
        </div>
        <div className="sage-track-plot" style={{ height: H }}>
          {rows.map((r) => (
            <div className="sage-track-day" key={r.day}>
              <div className="sage-track-bars">
                <span
                  className="sage-track-fill s1"
                  style={{ height: r.a === null ? 0 : `${Math.max(2, (r.a / top) * 100)}%` }}
                  title={`${dayText(r.day)} · ${name}: ${r.d.graded ? `${r.d.won2x} of ${r.d.graded} graded calls doubled (${pct0(r.a!)})` : "no graded calls"}`}
                />
                <span
                  className="sage-track-fill s2"
                  style={{ height: r.b === null ? 0 : `${Math.max(2, (r.b / top) * 100)}%` }}
                  title={`${dayText(r.day)} · all coins: ${r.all.graded ? `${r.all.won2x} of ${r.all.graded} graded calls doubled (${pct0(r.b!)})` : "no graded calls"}`}
                />
              </div>
              <span className="sage-track-x faint small">{dayText(r.day)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="legend small">
        <span className="key">
          <i className="swatch s1" /> {name}
        </span>
        <span className="key">
          <i className="swatch s2" /> All coins
        </span>
      </div>
    </section>
  );
}
