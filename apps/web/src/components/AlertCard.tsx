import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card, CardField, FeedAppearance, Snapshot } from "../api";
import {
  ago,
  change,
  minutes,
  multiple,
  pct,
  shortAddress,
  tokenImageSources,
  tokenLabel,
  tokenThumb,
  usd,
} from "../format";
import {
  BrainIcon,
  ChefHatIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  GiftIcon,
  HeartIcon,
  RobotIcon,
  SageIcon,
  SlidersIcon,
} from "./Icons";
import { openSage } from "../sage";
import { linkedCount, linkedCountText } from "../bubbleMap";
import { cardOutcome, outcomeBadge, outcomeResult } from "../outcome";
import { QUICK_LINK_SITES, useAppearance } from "../appearance";
import { useShowNarrativeNote } from "../narrativeNote";
import { cardCalibratedRate } from "../rates";
import { scoreTone, scoreToneColor, scoreTooltip, useScoreWeights } from "../scoreWeights";
import { filterCardStyle } from "../filterStyle";
import {
  TILE_FIRST_BUYERS_OF,
  TILE_RED_FIRST_BUYERS,
  TILE_RED_KOL_BUNDLED_PCT,
  TILE_RED_TRANSFERRED_PCT,
  tileLook,
  tileMode,
  tileTone,
  type TileMode,
} from "../tileTone";
import { FilterGlyph } from "./FilterBadge";
import { openTokenModal, refreshTokenModal } from "../tokenModal";

/** Clicks on these inside a card do their own thing rather than open the token modal. */
const OWN_CLICK = "a, button, input, select, textarea, label, summary, [role='button']";

