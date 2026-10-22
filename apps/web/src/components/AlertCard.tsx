import { useEffect, useState } from "react";
import { QuickBuyPill } from "./QuickBuyPill";
import { quickBuyShown, useProState, useTradeSettings, type QuickBuySettings } from "../proTrade";
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
  usd,
} from "../format";
import {
  BrainIcon,
  ChefHatIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  EyeOffIcon,
  GiftIcon,
  GlobeIcon,
  HeartIcon,
  RobotIcon,
  SlidersIcon,
  XLogoIcon,
} from "./Icons";
import { CardSearchButton } from "./CardSearchButton";
import { DeskRewardTokens } from "./DeskRewardTokens";
import { DexInfoLabel } from "../dexInfoLabel";
import { XLinkPreview } from "./XLinkPreview";
import { useImagePreview } from "./ImagePreview";
import { linkedCount, linkedCountText } from "../linkedCount";
import { cardOutcome, outcomeBadge, outcomeResult } from "../outcome";
import { QUICK_LINK_SITES, pumpFunHref, useAppearance } from "../appearance";
import { useShowNarrativeNote } from "../narrativeNote";
import { calibratedRateLabel, cardCalibratedRate } from "../rates";
import { scoreTone, scoreToneColor, scoreTooltip, useScoreWeights } from "../scoreWeights";
import { filterCardStyle } from "../filterStyle";
import { quoteToken } from "../quoteToken";
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

