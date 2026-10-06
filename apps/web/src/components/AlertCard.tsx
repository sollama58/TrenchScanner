import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card, CardField } from "../api";
import { ago, change, minutes, multiple, pct, shortAddress, tokenLabel, tokenThumb, usd } from "../format";
import { BrainIcon, CheckIcon, CopyIcon, ExternalIcon, RobotIcon, SlidersIcon } from "./Icons";
import { matchOutcome, outcomeAt, outcomeBadge } from "../outcome";
import { useAppearance } from "../appearance";
import { scoreTone, scoreToneColor, scoreTooltip, useScoreWeights } from "../scoreWeights";

const DAY_MS = 86_400_000;

const LINKS = [
  { label: "Dex", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump", href: (m: string) => `https://pump.fun/coin/${m}` },
  { label: "RugCheck", href: (m: string) => `https://rugcheck.xyz/tokens/${m}` },
];

export function AlertCard({
  card,
  now,
  compact = false,
  labelSource = false,
  hide,
}: {
  card: Card;
  now: number;
  compact?: boolean;
  /** Label every card with where it came from (your filter, or which models) - the combined feed. */
  labelSource?: boolean;
  /** Fields the user chose not to see (Settings › Feed appearance). */
  hide?: ReadonlySet<CardField>;
}) {
  const show = (f: CardField) => !hide?.has(f);
  const s = card.snapshot;
  const { weights, scale } = useScoreWeights();
  // Red at recent alerts' 10th percentile through to green at their 90th (Customize can turn it off).
  const { scoreColor } = useAppearance();
  const tone = scoreColor ? scoreTone(s.score ?? null, scale) : null;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const alertMcap = s.marketCapUsd;
  const nowMcap = card.currentMarketCapUsd;
  const move = change(alertMcap, nowMcap);
  const curated = card.curated;
  // Re-derived from the alert time, so a call whose window ran out by the clock stops reading as pending.
  const outcome = curated ? outcomeAt(curated.outcome, curated.alertedAt, now) : matchOutcome(card, now);
  const badge = outcomeBadge(outcome);
  const isModel = curated && !curated.source.startsWith("heuristic");
  const calls = curated?.calledBy ?? [];
  const recordedPeak = curated?.outcome.peak24hReturnPct ?? card.peakReturnPct;
  // The recorded peak catches up on the worker's next pass; a "Now" above it is already a peak.
  // A curated card's peak is its 24h peak, so a reading past that window doesn't count there.
  const alertAt = new Date(curated?.alertedAt ?? card.matchedAt).getTime();
  const nowCounts = move !== null && move > 0 && (!curated || now - alertAt < DAY_MS);
  const peak = nowCounts ? Math.max(recordedPeak ?? 0, move) : recordedPeak;
  const ai = curated?.aiReview;
  const mint = card.token.mintAddress;
  const hasPeak = peak !== null && peak !== undefined && peak > 0;
  // The highest market cap since the alert: the alert mcap at the Peak multiple.
  const athMcap = hasPeak && alertMcap > 0 ? alertMcap * (1 + peak / 100) : null;
  // The result badge (top right) shows once a target hit or the window closed; nothing while grading.
  const showVerdict = outcome !== null && !(outcome.status === "watching" && !outcome.hit2x);
  // Marks only: ✓ 2x, ✓✓ 4x, ✓✓✓ 10x, ✕ missed or stopped out (the words stay in the tooltip).
  // An ungraded result has no mark, so nothing shows.
  const resultMark = showVerdict && badge.tone !== "neutral" ? badge.text.split(" ")[0] : null;
  // When the recorded run peak came - only while "Now" hasn't overtaken it.
  const runPeakAfter =
    !nowCounts || (recordedPeak ?? 0) >= (move ?? 0) ? (curated?.outcome.runPeakMinutes ?? null) : null;
  // Measured at alert time when the wallet lookups made it in time; otherwise from a later scan.
  const freshAtAlert = s.freshTop10WalletPct ?? null;
  const freshLater = card.latestSnapshot?.freshTop10WalletPct ?? null;
  const freshPct = freshAtAlert ?? freshLater ?? card.token.lastFreshTop10WalletPct ?? null;
  // The empty-wallet share, with the same fallback. Both wallet checks are paid lookups with a
  // per-scan budget, so a token can go unchecked; the tile says so rather than showing a blank.
  const emptyAtAlert = s.emptyTop10WalletPct ?? null;
  const emptyPct =
    emptyAtAlert ?? card.latestSnapshot?.emptyTop10WalletPct ?? card.token.lastEmptyTop10WalletPct ?? null;
  // The same fallback for the first-buyers count, read from the launch's first transactions.
  const buyersFrom = s.firstBuyersHolding != null ? s : card.latestSnapshot;
  const firstHolding = buyersFrom?.firstBuyersHolding ?? null;
  const firstSeen = buyersFrom?.firstBuyersSeen ?? null;
  // Whether the dev still holds: the newest reading first, since a dev can sell after the alert.
  const devHolding = card.latestSnapshot?.devHolding ?? s.devHolding ?? null;

  const figCount = (["alert", "now", "peak"] as const).filter(show).length;
  // The volume field is three tiles (5m / 1h / 24h).
  const statCount =
    (["score", "holders", "age", "top10", "fresh", "empty", "snipers", "dev"] as const).filter(show).length +
    (show("vol") ? 3 : 0);

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <article
      className={`card tone-${badge.tone}${compact ? " compact" : ""}${labelSource ? (card.kind === "match" ? " src-mine" : " src-model") : ""}`}
    >
      <header className="card-head">
        <div className={`avatar-wrap tone-${badge.tone}`}>
          <TokenAvatar url={card.token.imageUrl} symbol={card.token.symbol} />
        </div>
        <div className="card-title">
          <div className="title-row">
            <strong className="symbol">{tokenLabel(card.token)}</strong>
            {show("tokenName") && card.token.name && card.token.symbol && (
              <span className="token-name">{card.token.name}</span>
            )}
          </div>
          <div className="meta-row">
            {labelSource && card.kind === "match" && (
              <span
                className="pill pill-mine pill-icon"
                title="Caught by your own filter"
                aria-label="Your alert"
              >
                <SlidersIcon size={12} />
              </span>
            )}
            {curated && show("modelPill") && (
              <span
                className={`pill ${isModel || labelSource ? "pill-model" : "pill-heur"}`}
                title={
                  calls.length > 1
                    ? calls.map((c) => `${c.modelName ?? "Model"}: ${c.confidence.toFixed(0)}`).join("\n")
                    : "Model confidence, 0-100"
                }
              >
                <BrainIcon size={12} />
                <span className="pill-text">
                  {labelSource && "Model · "}
                  {calls.length > 1
                    ? calls.map((c) => c.modelName ?? "Model").join(" + ")
                    : `${curated.modelName ?? (isModel ? "Model" : "Heuristic")} · ${curated.confidence.toFixed(0)}`}
                </span>
              </span>
            )}
            {curated &&
              show("conviction") &&
              (calls.some((c) => c.tier === "high") || curated.tier === "high") && (
                <span className="pill pill-model" title="In the model's top half-percent of decision moments">
                  <span className="pill-text">High conviction</span>
                </span>
              )}
            {curated && show("calibrated") && calibratedRate(curated, calls) !== null && (
              <span
                className="pill"
                title="Of recent out-of-sample calls ranked like this one, the share that doubled within 15 minutes"
              >
                <span className="pill-text">≈{calibratedRate(curated, calls)!.toFixed(0)}% 2x</span>
              </span>
            )}
            {show("time") && <span className="when">{ago(card.matchedAt, now)}</span>}
          </div>
        </div>
        {resultMark && show("result") && (
          <span className={`badge card-result ${badge.tone}`} title={badge.text} aria-label={badge.text}>
            {resultMark}
          </span>
        )}
      </header>

      {figCount > 0 && (
        <div className="card-figures" style={{ "--fig-cols": figCount } as React.CSSProperties}>
          {show("alert") && (
            <div className="fig">
              <label>Alert</label>
              <span className="num">{usd(alertMcap)}</span>
            </div>
          )}
          {show("now") && (
            <div className="fig">
              <label>Now</label>
              <span className="num">{usd(nowMcap)}</span>
              {move !== null && (
                <small className={`num delta ${move >= 0 ? "up" : "down"}`}>
                  {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
                </small>
              )}
            </div>
          )}
          {show("peak") && (
            <div className={`fig peak ${hasPeak && peak >= 100 ? "hot" : ""}`}>
              <label>Peak</label>
              <span
                className="num"
                title={
                  runPeakAfter !== null && runPeakAfter > 0
                    ? `Highest since the alert, about ${Math.round(runPeakAfter)} minutes in`
                    : undefined
                }
              >
                {hasPeak ? multiple(peak) : "–"}
              </span>
              {athMcap !== null && show("ath") && (
                <small className="num ath" title="Highest market cap since the alert">
                  ATH {usd(athMcap)}
                </small>
              )}
            </div>
          )}
        </div>
      )}

      {!compact && statCount > 0 && (
        <dl
          className="card-stats"
          style={
            {
              "--stat-cols": Math.min(4, statCount),
              "--stat-cols-narrow": Math.min(2, statCount),
            } as React.CSSProperties
          }
        >
          {show("score") && (
            <div
              className="stat-score"
              title={scoreTooltip(s.score ?? null, weights, scoreColor ? scale : undefined)}
            >
              <dt>Score</dt>
              <dd className="num" style={tone === null ? undefined : { color: scoreToneColor(tone) }}>
                {s.score == null ? "–" : Math.round(s.score)}
              </dd>
            </div>
          )}
          {show("vol") && (
            <>
              <div title="Trading volume over the 5 minutes before the alert">
                <dt>Vol 5m</dt>
                <dd className="num">{usd(s.volume5mUsd ?? null)}</dd>
              </div>
              <div title="Trading volume over the hour before the alert">
                <dt>Vol 1h</dt>
                <dd className="num">{usd(s.volume1hUsd ?? null)}</dd>
              </div>
              <div title="Trading volume over the 24 hours before the alert (since launch, for a younger token)">
                <dt>Vol 24h</dt>
                <dd className="num">{usd(s.volume24hUsd)}</dd>
              </div>
            </>
          )}
          {show("holders") && (
            <div>
              <dt>Holders</dt>
              <dd className="num">{s.holderCount ?? "–"}</dd>
            </div>
          )}
          {show("age") && (
            <div>
              <dt>Age</dt>
              <dd className="num">{minutes(s.ageMinutes)}</dd>
            </div>
          )}
          {show("top10") && (
            <div>
              <dt>Top 10</dt>
              <dd className="num">{pct(s.top10HolderPct)}</dd>
            </div>
          )}
          {show("fresh") && (
            <WalletStat
              label="Fresh"
              value={freshPct}
              atAlert={freshAtAlert !== null}
              explain="top-10 holder wallets first used in the last 24h"
            />
          )}
          {show("empty") && (
            <WalletStat
              label="Empty"
              value={emptyPct}
              atAlert={emptyAtAlert !== null}
              explain="top-10 holder wallets with under $25 of other tokens"
            />
          )}
          {show("snipers") && (
            <div
              title={
                firstHolding === null
                  ? "First 25 buyers still holding: not checked yet for this token"
                  : `${firstHolding} of the first ${firstSeen ?? 25} buyers after launch still hold it${
                      buyersFrom === s ? ", at alert time" : ", from a scan after the alert"
                    }`
              }
            >
              <dt>Snipers</dt>
              <dd className="num">{firstHolding === null ? "–" : `${firstHolding}/${firstSeen ?? 25}`}</dd>
            </div>
          )}
          {show("dev") && (
            <div
              title={
                devHolding === null
                  ? "Dev Holding / Dev Sold: not known for this token yet"
                  : devHolding
                    ? "DH = Dev Holding: the creator's wallet still holds this token (as of the latest scan)"
                    : "DS = Dev Sold: the creator's wallet holds none of this token (as of the latest scan)"
              }
            >
              <dt>Dev</dt>
              <dd className="num">{devHolding === null ? "–" : devHolding ? "DH" : "DS"}</dd>
            </div>
          )}
        </dl>
      )}

      {curated && show("reasons") && curated.reasons.length > 0 && (
        <ul className="reasons">
          {curated.reasons.slice(0, compact ? 2 : 4).map((r) => (
            <li key={r}>{r.replace(/^model signal: /, "")}</li>
          ))}
        </ul>
      )}

      {ai && (
        <div
          className={`ai-review ${ai.decision === "buy" ? "buy" : ai.decision === "no_buy" ? "nobuy" : ""}`}
        >
          <button className="ai-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <RobotIcon size={14} />
            <span>
              AI reviewer:{" "}
              <strong>{ai.decision === "buy" ? "BUY" : ai.decision === "no_buy" ? "NO BUY" : "error"}</strong>
              {ai.probability2x !== null && (
                <span className="muted"> · {(ai.probability2x * 100).toFixed(0)}% to 2x</span>
              )}
            </span>
            <span className="chev">{open ? "▴" : "▾"}</span>
          </button>
          {open && (
            <div className="ai-body">
              {ai.reasoning && <p>{ai.reasoning}</p>}
              {ai.risks.length > 0 && <p className="muted">Risks: {ai.risks.join("; ")}</p>}
              {ai.error && <p className="muted">Error: {ai.error}</p>}
              <p className="faint">Visible to admin wallets only · {ai.mode} mode</p>
            </div>
          )}
        </div>
      )}

      {(show("mint") || show("links")) && (
        <footer className="card-foot">
          {show("mint") && (
            <button className="mint" onClick={copy} title="Copy mint address">
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              {copied ? "Copied" : shortAddress(mint)}
            </button>
          )}
          {show("links") && (
            <nav className="card-links">
              {LINKS.map((l) => (
                <a key={l.label} href={l.href(mint)} target="_blank" rel="noreferrer">
                  {l.label}
                  <ExternalIcon size={11} />
                </a>
              ))}
            </nav>
          )}
        </footer>
      )}
    </article>
  );
}

/** Over this share of the top 10 a wallet check fails the safety screen, so the tile turns red. */
const SAFETY_WALLET_PCT = 70;

/** One wallet-check tile (Fresh or Empty): the share, where it was read, or that it wasn't checked. */
function WalletStat({
  label,
  value,
  atAlert,
  explain,
}: {
  label: string;
  value: number | null;
  atAlert: boolean;
  explain: string;
}) {
  const title =
    value === null
      ? `${label}: not checked yet. Wallet checks are limited per scan, and tokens closest to alerting go first.`
      : `${label}: ${explain}, ${atAlert ? "at alert time" : "from a scan after the alert"}.`;
  return (
    <div className={value !== null && value > SAFETY_WALLET_PCT ? "risky" : undefined} title={title}>
      <dt>{label}</dt>
      <dd className={value === null ? "muted" : "num"}>{value === null ? "Not checked" : pct(value)}</dd>
    </div>
  );
}

/** Thumbnail size requested from the image host: covers the largest avatar (phones) at 2x density. */
const THUMB_PX = 128;
/** The desktop hover preview is this many times the avatar's size, kept inside the window. */
const PREVIEW_SCALE = 6;
const PREVIEW_GAP = 12;
const EDGE = 8;
/** Only a real mouse/trackpad gets the preview; touch screens fire hover on tap. */
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

type PreviewSpot = { left: number; top: number; size: number };

/** Where the preview goes: beside the avatar (right, else left), clamped to the window. */
function previewSpot(rect: DOMRect): PreviewSpot {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const size = Math.max(0, Math.min(rect.width * PREVIEW_SCALE, vw - 2 * EDGE, vh - 2 * EDGE));
  let left = rect.right + PREVIEW_GAP;
  if (left + size > vw - EDGE) left = rect.left - PREVIEW_GAP - size;
  left = Math.min(Math.max(EDGE, left), vw - EDGE - size);
  const top = Math.min(Math.max(EDGE, rect.top + rect.height / 2 - size / 2), vh - EDGE - size);
  return { left, top, size };
}

/**
 * The token's image as a small thumbnail, falling back to the original URL, then to its initials.
 * On desktop, hovering it shows a large preview; phones get a bigger avatar instead.
 */
function TokenAvatar({ url, symbol }: { url: string | null; symbol: string | null }) {
  // 0: thumbnail, 1: original URL, 2: give up.
  const [attempt, setAttempt] = useState(0);
  const [spot, setSpot] = useState<PreviewSpot | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  const safe = url?.startsWith("https://") ? url : null;
  const thumb = safe ? tokenThumb(safe, THUMB_PX) : null;
  const src = !safe ? null : attempt === 0 ? thumb : attempt === 1 && thumb !== safe ? safe : null;

  // A scroll or resize moves the avatar out from under the preview; close it rather than chase it.
  useEffect(() => {
    if (!spot) return;
    const close = () => setSpot(null);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [spot]);

  if (!src) return <span className="avatar placeholder">{(symbol ?? "?").slice(0, 2)}</span>;

  const open = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !window.matchMedia?.(HOVER_QUERY).matches || !ref.current) return;
    const s = previewSpot(ref.current.getBoundingClientRect());
    setSpot(s.size >= 80 ? s : null);
  };

  return (
    <>
      {/* Launcher-supplied URL: https only, and no referrer sent to whoever hosts it. */}
      <img
        ref={ref}
        className="avatar"
        src={src}
        alt=""
        width={44}
        height={44}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => {
          setSpot(null);
          setAttempt((a) => a + 1);
        }}
        onPointerEnter={open}
        onPointerLeave={() => setSpot(null)}
      />
      {spot &&
        safe &&
        createPortal(
          <AvatarPreview spot={spot} small={src} large={tokenThumb(safe, 512)} original={safe} />,
          document.body,
        )}
    </>
  );
}