const LINKS = [
  { label: "Dex", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump", href: (m: string) => `https://pump.fun/coin/${m}` },
];

export function AlertCard({
  card,
  now,
  compact = false,
  labelSource = false,
  hide,
  detail = true,
}: {
  card: Card;
  now: number;
  compact?: boolean;
  /** Label every card with where it came from (your filter, or which models) - the combined feed. */
  labelSource?: boolean;
  /** Fields the user chose not to see (Settings › Feed appearance). */
  hide?: ReadonlySet<CardField>;
  /** Clicking the card opens the token modal (off for the Customize preview). */
  detail?: boolean;
}) {
  const show = (f: CardField) => !hide?.has(f);
  const s = card.snapshot;
  const { weights, scale } = useScoreWeights();
  // Red at recent alerts' 10th percentile through to green at their 90th (Customize can turn it off).
  const look = useAppearance();
  const { scoreColor, quickLinks } = look;
  const tiles = tileMode(look);
  // Customize's Narrative toggle, else on once the Narrative model's 7-day hit rate reliably passes 40%.
  const showNarrative = useShowNarrativeNote();
  const trade = QUICK_LINK_SITES.filter((l) => quickLinks.includes(l.id));
  const tone = scoreColor ? scoreTone(s.score ?? null, scale) : null;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // The modal lives above the feed (TokenModalHost), so it stays open if this card leaves it.
  const openDetailModal = () => openTokenModal(card, now);
  useEffect(() => refreshTokenModal(card, now), [card, now]);
  const alertMcap = s.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  const curated = card.curated;
  // Re-derived from the alert time, so a call whose window ran out by the clock stops reading as pending.
  const outcome = cardOutcome(card, now);
  const badge = outcomeBadge(outcome);
  const result = outcomeResult(outcome);
  const isModel = curated && !curated.source.startsWith("heuristic");
  const calls = curated?.calledBy ?? [];
  const { pct: recordedPeak, isRunPeak } = recordedPeakOf(card);
  // The filter that raised it, when its owner gave it a color or icon: that style wins over
  // Customize's outline and accent on this card, and its icon marks the card.
  const filter = card.kind === "match" ? card.filter : null;
  const styled = !!filter && (!!filter.color || !!filter.icon);
  // The recorded peak catches up on the worker's next pass; a "Now" above it is already a peak.
  const nowCounts = move !== null && move > 0;
  const peak = nowCounts ? Math.max(recordedPeak ?? 0, move) : recordedPeak;
  const ai = curated?.aiReview;
  const mint = card.token.mintAddress;
  const hasPeak = peak !== null && peak !== undefined && peak > 0;
  // The highest market cap since the alert: the alert mcap at the Peak multiple.
  const athMcap = hasPeak && alertMcap > 0 ? alertMcap * (1 + peak / 100) : null;
  // The result badge (top right) shows once a target hit or the window closed; nothing while grading.
  const showVerdict = outcome !== null && !(outcome.status === "watching" && !outcome.hit2x);
  // Marks only: ✓ 2x, ✓✓ 4x, ✓✓✓ 10x, ↗ ran later, ⊘ stopped out, ✕ missed (the words stay
  // in the tooltip).
  // An ungraded result has no mark, so nothing shows.
  const resultMark = showVerdict && badge.tone !== "neutral" ? badge.text.split(" ")[0] : null;
  // When the recorded run peak came - only while it is the Peak shown and "Now" hasn't overtaken it
  // (a later market-cap high or the filter alert's ATH came at another time).
  const runPeakAfter =
    isRunPeak && (!nowCounts || (recordedPeak ?? 0) >= (move ?? 0))
      ? (curated?.outcome.runPeakMinutes ?? null)
      : null;
  const {
    freshPct,
    freshOf,
    freshAtAlert,
    emptyPct,
    emptyOf,
    emptyAtAlert,
    snipers,
    largestPct,
    linkedPct,
    linkedCount: linkedN,
    linkedKols,
    linkedBundled,
    linkedAtAlert,
    linkedClusters,
    cexPct,
    cexAtAlert,
    cexCount,
    cexHolders,
    kolBundledPct,
    kolBundledAtAlert,
    transferredPct,
    transferCount,
    transferAtAlert,
    firstHolding,
    firstSeen,
    buyersAtAlert,
    devHolding,
    feeLine,
  } = cardReadings(card);

  const figCount = (["alert", "now", "peak"] as const).filter(show).length;
  // The volume field is three tiles (5m / 1h / 24h).
  const statCount =
    (
      [
        "score",
        "holders",
        "age",
        "top10",
        "largest",
        "fresh",
        "empty",
        "snipers",
        "sniperTop10",
        "linked",
        "cexFunded",
        "kolBundled",
        "transferred",
        "dev",
      ] as const
    ).filter(show).length + (show("vol") ? 3 : 0);

  const fees = show("fees") ? feeBadge(card.token.creatorFee) : null;

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  // A click anywhere on the card that isn't a button or link, and isn't the end of a text selection.
  const openDetail = (e: React.MouseEvent) => {
    if (!detail || e.defaultPrevented || e.button !== 0) return;
    if ((e.target as Element).closest?.(OWN_CLICK)) return;
    if (window.getSelection?.()?.toString()) return;
    openDetailModal();
  };

  return (
    <article
      className={`card tone-${badge.tone}${result ? ` result-${result}` : ""}${compact ? " compact" : ""}${detail ? " opens" : ""}`}
      style={filter?.color ? (filterCardStyle(filter.color) as React.CSSProperties) : undefined}
      onClick={openDetail}
    >
      <header className="card-head">
        <div className={`avatar-wrap tone-${badge.tone}`}>
          <TokenAvatar url={card.token.imageUrl} symbol={card.token.symbol} />
        </div>
        <div className="card-title">
          <div className="title-row">
            {detail ? (
              <button
                type="button"
                className="symbol symbol-btn"
                onClick={openDetailModal}
                title={`${tokenLabel(card.token)}: open the token's chart and details`}
              >
                {/* Its own box: a button doesn't draw text-overflow's ellipsis on its text. */}
                <span className="symbol-text">{tokenLabel(card.token)}</span>
              </button>
            ) : (
              <strong className="symbol" title={tokenLabel(card.token)}>
                {tokenLabel(card.token)}
              </strong>
            )}
            {show("tokenName") && card.token.name && card.token.symbol && (
              <span className="token-name" title={card.token.name}>
                {card.token.name}
              </span>
            )}
          </div>
          <div className="meta-row">
            {styled ? (
              <span
                className={`pill pill-icon ${filter.color ? "pill-filter" : "pill-mine"}`}
                role="img"
                title={`Caught by your filter “${filter.name}”`}
                aria-label={`Your alert, from ${filter.name}`}
              >
                <FilterGlyph icon={filter.icon} />
              </span>
            ) : (
              labelSource &&
              card.kind === "match" && (
                <span
                  className="pill pill-mine pill-icon"
                  role="img"
                  title="Caught by your own filter"
                  aria-label="Your alert"
                >
                  <SlidersIcon size={12} />
                </span>
              )
            )}
            {curated && show("modelPill") && (
              <span
                className={`pill pill-calls ${isModel || labelSource ? "pill-model" : "pill-heur"}`}
                title={
                  calls.length > 1
                    ? `${calls.map((c) => `${c.modelName ?? "Model"}: score ${c.confidence.toFixed(0)}`).join("\n")}\n${SCORE_HINT}`
                    : `${curated.modelName ?? (isModel ? "Model" : "Heuristic")}: score ${curated.confidence.toFixed(0)}\n${SCORE_HINT}`
                }
              >
                <BrainIcon size={12} />
                <span className="pill-text">
                  {labelSource && "Model · "}
                  {calls.length > 1
                    ? calls.map((c) => c.modelName ?? "Model").join(" + ")
                    : `${curated.modelName ?? (isModel ? "Model" : "Heuristic")} · Score ${curated.confidence.toFixed(0)}`}
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
            {curated?.narrative && showNarrative && show("modelPill") && (
              <span
                className={`pill ${curated.narrative.verdict === "agrees" ? "pill-model" : "pill-warn"}`}
                title={
                  curated.narrative.verdict === "agrees"
                    ? "The Narrative seat's deep read would have called this coin too"
                    : "The Narrative seat's deep read would not have called this coin"
                }
              >
                <span className="pill-text">Narrative: {curated.narrative.verdict}</span>
              </span>
            )}
            {curated && show("calibrated") && cardCalibratedRate(curated, calls) !== null && (
              <span
                className="pill"
                title={`Of recent out-of-sample calls ranked like this one, the share that hit 2x within 15 min of the alert, before a 50% stop${
                  calls.length > 1 ? " (the middle of the calling models' rates)" : ""
                }`}
              >
                <span className="pill-text">≈{cardCalibratedRate(curated, calls)!.toFixed(0)}% 2x</span>
              </span>
            )}
            {show("time") && <span className="when">{ago(card.matchedAt, now)}</span>}
          </div>
        </div>
        {resultMark && show("result") && (
          <span
            className={`badge card-result ${badge.tone}`}
            role="img"
            title={badge.text}
            aria-label={badge.text}
          >
            {/* Inter has no ⊘, and the fallback font draws it larger than the other marks. */}
            {resultMark === "⊘" ? <span className="result-stop">⊘</span> : resultMark}
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
              <span className="num" title={nowTitle(card, nowMcap, now)}>
                {usd(nowMcap)}
              </span>
              {move !== null && (
                <small className={`num delta ${move >= 0 ? "up" : "down"}`}>
                  {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
                </small>
              )}
            </div>
          )}
          {show("peak") && (
            // Green only on a call that passed: a stop-out or a miss can still have peaked past 2x.
            <div className={`fig peak ${hasPeak && peak >= 100 && result === "pass" ? "hot" : ""}`}>
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
            <div
              title={
                s.liveHolderCount != null
                  ? "Holders: Jupiter's count seconds before the alert (the count the Min holders filter reads)"
                  : "Holders: RugCheck's count (no live count was read for this alert)"
              }
            >
              <dt>Holders</dt>
              <dd className="num">{s.liveHolderCount ?? s.holderCount ?? "–"}</dd>
            </div>
          )}
          {show("age") && (
            <div>
              <dt>Age</dt>
              <dd className="num">{minutes(s.ageMinutes)}</dd>
            </div>
          )}
          {show("top10") && (
            <div
              {...tileLook(
                tiles,
                tileTone(s.top10HolderPct, SAFETY_REJECT_TOP10_HOLDER_PCT),
                s.top10HolderPct != null && s.top10HolderPct >= SAFETY_REJECT_TOP10_HOLDER_PCT,
              )}
              title={`Top 10: share of supply the ten largest holders own (pool aside). The safety screen rejects ${SAFETY_REJECT_TOP10_HOLDER_PCT}% or more.`}
            >
              <dt>Top 10</dt>
              <dd className="num">{pct(s.top10HolderPct)}</dd>
            </div>
          )}
          {show("largest") && (
            <div
              {...tileLook(
                tiles,
                tileTone(largestPct, SAFETY_MAX_LARGEST_HOLDER_PCT),
                largestPct !== null && largestPct > SAFETY_MAX_LARGEST_HOLDER_PCT,
              )}
              title={`Largest holder: one wallet's share of supply (pools aside, its accounts summed). The safety screen rejects over ${SAFETY_MAX_LARGEST_HOLDER_PCT}%.`}
            >
              <dt>Largest</dt>
              <dd className={largestPct === null ? "muted" : "num"}>
                {largestPct === null ? "–" : pct(largestPct)}
              </dd>
            </div>
          )}
          {show("fresh") && (
            <WalletStat
              label="Fresh"
              value={freshPct}
              of={freshOf}
              failsAbove={SAFETY_MAX_FRESH_WALLET_PCT}
              atAlert={freshAtAlert !== null}
              tiles={tiles}
              explain="top-holder wallets first used, or used again after a week or more idle, in the last 24h"
            />
          )}
          {show("empty") && (
            <WalletStat
              label="Empty"
              value={emptyPct}
              of={emptyOf}
              failsAt={SAFETY_REJECT_EMPTY_WALLET_PCT}
              atAlert={emptyAtAlert !== null}
              tiles={tiles}
              explain="top-10 holder wallets with under $25 of other tokens"
            />
          )}
          {show("snipers") && (
            <div
              {...tileLook(
                tiles,
                tileTone(
                  firstHolding,
                  Math.ceil(
                    (TILE_RED_FIRST_BUYERS * (firstSeen ?? TILE_FIRST_BUYERS_OF)) / TILE_FIRST_BUYERS_OF,
                  ),
                ),
                false,
              )}
              title={
                firstHolding === null
                  ? "First buyers holding: not checked yet for this token"
                  : `First buyers holding: ${firstHolding} of the first ${firstSeen ?? 25} buyers after launch still hold 0.1% of the supply or more${
                      buyersAtAlert ? ", at alert time" : ", from a scan after the alert"
                    }`
              }
            >
              <dt className="dt-long">1st Buyers Holding</dt>
              <dd className="num">{firstHolding === null ? "–" : `${firstHolding}/${firstSeen ?? 25}`}</dd>
            </div>
          )}
          {show("sniperTop10") && <SniperTile reading={snipers} tiles={tiles} />}
          {show("linked") && (
            <LinkedTile
              pct={linkedPct}
              count={linkedN}
              kols={linkedKols}
              bundled={linkedBundled}
              clusters={linkedClusters}
              atAlert={linkedAtAlert && linkedPct !== null}
              tiles={tiles}
            />
          )}
          {show("cexFunded") && (
            <div
              {...tileLook(
                tiles,
                tileTone(cexCount, countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, cexHolders)),
                cexCount !== null && cexCount >= countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, cexHolders),
              )}
              title={
                cexPct === null
                  ? "CEX-funded: not checked yet. Funder reads are limited per scan, and tokens closest to alerting go first."
                  : `CEX-funded: ${cexCount ?? "?"} of the ${cexHolders ?? 25} largest holders were opened from an exchange (or a busy service like a bridge), ${
                      cexAtAlert ? "at alert time" : "from a scan after the alert"
                    }. The safety screen rejects ${countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, cexHolders)} or more.`
              }
            >
              <dt>CEX</dt>
              <dd className={cexPct === null ? "muted" : "num"}>
                {cexPct === null ? "Not checked" : (cexCountText(cexCount, cexHolders) ?? pct(cexPct))}
              </dd>
            </div>
          )}
          {show("kolBundled") && (
            <div
              {...tileLook(tiles, tileTone(kolBundledPct, TILE_RED_KOL_BUNDLED_PCT), false)}
              title={
                kolBundledPct === null
                  ? "KOL Bundled %: not checked yet. It comes with the linked-wallet reading."
                  : `KOL Bundled %: supply held by KOLs and the top holders tied to them (wallets a KOL funded, possible side wallets, and holders sharing a funder or funding minute with those), ${
                      kolBundledAtAlert ? "at alert time" : "from a scan after the alert"
                    }.`
              }
            >
              <dt>KOL bundled</dt>
              <dd className={kolBundledPct === null ? "muted" : "num"}>
                {kolBundledPct === null ? "Not checked" : pct(kolBundledPct, 1)}
              </dd>
            </div>
          )}
          {show("transferred") && (
            <div
              {...tileLook(tiles, tileTone(transferredPct, TILE_RED_TRANSFERRED_PCT), false)}
              title={
                transferredPct === null
                  ? "Transferred: not checked yet. Transfers between the top 25 holders are read for the coins closest to a call."
                  : transferredPct === 0
                    ? `Transferred: none of the top ${transferCount?.of ?? 25} holders sent the coin to another, ${transferAtAlert ? "at alert time" : "from a scan after the alert"}.`
                    : `Transferred Supply %: ${pct(transferredPct, 1)} of supply moved holder to holder${
                        transferCount
                          ? `, between ${transferCount.linked} of the top ${transferCount.of} holders`
                          : ""
                      } (the coin itself only; SOL and other coins are ignored), ${
                        transferAtAlert ? "at alert time" : "from a scan after the alert"
                      }. Not counted in Linked; the bubble map draws each transfer.`
              }
            >
              <dt>Transferred</dt>
              <dd className={transferredPct === null ? "muted" : "num"}>
                {transferredPct === null ? (
                  "Not checked"
                ) : transferCount && transferredPct > 0 ? (
                  <>
                    {pct(transferredPct, 1)}{" "}
                    <span className="dd-sub">
                      ({transferCount.linked}/{transferCount.of})
                    </span>
                  </>
                ) : (
                  pct(transferredPct, 1)
                )}
              </dd>
            </div>
          )}
          {show("dev") && (
            <div
              title={
                (devHolding === null
                  ? "Dev Holding / Dev Sold: not known for this token yet"
                  : devHolding
                    ? "DH = Dev Holding: the creator's wallet still holds this token (as of the latest scan)"
                    : "DS = Dev Sold: the creator's wallet holds none of this token (as of the latest scan)") +
                (feeLine ? `\n${feeLine}` : "")
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

      {(show("mint") || show("sage") || fees || show("links") || trade.length > 0) && (
        <footer className="card-foot">
          {(show("mint") || show("sage")) && (
            <div className="card-foot-left">
              {show("mint") && (
                <button className="mint" onClick={copy} title="Copy mint address">
                  {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                  {copied ? "Copied" : shortAddress(mint)}
                </button>
              )}
              {show("sage") && (
                <button
                  className="sage-btn"
                  onClick={() => openSage(mint)}
                  title="Open TokenSage's read of this coin: what it's about, its lineage, X link and flags"
                >
                  <SageIcon size={13} />
                  Sage
                </button>
              )}
            </div>
          )}
          {fees && (
            <span className={`fee-badge fee-${fees.kind}`} title={fees.title} aria-label={fees.title}>
              <span className="fee-word">FEES</span>
              <fees.Icon size={14} />
            </span>
          )}
          {(show("links") || trade.length > 0) && (
            <nav className="card-links">
              {trade.map((l) => (
                <a key={l.id} className="trade" href={l.href(mint)} target="_blank" rel="noreferrer">
                  {l.label}
                  <ExternalIcon size={11} />
                </a>
              ))}
              {show("links") &&
                LINKS.map((l) => (
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

const FEE_BADGES = {
  charity: { Icon: HeartIcon, label: "go to a charity" },
  rewards: { Icon: GiftIcon, label: "go to holders or another wallet" },
  github: { Icon: RobotIcon, label: "go to a GitHub account" },
  dev: { Icon: ChefHatIcon, label: "go to the dev" },
} as const;

/**
 * The footer's FEES badge: where the coin's creator fee goes (TokenSage's read), as one outline
 * icon - a heart for a charity, a gift for holder rewards or any other wallet, a robot for a GitHub
 * account, a chef's hat for the dev. Nothing when TokenSage hasn't read the coin or can't tell.
 */
export function feeBadge(fee: Card["token"]["creatorFee"]): {
  kind: keyof typeof FEE_BADGES;
  Icon: (typeof FEE_BADGES)[keyof typeof FEE_BADGES]["Icon"];
  title: string;
} | null {
  const kind = feeKind(fee?.destination);
  if (!kind) return null;
  const { Icon, label } = FEE_BADGES[kind];
  const summary = fee?.summary?.trim().replace(/\.$/, "");
  return {
    kind,
    Icon,
    title: summary ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.` : `Creator fees ${label}.`,
  };
}

/** TokenSage's fee destination as a badge kind (packages/core/src/datasources/tokensage.ts). */
function feeKind(destination: string | null | undefined): keyof typeof FEE_BADGES | null {
  switch (destination) {
    case "charity":
      return "charity";
    case "github":
      return "github";
    case "creator":
      return "dev";
    // Holders, cashback to traders, another wallet or account, or a split among several of them.
    case "holder_rewards":
    case "cashback":
    case "wallet":
    case "split":
    case "social":
    case "x":
    case "x_account":
      return "rewards";
    default:
      return null;
  }
}

/** Fresh over the top 25 as a share, where the scan counted it; null otherwise. */
function freshTopShare(x: Pick<Snapshot, "freshTopHolderCount" | "freshTopHoldersChecked">): number | null {
  return x.freshTopHolderCount != null && x.freshTopHoldersChecked
    ? (x.freshTopHolderCount / x.freshTopHoldersChecked) * 100
    : null;
}

/**
 * The wallet and holder readings a card shows, each from the alert's snapshot when the lookup
 * made it in time, else from a later scan (both wallet checks are paid lookups with a per-scan
 * budget, so a token can go unchecked). Shared with the token modal.
 */
export function cardReadings(card: Card) {
  const s = card.snapshot;
  const latest = card.latestSnapshot;
  // Each wallet check with the size of the list it read, from the same scan as the share. Fresh
  // reads the top 25 where the scan counted them (user decision 2026-10-14, "N/25"), else the top 10.
  const freshFrom =
    [s, latest].find((x) => x && (freshTopShare(x) !== null || x.freshTop10WalletPct != null)) ?? null;
  const freshPct =
    (freshFrom && (freshTopShare(freshFrom) ?? freshFrom.freshTop10WalletPct)) ??
    card.token.lastFreshTop10WalletPct ??
    null;
  const freshAtAlert = freshFrom === s ? freshPct : null;
  const emptyFrom = s.emptyTop10WalletPct != null ? s : latest?.emptyTop10WalletPct != null ? latest : null;
  const emptyAtAlert = s.emptyTop10WalletPct ?? null;
  const emptyPct = emptyFrom?.emptyTop10WalletPct ?? card.token.lastEmptyTop10WalletPct ?? null;
  // Launch snipers among the top holders: the top-25 count where the scan kept it, else the top-10
  // share as a count; at alert time or from a later scan.
  const sniperFrom =
    s.sniperTopHolderCount != null || s.sniperTop10WalletPct != null
      ? s
      : latest?.sniperTopHolderCount != null || latest?.sniperTop10WalletPct != null
        ? latest
        : null;
  // Linked wallets: top holders one funder paid for (or that funded each other), at alert time or
  // from a later scan, with the clusters behind the share for the list under the tiles.
  const linkedFrom = s.linkedWalletPct != null ? s : latest;
  // Exchange-funded share of the largest holders, the same way.
  const cexFrom = s.cexFundedPct != null ? s : latest;
  // KOL Bundled %, the same way.
  const kolFrom = s.kolBundledPct != null ? s : latest;
  // Transferred Supply %, the same way.
  const transferFrom = s.transferredSupplyPct != null ? s : latest;
  // The same fallback for the first-buyers count, read from the launch's first transactions: the
  // buyers holding 0.1% of the supply or more (user decision 2026-10-16), kept since then.
  const buyersFrom = s.firstBuyersHoldingCut != null ? s : latest;
  // Whether the dev still holds: the newest reading first, since a dev can sell after the alert.
  const devHolding = latest?.devHolding ?? s.devHolding ?? null;
  // Where the creator fee goes (TokenSage), under the Dev tile's tooltip: about 14% of coins
  // send it to holders, a charity, a GitHub account or other wallets instead of the dev.
  const fee = card.token.creatorFee;
  const feeLine = fee?.summary
    ? `${fee.summary.charAt(0).toUpperCase()}${fee.summary.slice(1).replace(/\.$/, "")}.`
    : null;
  return {
    freshPct,
    freshOf:
      freshFrom && freshTopShare(freshFrom) !== null
        ? freshFrom.freshTopHoldersChecked!
        : (freshFrom?.top10WalletsChecked ?? null),
    freshAtAlert,
    emptyPct,
    emptyOf: emptyFrom?.top10WalletsChecked ?? null,
    emptyAtAlert,
    snipers: sniperFrom ? sniperReading(sniperFrom, sniperFrom === s) : null,
    largestPct: s.largestHolderPct ?? latest?.largestHolderPct ?? null,
    ...linkedTileReading(linkedFrom),
    linkedAtAlert: linkedFrom === s,
    linkedClusters: linkedFrom?.linkedClusters ?? [],
    cexPct: cexFrom?.cexFundedPct ?? null,
    cexAtAlert: cexFrom === s,
    cexCount: cexFrom?.cexFundedCount ?? null,
    cexHolders: cexFrom?.cexFundedHolders ?? null,
    kolBundledPct: kolFrom?.kolBundledPct ?? null,
    kolBundledAtAlert: kolFrom === s,
    transferredPct: transferFrom?.transferredSupplyPct ?? null,
    transferCount:
      transferFrom?.transferWalletCount != null && transferFrom.transferHoldersChecked != null
        ? { linked: transferFrom.transferWalletCount, of: transferFrom.transferHoldersChecked }
        : null,
    transferAtAlert: transferFrom === s,
    firstHolding: buyersFrom?.firstBuyersHoldingCut ?? null,
    firstSeen: buyersFrom?.firstBuyersSeen ?? null,
    buyersAtAlert: buyersFrom === s,
    devHolding,
    feeLine,
  };
}

/**
 * The safety screen's wallet cuts (packages/core/src/scoring/rugScreen.ts, SAFETY_MAX_FRESH_WALLET_PCT,
 * SAFETY_REJECT_EMPTY_WALLET_PCT and SAFETY_REJECT_SNIPER_WALLET_PCT): fresh wallets fail over 70%,
 * empty wallets and launch snipers each fail at 80% or more. A tile turns red only when its reading
 * would fail the screen. SAFETY_REJECT_TOP10_HOLDER_PCT: a top ten owning 40% or more fails too.
 */
export const SAFETY_MAX_FRESH_WALLET_PCT = 70;
export const SAFETY_REJECT_EMPTY_WALLET_PCT = 80;
export const SAFETY_REJECT_SNIPER_WALLET_PCT = 80;
export const SAFETY_REJECT_TOP10_HOLDER_PCT = 40;
/** SAFETY_MAX_LARGEST_HOLDER_PCT: one holder owning over 10% of supply (pools aside) fails. */
export const SAFETY_MAX_LARGEST_HOLDER_PCT = 10;
/** SAFETY_REJECT_LINKED_COUNT: 20 or more of the top 25 holders (pools aside) linked fails. */
export const SAFETY_REJECT_LINKED_COUNT = 20;
/** SAFETY_REJECT_CEX_FUNDED_COUNT: 21 or more of the top 25 holders funded from an exchange fails. */
export const SAFETY_REJECT_CEX_FUNDED_COUNT = 21;
/** SAFETY_COUNT_CUT_HOLDERS: the holder list the count cuts are set on. */
export const SAFETY_COUNT_CUT_HOLDERS = 25;

/**
 * countCutFor: a count cut set on the top 25, for a reading over fewer holders - the same share,
 * rounded up (20 of 25 is 16 of 19). The screen applies it the same way.
 */
export function countCutFor(cut: number, checked: number | null | undefined): number {
  if (checked == null || checked <= 0 || checked >= SAFETY_COUNT_CUT_HOLDERS) return cut;
  return Math.ceil((cut * checked) / SAFETY_COUNT_CUT_HOLDERS);
}

/** The CEX-funded tile's reading, "N/25", or null when not read. */
export function cexCountText(count: number | null, holders: number | null): string | null {
  return count === null ? null : `${count}/${holders ?? SAFETY_COUNT_CUT_HOLDERS}`;
}

/**
 * A wallet check as a count, "N/10" or "N/25" (Fresh over the top 25), of the wallets the list held (9 when one owner held two
 * of the ten accounts); null without a reading. Rows without the list size read as ten.
 */
export function walletCountText(value: number | null, of: number | null): string | null {
  if (value === null) return null;
  const n = of && of > 0 ? of : 10;
  return `${Math.round((value * n) / 100)}/${n}`;
}

/** One wallet-check tile (Fresh or Empty): N of the top 10, where it was read, or that it wasn't checked. */
export function WalletStat({
  label,
  value,
  of = null,
  atAlert,
  explain,
  failsAbove,
  failsAt,
  tiles = "off",
}: {
  label: string;
  value: number | null;
  /** How many wallets the check read (the top 10, or the top 25 for Fresh). */
  of?: number | null;
  atAlert: boolean;
  explain: string;
  /** The screen rejects strictly above this share. */
  failsAbove?: number;
  /** The screen rejects at or above this share. */
  failsAt?: number;
  /** How the tile takes its scale up to the cut (the alert card's, with tile colors on). */
  tiles?: TileMode;
}) {
  const risky =
    value !== null &&
    ((failsAbove !== undefined && value > failsAbove) || (failsAt !== undefined && value >= failsAt));
  const title =
    value === null
      ? `${label}: not checked yet. Wallet checks are limited per scan, and tokens closest to alerting go first.`
      : `${label}: ${walletCountText(value, of)} ${explain} (${pct(value)}), ${atAlert ? "at alert time" : "from a scan after the alert"}. The safety screen rejects ${failsAbove !== undefined ? `over ${failsAbove}%` : `${failsAt ?? 0}% or more`}.`;
  return (
    <div {...tileLook(tiles, tileTone(value, failsAbove ?? failsAt ?? 0), risky)} title={title}>
      <dt>{label}</dt>
      <dd className={value === null ? "muted" : "num"}>
        {value === null ? "Not checked" : walletCountText(value, of)}
      </dd>
    </div>
  );
}

/** Launch snipers among the top holders, as the Snipers tile reads them. */
export interface SniperReading {
  /** How many top holders were among the launch's first 25 buyers, of how many read. */
  count: number;
  of: number;
  /** Whether the count is over the top 25 (else the top-10 share on a scan before it was kept). */
  top25: boolean;
  /** The top-10 share the safety screen cuts on, when read. */
  top10Pct: number | null;
  top10Of: number | null;
  atAlert: boolean;
}

/** A scan's snipers reading: the top-25 count, else the top-10 share as a count; null without either. */
export function sniperReading(
  s: Pick<
    Card["snapshot"],
    "sniperTopHolderCount" | "sniperTopHoldersChecked" | "sniperTop10WalletPct" | "top10WalletsChecked"
  >,
  atAlert: boolean,
): SniperReading | null {
  const top10Pct = s.sniperTop10WalletPct ?? null;
  const top10Of = s.top10WalletsChecked ?? null;
  if (s.sniperTopHolderCount != null) {
    return {
      count: s.sniperTopHolderCount,
      of: s.sniperTopHoldersChecked ?? SAFETY_COUNT_CUT_HOLDERS,
      top25: true,
      top10Pct,
      top10Of,
      atAlert,
    };
  }
  if (top10Pct === null) return null;
  const of = top10Of && top10Of > 0 ? top10Of : 10;
  return { count: Math.round((top10Pct * of) / 100), of, top25: false, top10Pct, top10Of, atAlert };
}

/**
 * The Snipers tile: how many top holders (the top 25, pools aside) were among the launch's first
 * 25 buyers, "N/25". Red when the top ten would fail the safety screen's sniper cut, which still
 * reads the top ten (8 or more of 10).
 */
export function SniperTile({
  reading,
  tiles = "off",
}: {
  reading: SniperReading | null;
  /** How the tile takes its scale up to the cut (the alert card's, with tile colors on). */
  tiles?: TileMode;
}) {
  const risky = reading?.top10Pct != null && reading.top10Pct >= SAFETY_REJECT_SNIPER_WALLET_PCT;
  // The cut reads the top ten; a scan without that share is placed by its top-25 share instead.
  const share =
    reading === null
      ? null
      : (reading.top10Pct ?? (reading.of > 0 ? (reading.count * 100) / reading.of : null));
  const top10 =
    reading?.top10Pct != null ? ` In the top 10: ${walletCountText(reading.top10Pct, reading.top10Of)}.` : "";
  const title =
    reading === null
      ? "Snipers: not checked yet. The launch's first buyers are read a few tokens per scan."
      : `Snipers: ${reading.count} of the ${reading.of} largest holders${reading.top25 ? "" : " (top 10 only on this scan)"} were among the first 25 buyers after launch, ${
          reading.atAlert ? "at alert time" : "from a scan after the alert"
        }.${top10} The safety screen rejects ${SAFETY_REJECT_SNIPER_WALLET_PCT / 10} or more of the top 10.`;
  return (
    <div {...tileLook(tiles, tileTone(share, SAFETY_REJECT_SNIPER_WALLET_PCT), risky)} title={title}>
      <dt>Snipers</dt>
      <dd className={reading === null ? "muted" : "num"}>
        {reading === null ? "Not checked" : `${reading.count}/${reading.of}`}
      </dd>
    </div>
  );
}

type LinkedClusterView = NonNullable<Card["snapshot"]["linkedClusters"]>[number];

/** The cluster line the tile's tooltip and the list lead with: "4 wallets from one funder hold 31%". */
export function linkedSummary(clusters: readonly LinkedClusterView[]): string | null {
  const top = clusters[0];
  if (!top) return null;
  const more =
    clusters.length > 1 ? `, and ${clusters.length - 1} more cluster${clusters.length > 2 ? "s" : ""}` : "";
  return `${top.wallets.length} wallets from one funder hold ${pct(top.pct)}${top.creatorLinked ? " (tied to the creator)" : ""}${more}`;
}

/**
 * The Linked tile's count and share: Bundled % where the scan kept it, so KOL bundles count as the
 * bubble map counts them (user ask 2026-10-15), else the scan's own linked holders. The safety
 * screen keeps the scan's own count.
 */
export function linkedTileReading(
  s: Pick<
    Card["snapshot"],
    | "linkedWalletPct"
    | "linkedWalletCount"
    | "linkedWalletsChecked"
    | "linkedClusters"
    | "linkedHolders"
    | "bundledSupplyPct"
    | "bundledSupplyCount"
  > | null,
): {
  linkedPct: number | null;
  linkedCount: { linked: number; of: number } | null;
  linkedKols: boolean;
  linkedBundled: boolean;
} {
  if (!s) return { linkedPct: null, linkedCount: null, linkedKols: false, linkedBundled: false };
  const scan = linkedCount(s);
  if (s.linkedWalletPct != null && s.bundledSupplyPct != null && s.bundledSupplyCount != null && scan) {
    return {
      linkedPct: s.bundledSupplyPct,
      linkedCount: { linked: s.bundledSupplyCount, of: scan.of },
      linkedKols: s.bundledSupplyCount > scan.linked,
      linkedBundled: true,
    };
  }
  return { linkedPct: s.linkedWalletPct ?? null, linkedCount: scan, linkedKols: false, linkedBundled: false };
}

/** The reading behind the Linked tile, for the token view's bubble map to draw the same one. */
export function linkedReading(card: Card): Snapshot | null {
  const s = card.snapshot;
  return s.linkedWalletPct != null ? s : (card.latestSnapshot ?? null);
}

/**
 * The Linked tile: how many top holders are linked, "N/25" (user ask 2026-10-13), KOLs' bundles
 * included, with the supply they hold beside it in smaller type (user ask 2026-10-15). A plain
 * tile: a tap opens the token view like the rest of the card (user ask 2026-10-15).
 */
function LinkedTile({
  pct: value,
  count,
  kols,
  bundled,
  clusters,
  atAlert,
  tiles,
}: {
  pct: number | null;
  count: { linked: number; of: number } | null;
  /** Whether KOLs' bundles add holders the scan's own count leaves out. */
  kols: boolean;
  /** Whether the reading is Bundled % (KOLs' bundles checked), not only the scan's own linked holders. */
  bundled: boolean;
  clusters: readonly LinkedClusterView[];
  atAlert: boolean;
  tiles: TileMode;
}) {
  const cut = countCutFor(SAFETY_REJECT_LINKED_COUNT, count?.of);
  const summary = linkedSummary(clusters);
  const title =
    value === null
      ? "Linked: not checked yet. Who paid for each top-25 wallet is read a few tokens per scan."
      : value === 0
        ? `Linked: no two top-25 wallets share a funder or a funding minute${bundled ? ", and no KOL bundles any" : ""}, ${atAlert ? "at alert time" : "from a scan after the alert"}.`
        : `Linked: ${count ? `${count.linked} of the ${count.of} top holders, ` : ""}holding ${pct(value)} of supply${bundled ? ` (Bundled %), counting wallets in a funder's cluster, a funding minute or a KOL's bundle${kols ? " (KOLs' bundles add some)" : ""}` : ", KOLs' bundles not checked on this scan"}${summary ? `. ${summary}` : ""}, ${atAlert ? "at alert time" : "from a scan after the alert"}. The safety screen counts linked holders without KOLs' bundles and rejects ${countCutFor(SAFETY_REJECT_LINKED_COUNT, count?.of)} or more.`;
  return (
    <div
      {...tileLook(tiles, tileTone(count?.linked, cut), count !== null && count.linked >= cut)}
      title={title}
    >
      <dt>Linked</dt>
      <dd className={value === null ? "muted" : "num"}>
        {value === null ? (
          "Not checked"
        ) : count ? (
          <>
            {linkedCountText(count)} <span className="dd-sub">{pct(value)}</span>
          </>
        ) : (
          pct(value)
        )}
      </dd>
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
 * The token's image as a small thumbnail, falling back through tokenImageSources (the original
 * URL, a second IPFS gateway), then to its initials.
 * On desktop, hovering it shows a large preview; phones get a bigger avatar instead.
 */
function TokenAvatar({ url, symbol }: { url: string | null; symbol: string | null }) {
  // An index into tokenImageSources; past its end, the initials.
  const [attempt, setAttempt] = useState(0);
  const [spot, setSpot] = useState<PreviewSpot | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  const safe = url?.startsWith("https://") ? url : null;
  const src = tokenImageSources(safe, THUMB_PX)[attempt] ?? null;

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

/** The model pill's tooltip: the number beside a model's name is a rank, not odds. */
const SCORE_HINT = "Rank score 0-100, not a probability";

/**
 * The highest of every peak the card knows, as a return on the alert market cap it shows - the
 * call's (its run peak or market-cap high since), and the filter alert's own ATH when the card is
 * both - so it never drops to a smaller one. And whether that is the call's run peak, the one its
 * runPeakMinutes times.
 *
 * A card a call folded into keeps the filter alert's market cap, while the call's Peak is from its
 * own alert price (up to hours apart, so possibly far lower): the call's high is re-based onto the
 * card's market cap first, and only when it came at or after the filter alert (peakAt) - a run that
 * peaked and pulled back before the filter fired is no run above its price. That Peak is never
 * timed by the call's runPeakMinutes, which count from the call, not the alert the card shows.
 * Older API builds send no peakMcapUsd and keep the call's percentage.
 */
export function recordedPeakOf(card: Card): { pct: number | null; isRunPeak: boolean } {
  const curated = card.curated;
  const runPeak = curated?.outcome.peak24hReturnPct ?? null;
  // The API's Peak is authoritative when sent, null included: once the candles vouch for a call it
  // leaves out the watcher's run peak (callPeakPct), so falling back to it here would put back the
  // stale reading the candles corrected. Only older API builds, which send none, use the run peak.
  const callPeak = curated?.peakPct !== undefined ? curated.peakPct : runPeak;
  const alertMcap = card.snapshot.marketCapUsd;
  const folded = card.kind === "match" && !!curated && curated.peakMcapUsd !== undefined;
  const peakAt = curated?.peakAt ? Date.parse(curated.peakAt) : NaN;
  const callHere = folded
    ? curated.peakMcapUsd != null && alertMcap > 0 && peakAt >= Date.parse(card.matchedAt)
      ? (curated.peakMcapUsd / alertMcap - 1) * 100
      : null
    : callPeak;
  const pct = maxKnown(callHere, card.peakReturnPct);
  return {
    pct,
    isRunPeak: !folded && pct !== null && pct === callHere && runPeak !== null && callPeak === runPeak,
  };
}

/**
 * How long after a model call a market-cap reading starts to say where the coin is now. The call
 * is priced from a seconds-old quote, while the readings behind "Now" (scan snapshots and live
 * pings, both DexScreener) run 45-60 s behind the market: one from the first minute still shows
 * the market from before the call. The server ignores those for the call's Peak
 * (CALL_PEAK_READING_LAG_MS); folded into the Peak here, CASINO's $11.4K call read "Now $47.5K
 * ▲316%" and an ATH of $47.5K for its first minute.
 */
export const CALL_READING_LAG_MS = 60_000;

/**
 * The card's "Now" market cap, or null while the only reading is from the first minute after a
 * price read fresh (see CALL_READING_LAG_MS): a model call's, or a filter alert's priced from a
 * fresh quote (alertMcapUsd). A filter alert on the snapshot's own DexScreener figure lags like its
 * readings, so it shows every one.
 */
export function nowReading(card: Card): number | null {
  const mcap = card.currentMarketCapUsd;
  if (mcap === null) return mcap;
  const pricedAt =
    card.kind === "match"
      ? card.alertMcapUsd != null
        ? card.matchedAt
        : null
      : (card.curated?.alertedAt ?? null);
  if (pricedAt === null) return mcap;
  const at = card.currentMarketCapAt ? Date.parse(card.currentMarketCapAt) : NaN;
  const calledAt = Date.parse(pricedAt);
  if (!Number.isFinite(at) || !Number.isFinite(calledAt)) return mcap;
  return at >= calledAt + CALL_READING_LAG_MS ? mcap : null;
}

/**
 * How far over the "hide below" line a hidden card has to climb before it shows again, so a coin
 * trading right at the line doesn't flick in and out with every reading.
 */
export const MCAP_RESHOW_MARGIN = 1.1;

/**
 * Whether the Live feed's "hide below this market cap" setting hides this card: its "Now" market cap
 * is known and under the line - or, for a card already hidden (`wasHidden`), not yet back over the
 * line plus MCAP_RESHOW_MARGIN. Display only - stats and grading still count the alert. A card with
 * no reading keeps what it was (shown, the first time).
 */
export function belowMcapLine(
  card: Card,
  look: Pick<FeedAppearance, "hideBelowMcap" | "hideBelowMcapUsd">,
  wasHidden = false,
): boolean {
  if (!look.hideBelowMcap) return false;
  const mcap = nowReading(card);
  if (mcap === null) return wasHidden;
  return mcap < look.hideBelowMcapUsd * (wasHidden ? MCAP_RESHOW_MARGIN : 1);
}

/** The "Now" figure's tooltip: why it is blank in a call's first minute, or how old it is. */
function nowTitle(card: Card, nowMcap: number | null, now: number): string | undefined {
  if (nowMcap === null && card.currentMarketCapUsd !== null) {
    return "Shows from the first reading a minute after the call: earlier ones lag the market";
  }
  const at = card.currentMarketCapAt ? Date.parse(card.currentMarketCapAt) : NaN;
  if (nowMcap === null || !Number.isFinite(at)) return undefined;
  const minutes = Math.floor((now - at) / 60_000);
  return minutes >= 2 ? `Read ${minutes} minutes ago` : undefined;
}

/** The larger of two peaks either of which may be missing. */
function maxKnown(a: number | null | undefined, b: number | null | undefined): number | null {
  const known = [a, b].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length === 0 ? null : Math.max(...known);
}