/** The coin's Dex and Pump pages (the card footer's links; Scope's trade links too). */
export const LINKS = [
  { label: "Dex", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump", href: pumpFunHref },
];

export function AlertCard({
  card,
  now,
  compact = false,
  labelSource = false,
  hide,
  detail = true,
  links = true,
  onHide,
  atAlert = false,
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
  /** Dex, Pump, and trade links (off for a made-up example card, which has no coin to open). */
  links?: boolean;
  /**
   * The stat tiles show the alert's own scan instead of the newest (the signed-out page's best
   * call: the stats that came before the run, user ask 2026-10-19).
   */
  atAlert?: boolean;
  /** Hides the card's token from the Live feed (user ask 2026-10-19); no button without it. */
  onHide?: () => void;
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
  // The stat tiles show the newest scan, the alert's value in the tooltip (user decision
  // 2026-10-17: the result mark already says how the alert did).
  // At the alert, the newest scan is left out, so every tile reads the alert's own.
  const tileCard = atAlert ? { ...card, latestSnapshot: null } : card;
  const t = newestStats(tileCard);
  // The newest scan's age once it is old enough to matter: those tiles dim and say it (user
  // decision 2026-10-19). A coin under the low-cap floor keeps its price live but stops being
  // scanned, so its holders and volume would otherwise read as current hours later.
  const aged = atAlert ? null : scanAge(card, now);
  const agedTag = aged === null ? null : <span className="fig-age"> · {aged}</span>;
  const agedClass = aged === null ? undefined : "aged";
  const tone = scoreColor ? scoreTone(t.score, scale) : null;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pro = useProState();
  const tradeSettings = useTradeSettings();
  // The modal lives above the feed (TokenModalHost), so it stays open if this card leaves it.
  const openDetailModal = () => openTokenModal(card, now);
  useEffect(() => refreshTokenModal(card, now), [card, now]);
  const alertMcap = s.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  // How old "Now" is, once it is old enough to matter (the live tick keeps it seconds old).
  const nowAge = nowReadingAge(card, nowMcap, now);
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
      ? (curated?.outcome?.runPeakMinutes ?? null)
      : null;
  const {
    freshPct,
    freshOf,
    freshAtAlert,
    freshFromScan,
    emptyPct,
    emptyOf,
    emptyAtAlert,
    emptyFromScan,
    snipers,
    largestPct,
    largestAtAlert,
    linkedPct,
    linkedCount: linkedN,
    linkedKols,
    linkedBundled,
    linkedAtAlert,
    linkedClusters,
    linkedCreatorPct,
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
    firstHoldingOld,
    firstSeenOld,
    devHolding,
    devFromLatest,
    feeLine,
  } = cardReadings(tileCard, "newest");
  const devWhen = devFromLatest
    ? `as of the scan ${ago(card.latestSnapshot!.takenAt, now)}`
    : "at alert time";

  // How a tile reading from after the alert is described: the newest scan's age.
  const later = laterScanText(tileCard, now);
  // A wallet tile showing a later scan names the alert's own reading beside it.
  const a = card.snapshot;
  const pctOr = (v: number | null | undefined) => (v == null ? null : pct(v));
  const laterWith = (atAlert: string | null, shown: string | null) =>
    `${later}${atAlertNote(atAlert, shown)}`;
  const alertFresh = freshTopShare(a) ?? a.freshTop10WalletPct ?? null;
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
  const socials = show("socials") ? socialLinks(card.token) : [];

  // Settings > Trading's quick buy, for Pro wallets that switched it on: in the header or footer row
  // on the picked side, never a row of its own (user ask 2026-10-18).
  const quickBuy = (slot: QuickBuySettings["position"]) =>
    detail ? (
      <QuickBuyPill mint={mint} symbol={tokenLabel(card.token)} onNeedsPanel={openDetailModal} slot={slot} />
    ) : null;
  const quickBuyFoot =
    !!detail &&
    !!pro?.pro &&
    quickBuyShown(tradeSettings.quickBuy) &&
    tradeSettings.quickBuy.position.startsWith("bottom");

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  // In the Alert square's corner (user ask 2026-10-19), else at the end of the header when the
  // Alert figure is hidden.
  const hideButton = onHide && (
    <button
      type="button"
      className="card-hide"
      onClick={onHide}
      title={`Hide ${tokenLabel(card.token)} from your feed. Hidden tokens are listed under Hidden, where you can bring them back.`}
      aria-label={`Hide ${tokenLabel(card.token)}`}
    >
      <EyeOffIcon size={13} />
    </button>
  );
  const hideInAlert = figCount > 0 && show("alert");

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
            <QuotePill token={card.token} />
            <DexInfoLabel token={card.token} now={now} />
            {quickBuy("top-left")}
            {show("tokenName") && card.token.name && card.token.symbol && (
              <span className="token-name" title={card.token.name}>
                {card.token.name}
              </span>
            )}
            {show("time") && <span className="when age-chip">{ago(card.matchedAt, now)}</span>}
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
                // A mark, not a worded pill: beside the model pill, the words squeezed both to "Hi…"
                // (user report 2026-10-18).
                <span
                  className="pill pill-icon pill-conviction"
                  role="img"
                  title="High conviction: in the model's top half-percent of decision moments"
                  aria-label="High conviction"
                >
                  ❗
                </span>
              )}
            {curated?.narrative && showNarrative && show("modelPill") && (
              <span
                className={`pill ${curated.narrative.verdict === "agrees" ? "pill-model" : "pill-warn"}`}
                title={
                  curated.narrative.verdict === "agrees"
                    ? "The Narrative seat's deep read would have flagged this coin too"
                    : "The Narrative seat's deep read would not have flagged this coin"
                }
              >
                <span className="pill-text">Narrative: {curated.narrative.verdict}</span>
              </span>
            )}
            {curated && show("calibrated") && calibratedRateLabel(cardCalibratedRate(curated, calls)) && (
              <span
                className="pill pill-rate"
                title={`The share of similarly ranked recent calls that doubled: of alerts like it, this percent hit 2x within 15 min of the alert, before a 50% stop${
                  calls.length > 1 ? " (the middle of the alerting models' rates)" : ""
                }`}
              >
                <span className="pill-text">{calibratedRateLabel(cardCalibratedRate(curated, calls))}</span>
              </span>
            )}
          </div>
        </div>
        <div className="card-tools">
          {quickBuy("top-right")}
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
          {detail && look.cardSearch && (
            <CardSearchButton
              className="card-search"
              symbol={card.token.symbol}
              name={card.token.name}
              mint={card.token.mintAddress}
            />
          )}
          {!hideInAlert && hideButton}
        </div>
      </header>

      {figCount > 0 && (
        <div className="card-figures" style={{ "--fig-cols": figCount } as React.CSSProperties}>
          {show("alert") && (
            <div className="fig">
              <label>Alert</label>
              {hideButton}
              <span className="num">{usd(alertMcap)}</span>
            </div>
          )}
          {show("now") && (
            <div className={`fig${nowAge !== null ? " stale" : ""}`}>
              <label>
                Now
                {nowAge !== null && <span className="fig-age"> · {nowAge}</span>}
              </label>
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
              className={agedClass ? `stat-score ${agedClass}` : "stat-score"}
              title={`${scoreTooltip(t.score, weights, scoreColor ? scale : undefined) ?? "Score"}${t.fromLatest ? `\n${cap(later)}${atAlertNote(s.score == null ? null : String(Math.round(s.score)), t.score == null ? null : String(Math.round(t.score)))}.` : ""}`}
            >
              <dt>Score{agedTag}</dt>
              <dd className="num" style={tone === null ? undefined : { color: scoreToneColor(tone) }}>
                {t.score == null ? "–" : Math.round(t.score)}
              </dd>
            </div>
          )}
          {show("vol") && (
            <>
              <div
                className={agedClass}
                title={`Trading volume over the last 5 minutes, ${t.fromLatest ? later : "at alert time"}${t.fromLatest ? atAlertNote(usd(s.volume5mUsd ?? null), usd(t.volume5mUsd)) : ""}`}
              >
                <dt>Vol 5m{agedTag}</dt>
                <dd className="num">{usd(t.volume5mUsd)}</dd>
              </div>
              <div
                className={agedClass}
                title={`Trading volume over the last hour, ${t.fromLatest ? later : "at alert time"}${t.fromLatest ? atAlertNote(usd(s.volume1hUsd ?? null), usd(t.volume1hUsd)) : ""}`}
              >
                <dt>Vol 1h{agedTag}</dt>
                <dd className="num">{usd(t.volume1hUsd)}</dd>
              </div>
              <div
                className={agedClass}
                title={`Trading volume over the last 24 hours (since launch, for a younger token), ${t.fromLatest ? later : "at alert time"}${t.fromLatest ? atAlertNote(usd(s.volume24hUsd), usd(t.volume24hUsd)) : ""}`}
              >
                <dt>Vol 24h{agedTag}</dt>
                <dd className="num">{usd(t.volume24hUsd)}</dd>
              </div>
            </>
          )}
          {show("holders") && (
            <div
              className={agedClass}
              title={`${t.holdersLive ? "Holders: Jupiter's count (the count the Min holders filter reads)" : "Holders: RugCheck's count (no live count was read)"}, ${t.fromLatest ? later : "at alert time"}${t.fromLatest ? atAlertNote(fmtCount(s.liveHolderCount ?? s.holderCount), fmtCount(t.holders)) : ""}`}
            >
              <dt>Holders{agedTag}</dt>
              <dd className="num">{t.holders ?? "–"}</dd>
            </div>
          )}
          {show("age") && (
            <div
              title={
                s.ageMinutes == null
                  ? undefined
                  : atAlert
                    ? "Age at the alert."
                    : `Age now. It was ${minutes(s.ageMinutes)} old at the alert.`
              }
            >
              <dt>Age</dt>
              <dd className="num">{minutes(atAlert ? s.ageMinutes : ageNow(s, now))}</dd>
            </div>
          )}
          {show("top10") && (
            <div
              {...withAged(
                tileLook(
                  tiles,
                  tileTone(t.top10Pct, SAFETY_REJECT_TOP10_HOLDER_PCT),
                  t.top10Pct != null && t.top10Pct >= SAFETY_REJECT_TOP10_HOLDER_PCT,
                ),
                agedClass,
              )}
              title={`Top 10: share of supply the ten largest holders own (pool aside), ${t.top10FromLatest ? `${later}${atAlertNote(s.top10HolderPct == null ? null : pct(s.top10HolderPct), pct(t.top10Pct))}` : "at alert time"}. The safety screen rejects ${SAFETY_REJECT_TOP10_HOLDER_PCT}% or more.`}
            >
              <dt>Top 10{agedTag}</dt>
              <dd className="num">{pct(t.top10Pct)}</dd>
            </div>
          )}
          {show("largest") && (
            <div
              {...withAged(
                tileLook(
                  tiles,
                  tileTone(largestPct, SAFETY_MAX_LARGEST_HOLDER_PCT),
                  largestPct !== null && largestPct > SAFETY_MAX_LARGEST_HOLDER_PCT,
                ),
                agedClass,
              )}
              title={`Largest holder: one wallet's share of supply (pools aside, its accounts summed)${largestPct === null ? "" : `, ${largestAtAlert ? "at alert time" : `${later}${atAlertNote(s.largestHolderPct == null ? null : pct(s.largestHolderPct), pct(largestPct))}`}`}. The safety screen rejects over ${SAFETY_MAX_LARGEST_HOLDER_PCT}%.`}
            >
              <dt>Largest{agedTag}</dt>
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
              later={freshFromScan ? laterWith(pctOr(alertFresh), pctOr(freshPct)) : LATER_SCAN}
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
              later={emptyFromScan ? laterWith(pctOr(a.emptyTop10WalletPct), pctOr(emptyPct)) : LATER_SCAN}
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
                  ? firstHoldingOld !== null
                    ? `First buyers holding: not recorded under the 0.1% count. ${oldFirstBuyersText(firstHoldingOld, firstSeenOld)}`
                    : "First buyers holding: not checked yet for this token"
                  : `First buyers holding: ${firstHolding} of the first ${firstSeen ?? 25} buyers after launch still hold 0.1% of the supply or more${
                      buyersAtAlert
                        ? ", at alert time"
                        : `, ${laterWith(a.firstBuyersHoldingCut == null ? null : `${a.firstBuyersHoldingCut}/${a.firstBuyersSeen ?? 25}`, `${firstHolding}/${firstSeen ?? 25}`)}`
                    }`
              }
            >
              <dt className="dt-long">1st Buyers Holding</dt>
              <dd className="num">
                {firstHolding !== null
                  ? `${firstHolding}/${firstSeen ?? 25}`
                  : firstHoldingOld !== null
                    ? `${firstHoldingOld}/${firstSeenOld ?? 25}*`
                    : "–"}
              </dd>
            </div>
          )}
          {show("sniperTop10") && (
            <SniperTile
              reading={snipers}
              tiles={tiles}
              later={laterWith(
                a.sniperTopHolderCount == null
                  ? null
                  : `${a.sniperTopHolderCount}/${a.sniperTopHoldersChecked ?? SAFETY_COUNT_CUT_HOLDERS}`,
                snipers ? `${snipers.count}/${snipers.of}` : null,
              )}
            />
          )}
          {show("linked") && (
            <LinkedTile
              pct={linkedPct}
              count={linkedN}
              kols={linkedKols}
              bundled={linkedBundled}
              clusters={linkedClusters}
              creatorPct={linkedCreatorPct}
              atAlert={linkedAtAlert && linkedPct !== null}
              tiles={tiles}
              later={laterWith(pctOr(a.linkedWalletPct), pctOr(linkedPct))}
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
                      cexAtAlert ? "at alert time" : laterWith(pctOr(a.cexFundedPct), pctOr(cexPct))
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
                  : `KOL Bundled %: supply held by KOLs and the top holders tied to them (wallets a KOL funded, probable side wallets, and holders sharing a funder or funding minute with those), ${
                      kolBundledAtAlert
                        ? "at alert time"
                        : laterWith(pctOr(a.kolBundledPct), pctOr(kolBundledPct))
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
                  ? "Transferred: not checked yet. Transfers between the top 25 holders are read for the coins closest to an alert."
                  : transferredPct === 0
                    ? `Transferred: none of the top ${transferCount?.of ?? 25} holders sent the coin to another, ${transferAtAlert ? "at alert time" : laterWith(pctOr(a.transferredSupplyPct), pctOr(transferredPct))}.`
                    : `Transferred Supply %: ${pct(transferredPct, 1)} of supply moved holder to holder${
                        transferCount
                          ? `, between ${transferCount.linked} of the top ${transferCount.of} holders`
                          : ""
                      } (the coin itself only; SOL and other coins are ignored), ${
                        transferAtAlert
                          ? "at alert time"
                          : laterWith(pctOr(a.transferredSupplyPct), pctOr(transferredPct))
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
                    ? `DH = Dev Holding: the creator's wallet still holds this token (${devWhen})`
                    : `DS = Dev Sold: the creator's wallet holds none of this token (${devWhen})`) +
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
              <strong>
                {ai.decision === "buy" ? "PASS" : ai.decision === "no_buy" ? "REJECT" : "error"}
              </strong>
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

      {(show("mint") || socials.length > 0 || fees || show("links") || trade.length > 0 || quickBuyFoot) && (
        <footer className="card-foot">
          {show("mint") && (
            <div className="card-foot-left">
              <button className="mint" onClick={copy} title="Copy mint address">
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? "Copied" : shortAddress(mint)}
              </button>
            </div>
          )}
          {quickBuy("bottom-left")}
          {/* The coin's X and website, beside the copy button (user ask 2026-10-18). */}
          {socials.length > 0 && (
            <span className="card-socials">
              {socials.map((l) => (
                <XLinkPreview
                  key={l.key}
                  className="pill pill-icon pill-social"
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`${l.label}: ${l.url.replace(/^https:\/\//, "").replace(/\/$/, "")}`}
                  aria-label={`Open the coin's ${l.label}`}
                >
                  <l.Icon size={11} />
                </XLinkPreview>
              ))}
            </span>
          )}
          {fees && <FeeBadge fee={card.token.creatorFee} word />}
          {links && (show("links") || trade.length > 0) && (
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
          {quickBuy("bottom-right")}
        </footer>
      )}
    </article>
  );
}

/**
 * The coin's own X and website as the card footer's link pills (user ask 2026-10-18): only the
 * links it has, and only https ones, whatever the source stored.
 */
export function socialLinks(token: Pick<Card["token"], "twitterUrl" | "websiteUrl">) {
  const https = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u).protocol === "https:" ? u : null;
    } catch {
      return null;
    }
  };
  return [
    { key: "x", label: "X", Icon: XLogoIcon, url: https(token.twitterUrl) },
    { key: "web", label: "Website", Icon: GlobeIcon, url: https(token.websiteUrl) },
  ].filter((l): l is typeof l & { url: string } => l.url !== null);
}