/**
 * The hover preview, outside the card (whose overflow and hover transform would clip or shift a
 * fixed child). The small thumbnail already loaded shows at once, and the sharp image covers it
 * when it arrives; if that fails, the original URL, else the small one stays.
 */
function AvatarPreview({
  spot,
  small,
  large,
  original,
}: {
  spot: PreviewSpot;
  small: string;
  large: string;
  original: string;
}) {
  const [sharp, setSharp] = useState<string | null>(large);
  const [ready, setReady] = useState(false);
  return (
    <div
      className="avatar-preview"
      aria-hidden="true"
      style={{ left: spot.left, top: spot.top, width: spot.size, height: spot.size }}
    >
      <img src={small} alt="" referrerPolicy="no-referrer" />
      {sharp && (
        <img
          className={ready ? "ready" : undefined}
          src={sharp}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setReady(true)}
          onError={() => setSharp(sharp !== original && sharp === large ? original : null)}
        />
      )}
    </div>
  );
}

/** The best calibrated 2x rate among the calls on a card (the lead call's when alone), or null. */
function calibratedRate(
  curated: { calibratedPct?: number | null },
  calls: { calibratedPct?: number | null }[],
): number | null {
  const rates = [curated.calibratedPct, ...calls.map((c) => c.calibratedPct)].filter(
    (r): r is number => typeof r === "number",
  );
  return rates.length > 0 ? Math.max(...rates) : null;
}