/**
 * The coin the token trades against, beside its ticker, when that isn't SOL (user ask
 * 2026-10-18): "$FOO /USDC" reads as the pair. Nothing for SOL or an unknown quote.
 */
export function QuotePill({
  token,
  className = "",
}: {
  token: Pick<Card["token"], "quoteMint" | "quoteSymbol">;
  className?: string;
}) {
  const quote = quoteToken(token);
  if (!quote) return null;
  return (
    <span
      className={`quote-pill ${className}`}
      title={quote.title}
      aria-label={`Trades against ${quote.label}`}
    >
      <span className="quote-slash" aria-hidden="true">
        /
      </span>
      {quote.label}
    </span>
  );
}

const FEE_BADGES = {
  charity: { Icon: HeartIcon, label: "go to a charity" },
  rewards: { Icon: GiftIcon, label: "go to holders or another wallet" },
  github: { Icon: RobotIcon, label: "go to a GitHub account" },
  dev: { Icon: ChefHatIcon, label: "go to the dev" },
} as const;

/**
 * A charity name safe to show (user ask 2026-10-21). Blank when it isn't a real name: the
 * heart and the token details then keep the generic charity sentence.
 */
export function shownCharityName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const text = name.replace(/\s+/g, " ").trim();
  if (!text || !/\p{L}/u.test(text)) return null;
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

function stopped(text: string | null | undefined): string | null {
  const t = text?.trim().replace(/\.$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : null;
}

/** TokenSage's generic charity sentence, with or without "a", and without a final period. */
const GENERIC_CHARITY = /^creator fees go to (?:a )?charity$/i;

/**
 * The sentence every charity surface shows once Pump.fun has named the organization.
 * A coin with no name yet keeps TokenSage's own sentence.
 */
export function creatorFeeSummary(
  fee:
    | {
        destination?: string | null;
        summary?: string | null;
        charityName?: string | null;
      }
    | null
    | undefined,
): string | null {
  const named = fee?.destination === "charity" ? shownCharityName(fee.charityName) : null;
  const raw = fee?.summary?.trim().replace(/\.$/, "") ?? "";
  if (named) {
    const sentence = `Creator fees go to ${named}.`;
    if (!raw || GENERIC_CHARITY.test(raw)) return sentence;
    const rest = raw.replace(/^creator fees go to (?:a )?charity\b/i, "").trim();
    if (rest !== raw) {
      if (!rest) return sentence;
      const gap = rest.startsWith(":") || rest.startsWith(",") ? "" : " ";
      const joined = `Creator fees go to ${named}${gap}${rest}`;
      return joined.endsWith(".") ? joined : `${joined}.`;
    }
    if (raw.toLowerCase().includes(named.toLowerCase())) return stopped(raw);
    const full = stopped(raw);
    return full ? `${sentence} ${full}` : sentence;
  }
  return stopped(fee?.summary);
}

/** TokenSage's sentence and, when known, the desk's own sentence, each stopped once. */
function showsRecipientList(destination: string | null | undefined): boolean {
  return destination === "charity" || destination === "split";
}

export function creatorFeeLine(fee: Card["token"]["creatorFee"] | null | undefined): string | null {
  const summary =
    (showsRecipientList(fee?.destination) ? feeRecipientSentence(fee) : null) ?? creatorFeeSummary(fee);
  const desk = stopped(fee?.deskLine);
  if (summary && desk && summary !== desk) return `${summary} ${desk}`;
  return summary ?? desk;
}

/**
 * Basis points as a percent beside the gift (user ask 2026-10-21): 5 is 0.05%, 100 is 1%, 300 is 3%.
 * Null when there is no whole rate from 1 to 10000 basis points to show.
 */
export function holderRewardTaxLabel(bps: number | null | undefined): string | null {
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps <= 0 || bps > 10_000) return null;
  const text = (bps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}%`;
}

const REWARD_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface FeeRecipientShare {
  label: string;
  bps: number | null;
}

function joinFeeNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Reward-coin tickers. A mint with no ticker is shortened rather than dropped. */
export function shownRewardLabels(
  fee: { deskRewards?: { label?: string | null; mint?: string | null }[] | null } | null | undefined,
): string[] {
  const rewards = fee?.deskRewards;
  if (!rewards?.length) return [];
  return rewards.flatMap((reward) => {
    const label = reward.label?.trim();
    if (label) return [label];
    const mint = reward.mint?.trim();
    if (mint && REWARD_MINT.test(mint)) return [shortAddress(mint)];
    return [];
  });
}

/**
 * "Red Cross 99% · AbCd…wxyz 1%". A recipient whose label is blank is skipped.
 * Null when there is nobody to name.
 */
export function feeRecipientCaption(
  recipients: readonly FeeRecipientShare[] | null | undefined,
): string | null {
  if (!recipients?.length) return null;
  const parts = recipients.flatMap((recipient) => {
    const label = recipient.label?.trim();
    if (!label) return [];
    const pct = holderRewardTaxLabel(recipient.bps);
    return [pct ? `${label} ${pct}` : label];
  });
  return parts.length ? parts.join(" · ") : null;
}

/** "Creator fees go to Red Cross (99%) and AbCd…wxyz (1%)." */
export function feeRecipientSentence(
  fee: { recipients?: readonly FeeRecipientShare[] | null } | null | undefined,
): string | null {
  const recipients = fee?.recipients;
  if (!recipients?.length) return null;
  const parts = recipients.flatMap((recipient) => {
    const label = recipient.label?.trim();
    if (!label) return [];
    const pct = holderRewardTaxLabel(recipient.bps);
    return [pct ? `${label} (${pct})` : label];
  });
  return parts.length ? `Creator fees go to ${joinFeeNames(parts)}.` : null;
}

/** What the fee icon shows beside itself: reward tokens, else each recipient. */
export function feeBadgeCaption(fee: Card["token"]["creatorFee"]): string | null {
  if (fee?.deskRewards?.length) return null;
  const coins = shownRewardLabels(fee);
  if (coins.length) return coins.join(" · ");
  if (!showsRecipientList(fee?.destination)) return null;
  return (
    feeRecipientCaption(fee?.recipients) ??
    (fee?.destination === "charity" ? shownCharityName(fee.charityName) : null)
  );
}

/**
 * The footer's FEES badge: where the coin's creator fee goes (TokenSage's read), as one outline
 * icon - a heart for a charity, a gift for holder rewards or any other wallet, a robot for a GitHub
 * account, a chef's hat for the dev. A gift also when OTC Desks' roster names the reward coins and
 * TokenSage has not. A holder-reward coin adds its tax beside the gift when the read gave one.
 * On a charity coin the tooltip names the organization when one was loaded (user ask 2026-10-21).
 * Nothing when neither source has said.
 */
export function feeBadge(fee: Card["token"]["creatorFee"]): {
  kind: keyof typeof FEE_BADGES;
  Icon: (typeof FEE_BADGES)[keyof typeof FEE_BADGES]["Icon"];
  title: string;
  /** "0.05%" next to the gift on a holder-reward coin; null otherwise. */
  tax: string | null;
  /** Reward tokens, or each charity and its percent, shown on the badge itself. */
  caption: string | null;
  /** OTC Desks reward coins, shown as logos tucked behind the gift. */
  deskRewards: NonNullable<Card["token"]["creatorFee"]>["deskRewards"] | null;
} | null {
  const coins = shownRewardLabels(fee);
  const kind = feeKind(fee?.destination) ?? (fee?.deskLine?.trim() || coins.length ? "rewards" : null);
  if (!kind) return null;
  const { Icon, label } = FEE_BADGES[kind];
  // TokenSage's sentence, with the charity's organization in that same sentence, and OTC Desks'
  // reward-coin sentence after it when the roster names one.
  const title = creatorFeeLine(fee) ?? `Creator fees ${label}.`;
  const tax = fee?.destination === "holder_rewards" ? holderRewardTaxLabel(fee.bps) : null;
  const caption = feeBadgeCaption(fee);
  const deskRewards = fee?.deskRewards?.length ? fee.deskRewards : null;
  return { kind, Icon, title, tax, caption, deskRewards };
}

/**
 * The fee icon on a token card (`word`) and on a Scope row. Both read `feeBadge`, so the
 * charity names and the OTC reward tokens show in the same words.
 */
export function FeeBadge({
  fee,
  word = false,
  icon = 14,
  className = "",
}: {
  fee: Card["token"]["creatorFee"];
  word?: boolean;
  icon?: number;
  className?: string;
}) {
  const fees = feeBadge(fee);
  if (!fees) return null;
  const aria = [
    fees.title,
    fees.caption && !fees.title.includes(fees.caption) ? fees.caption : null,
    fees.tax ? `Holder reward tax ${fees.tax}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={`fee-badge fee-${fees.kind}${fees.tax ? " has-tax" : ""}${fees.deskRewards ? " has-desk-rewards" : fees.caption ? " has-caption" : ""}${className ? ` ${className}` : ""}`}
      title={fees.title}
      aria-label={aria}
    >
      {word && <span className="fee-word">FEES</span>}
      <fees.Icon size={icon} />
      {fees.deskRewards && <DeskRewardTokens rewards={fees.deskRewards} compact />}
      {fees.caption && <span className="fee-caption num">{fees.caption}</span>}
      {fees.tax && <span className="fee-tax num">{fees.tax}</span>}
    </span>
  );
}

/** TokenSage's fee destination as a badge kind (packages/core/src/datasources/tokensage.ts). */
export function feeKind(destination: string | null | undefined): keyof typeof FEE_BADGES | null {
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
export function cardReadings(card: Card, prefer: "alert" | "newest" = "alert") {
  const s = card.snapshot;
  const latest = card.latestSnapshot;
  // The card reads the newest scan first (user decision 2026-10-17), the token view's "At the
  // alert" section the alert's; each falls back to the other where its scan had no reading.
  // A newest row that is the alert's own scan counts as the alert's.
  const later = latest && latest.takenAt !== s.takenAt ? latest : null;
  const order = prefer === "newest" ? [later, s] : [s, latest];
  const pick = (has: (x: Snapshot) => boolean): Snapshot | null => order.find((x) => x && has(x)) ?? null;
  // Each wallet check with the size of the list it read, from the same scan as the share. Fresh
  // reads the top 25 where the scan counted them (user decision 2026-10-14, "N/25"), else the top 10.
  const freshFrom = pick((x) => freshTopShare(x) !== null || x.freshTop10WalletPct != null);
  const freshPct =
    (freshFrom && (freshTopShare(freshFrom) ?? freshFrom.freshTop10WalletPct)) ??
    card.token.lastFreshTop10WalletPct ??
    null;
  const freshAtAlert = freshFrom === s ? freshPct : null;
  const emptyFrom = pick((x) => x.emptyTop10WalletPct != null);
  const emptyAtAlert = emptyFrom === s ? (s.emptyTop10WalletPct ?? null) : null;
  const emptyPct = emptyFrom?.emptyTop10WalletPct ?? card.token.lastEmptyTop10WalletPct ?? null;
  // Launch snipers among the top holders: the top-25 count where the scan kept it, else the top-10
  // share as a count; at alert time or from a later scan.
  const sniperFrom = pick((x) => x.sniperTopHolderCount != null || x.sniperTop10WalletPct != null);
  // Linked wallets: top holders one funder paid for (or that funded each other), at alert time or
  // from a later scan, with the clusters behind the share for the list under the tiles.
  const linkedFrom = pick((x) => x.linkedWalletPct != null) ?? latest;
  // Exchange-funded share of the largest holders, the same way.
  const cexFrom = pick((x) => x.cexFundedPct != null) ?? latest;
  // KOL Bundled %, the same way.
  const kolFrom = pick((x) => x.kolBundledPct != null) ?? latest;
  // Transferred Supply %, the same way.
  const transferFrom = pick((x) => x.transferredSupplyPct != null) ?? latest;
  // The same fallback for the first-buyers count, read from the launch's first transactions: the
  // buyers holding 0.1% of the supply or more (user decision 2026-10-16), kept since then.
  const buyersFrom = pick((x) => x.firstBuyersHoldingCut != null) ?? latest;
  // Scans before then kept only the older count (any amount held): shown as that, labelled, on
  // tokens with no newer reading, rather than as "not checked yet".
  const oldBuyersFrom = pick((x) => x.firstBuyersHolding != null) ?? latest;
  // Whether the dev still holds: the newest reading first, since a dev can sell after the alert.
  const devHolding = latest?.devHolding ?? s.devHolding ?? null;
  const devFromLatest = latest?.devHolding != null;
  // Where the creator fee goes, under the Dev tile's tooltip (2026-10-21): TokenSage's sentence,
  // the charity's organization in that same sentence, and OTC Desks' reward coins.
  const fee = card.token.creatorFee;
  const feeLine = creatorFeeLine(fee);
  const charityName = fee?.destination === "charity" ? shownCharityName(fee.charityName) : null;
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
    emptyFromScan: emptyFrom !== null,
    freshFromScan: freshFrom !== null,
    snipers: sniperFrom ? sniperReading(sniperFrom, sniperFrom === s) : null,
    largestPct: pick((x) => x.largestHolderPct != null)?.largestHolderPct ?? null,
    largestAtAlert: pick((x) => x.largestHolderPct != null) === s,
    ...linkedTileReading(linkedFrom),
    linkedAtAlert: linkedFrom === s,
    linkedClusters: linkedFrom?.linkedClusters ?? [],
    linkedCreatorPct: linkedFrom?.linkedCreatorPct ?? null,
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
    firstHoldingOld: oldBuyersFrom?.firstBuyersHolding ?? null,
    firstSeenOld: oldBuyersFrom?.firstBuyersSeen ?? null,
    devHolding,
    devFromLatest,
    feeLine,
    charityName,
  };
}

/**
 * The card's stat tiles from the newest scan, each falling back to the alert's where the newest
 * has none. `fromLatest`: the newest scan is a later row than the alert's.
 */
export function newestStats(card: Pick<Card, "snapshot" | "latestSnapshot">) {
  const s = card.snapshot;
  const l = card.latestSnapshot && card.latestSnapshot.takenAt !== s.takenAt ? card.latestSnapshot : null;
  const lHolders = l ? (l.liveHolderCount ?? l.holderCount ?? null) : null;
  return {
    fromLatest: l !== null,
    score: l?.score ?? s.score ?? null,
    volume5mUsd: l?.volume5mUsd ?? s.volume5mUsd ?? null,
    volume1hUsd: l?.volume1hUsd ?? s.volume1hUsd ?? null,
    volume24hUsd: l?.volume24hUsd ?? s.volume24hUsd ?? null,
    holders: lHolders ?? s.liveHolderCount ?? s.holderCount ?? null,
    holdersLive: lHolders !== null ? l!.liveHolderCount != null : s.liveHolderCount != null,
    top10Pct: l?.top10HolderPct ?? s.top10HolderPct ?? null,
    top10FromLatest: l?.top10HolderPct != null,
  };
}

/** A tooltip's note of the alert's value beside a newer one: " (at the alert: 42%)", or "" when the same. */
export function atAlertNote(atAlert: string | null, shown: string | null): string {
  return atAlert === null || atAlert === shown ? "" : ` (at the alert: ${atAlert})`;
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const fmtCount = (n: number | null | undefined) => (n == null ? null : String(n));

/** How a tile describes a reading from after the alert, before the card knows when it was taken. */
export const LATER_SCAN = "from a scan after the alert";

/** How a tile describes a reading from the card's newest scan: "from a scan 12m ago". */
export function laterScanText(card: Pick<Card, "latestSnapshot">, now: number): string {
  const at = card.latestSnapshot?.takenAt;
  return at && Number.isFinite(Date.parse(at)) ? `from a scan ${ago(at, now)}` : LATER_SCAN;
}

/** Scan tiles this old or older dim and say the scan's age (user decision 2026-10-19). */
export const SCAN_STALE_MS = 5 * 60_000;

/**
 * The age of the newest scan behind a card's scan tiles (score, holders, volume, Top 10, Largest)
 * as the tiles label it ("12m", "3h"), or null while it is under SCAN_STALE_MS old.
 */
export function scanAge(card: Pick<Card, "snapshot" | "latestSnapshot">, now: number): string | null {
  const at = Math.max(
    Date.parse(card.snapshot.takenAt),
    card.latestSnapshot ? Date.parse(card.latestSnapshot.takenAt) : -Infinity,
  );
  if (!Number.isFinite(at) || now - at < SCAN_STALE_MS) return null;
  return minutes((now - at) / 60_000);
}

/** A tile's color classes with the aged class added, when there is one. */
function withAged(
  look: { className?: string; style?: React.CSSProperties },
  aged: string | undefined,
): { className?: string; style?: React.CSSProperties } {
  if (!aged) return look;
  return { ...look, className: look.className ? `${look.className} ${aged}` : aged };
}

/**
 * The coin's age now: its age at the alert snapshot plus the time since that snapshot was taken.
 * The snapshot's own age stays in the tile's tooltip.
 */
export function ageNow(s: Pick<Snapshot, "ageMinutes" | "takenAt">, now: number): number | null {
  if (s.ageMinutes == null) return null;
  const taken = Date.parse(s.takenAt);
  return Number.isFinite(taken) ? s.ageMinutes + Math.max(0, now - taken) / 60_000 : s.ageMinutes;
}

/**
 * The label for a first-buyers count from before the 0.1% cut (scans before 2026-10-16): those
 * counted every first buyer still holding any amount, so it reads higher than today's count and is
 * named as the older count wherever it stands in for it.
 */
export function oldFirstBuyersText(holding: number, seen: number | null): string {
  return `* Older count: ${holding} of the first ${seen ?? 25} buyers still held any amount (scans before 2026-10-16 counted every holder, not only 0.1% of the supply or more)`;
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
  later = LATER_SCAN,
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
  /** How a reading from after the alert is described (see laterScanText). */
  later?: string;
}) {
  const risky =
    value !== null &&
    ((failsAbove !== undefined && value > failsAbove) || (failsAt !== undefined && value >= failsAt));
  const title =
    value === null
      ? `${label}: not checked yet. Wallet checks are limited per scan, and tokens closest to alerting go first.`
      : `${label}: ${walletCountText(value, of)} ${explain} (${pct(value)}), ${atAlert ? "at alert time" : later}. The safety screen rejects ${failsAbove !== undefined ? `over ${failsAbove}%` : `${failsAt ?? 0}% or more`}.`;
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
 * Red and the color scale follow the number on the tile. A top-25 count is not judged by the
 * screen's top-10 sniper cut. A scan that only kept the top-10 share uses that cut on that share.
 */
export function sniperTileMark(reading: SniperReading | null): { risky: boolean; share: number | null } {
  if (!reading || reading.top25) return { risky: false, share: null };
  const share = reading.top10Pct ?? (reading.of > 0 ? (reading.count * 100) / reading.of : null);
  return { risky: share != null && share >= SAFETY_REJECT_SNIPER_WALLET_PCT, share };
}

/** The tile's tooltip. A top-10-only scan keeps the "(top 10 only on this scan)" label. */
export function sniperTileTitle(reading: SniperReading | null, later: string): string {
  if (!reading) return "Snipers: not checked yet. The launch's first buyers are read a few tokens per scan.";
  const which = reading.top25 ? "" : " (top 10 only on this scan)";
  const top10 =
    reading.top10Pct != null ? ` In the top 10: ${walletCountText(reading.top10Pct, reading.top10Of)}.` : "";
  const when = reading.atAlert ? "at alert time" : later;
  const cut = reading.top25
    ? " The safety screen's sniper cut is on the top 10, not this count."
    : ` The safety screen rejects ${SAFETY_REJECT_SNIPER_WALLET_PCT / 10} or more of the top 10.`;
  return `Snipers: ${reading.count} of the ${reading.of} largest holders${which} were among the first 25 buyers after launch, ${when}.${top10}${cut}`;
}

/**
 * The Snipers tile: how many top holders (the top 25, pools aside) were among the launch's first
 * 25 buyers, "N/25". Red only when the number shown is the top-10 share and that share hits the
 * screen's sniper cut (8 or more of 10).
 */
export function SniperTile({
  reading,
  tiles = "off",
  later = LATER_SCAN,
}: {
  reading: SniperReading | null;
  /** How the tile takes its scale up to the cut (the alert card's, with tile colors on). */
  tiles?: TileMode;
  /** How a reading from after the alert is described (see laterScanText). */
  later?: string;
}) {
  const { risky, share } = sniperTileMark(reading);
  return (
    <div
      {...tileLook(tiles, tileTone(share, SAFETY_REJECT_SNIPER_WALLET_PCT), risky)}
      title={sniperTileTitle(reading, later)}
    >
      <dt>Snipers</dt>
      <dd className={reading === null ? "muted" : "num"}>
        {reading === null ? "Not checked" : `${reading.count}/${reading.of}`}
      </dd>
    </div>
  );
}

type LinkedClusterView = NonNullable<Card["snapshot"]["linkedClusters"]>[number];

/** The cluster line the tile's tooltip and the list lead with: "4 wallets from one funder hold 31%". */
export function linkedSummary(
  clusters: readonly LinkedClusterView[],
  /** Supply tied to the creator (linkedCreatorPct); absent or null on scans that didn't keep it. */
  creatorPct?: number | null,
): string | null {
  const top = clusters[0];
  if (!top) return null;
  const more =
    clusters.length > 1 ? `, and ${clusters.length - 1} more cluster${clusters.length > 2 ? "s" : ""}` : "";
  // The share itself where the scan kept it (user ask 2026-10-17), not the cluster as a whole.
  const tied =
    creatorPct != null
      ? creatorPct > 0
        ? `; ${pct(creatorPct)} of supply is tied to the creator`
        : ""
      : top.creatorLinked
        ? " (tied to the creator)"
        : "";
  return creatorPct != null
    ? `${top.wallets.length} wallets from one funder hold ${pct(top.pct)}${more}${tied}`
    : `${top.wallets.length} wallets from one funder hold ${pct(top.pct)}${tied}${more}`;
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
  creatorPct,
  atAlert,
  tiles,
  later = LATER_SCAN,
}: {
  pct: number | null;
  count: { linked: number; of: number } | null;
  /** Whether KOLs' bundles add holders the scan's own count leaves out. */
  kols: boolean;
  /** Whether the reading is Bundled % (KOLs' bundles checked), not only the scan's own linked holders. */
  bundled: boolean;
  clusters: readonly LinkedClusterView[];
  creatorPct: number | null;
  atAlert: boolean;
  tiles: TileMode;
  /** How a reading from after the alert is described (see laterScanText). */
  later?: string;
}) {
  const cut = countCutFor(SAFETY_REJECT_LINKED_COUNT, count?.of);
  const summary = linkedSummary(clusters, creatorPct);
  const title =
    value === null
      ? "Linked: not checked yet. Who paid for each top-25 wallet is read a few tokens per scan."
      : value === 0
        ? `Linked: no two top-25 wallets share a funder or a funding minute${bundled ? ", and no KOL bundles any" : ""}, ${atAlert ? "at alert time" : later}.`
        : `Linked: ${count ? `${count.linked} of the ${count.of} top holders, ` : ""}holding ${pct(value)} of supply${bundled ? ` (Bundled %), counting wallets in a funder's cluster, a funding minute or a KOL's bundle${kols ? " (KOLs' bundles add some)" : ""}` : ", KOLs' bundles not checked on this scan"}${summary ? `. ${summary}` : ""}, ${atAlert ? "at alert time" : later}. The safety screen counts linked holders without KOLs' bundles and rejects ${countCutFor(SAFETY_REJECT_LINKED_COUNT, count?.of)} or more.`;
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

/**
 * The token's image as a small thumbnail, falling back through tokenImageSources (the original
 * URL, a second IPFS gateway), then to its initials.
 * On desktop, hovering it shows a large preview; phones get a bigger avatar instead.
 */
function TokenAvatar({ url, symbol }: { url: string | null; symbol: string | null }) {
  // An index into tokenImageSources; past its end, the initials.
  const [attempt, setAttempt] = useState(0);
  const safe = url?.startsWith("https://") ? url : null;
  const src = tokenImageSources(safe, THUMB_PX)[attempt] ?? null;
  const preview = useImagePreview(safe, src);

  if (!src) return <span className="avatar placeholder">{(symbol ?? "?").slice(0, 2)}</span>;

  return (
    <>
      {/* Launcher-supplied URL: https only, and no referrer sent to whoever hosts it. */}
      <img
        className="avatar"
        src={src}
        alt=""
        width={44}
        height={44}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => {
          preview.close();
          setAttempt((a) => a + 1);
        }}
        {...preview.bind}
      />
      {preview.node}
    </>
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
  const runPeak = curated?.outcome?.peak24hReturnPct ?? null;
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
  // Priced from the curve, to the block: it shows the market after the call at once.
  if (card.currentMarketCapSource === "curve") return mcap;
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

/** "Now" readings this old or older say their age on the card, and dim. */
export const NOW_STALE_MS = 2 * 60_000;

/**
 * How far behind the market a DexScreener reading is when it is fetched (see CALL_READING_LAG_MS:
 * 45-60 s). The lower end, so an age is never overstated.
 */
const DEX_READING_LAG_MS = 45_000;

/**
 * The market time the "Now" reading shows (ms): its fetch time, less DexScreener's own lag unless
 * it was priced from the curve. NaN with no reading.
 */
export function nowReadingMarketAt(
  card: Pick<Card, "currentMarketCapAt" | "currentMarketCapSource">,
): number {
  const at = card.currentMarketCapAt ? Date.parse(card.currentMarketCapAt) : NaN;
  return card.currentMarketCapSource === "curve" ? at : at - DEX_READING_LAG_MS;
}

/**
 * The age of the "Now" reading as the card labels it ("3m", "2h"), or null while it is fresh or
 * there is none. Counted from the market it shows, not when it was fetched. A coin nobody has open,
 * or one past the live refresh's budget, keeps its last reading, and a figure minutes old must not
 * read as the price now.
 */
export function nowReadingAge(
  card: Pick<Card, "currentMarketCapAt" | "currentMarketCapSource">,
  nowMcap: number | null,
  now: number,
): string | null {
  const at = nowReadingMarketAt(card);
  if (nowMcap === null || !Number.isFinite(at) || now - at < NOW_STALE_MS) return null;
  return minutes((now - at) / 60_000);
}

/** The "Now" figure's tooltip: why it is blank in a call's first minute, or how old it is. */
function nowTitle(card: Card, nowMcap: number | null, now: number): string | undefined {
  if (nowMcap === null && card.currentMarketCapUsd !== null) {
    return "Shows from the first reading a minute after the alert: earlier ones lag the market";
  }
  const at = nowReadingMarketAt(card);
  if (nowMcap === null || !Number.isFinite(at)) return undefined;
  const minutes = Math.floor((now - at) / 60_000);
  return minutes >= 2 ? `Read ${minutes} minutes ago` : undefined;
}

/** The larger of two peaks either of which may be missing. */
function maxKnown(a: number | null | undefined, b: number | null | undefined): number | null {
  const known = [a, b].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length === 0 ? null : Math.max(...known);
}
