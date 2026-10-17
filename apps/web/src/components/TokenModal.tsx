import {
  alertWideMap,
  fromAlertText,
  hasHolderList,
  HOLDER_SCAN_MS,
  holderFreshness,
  linkedCountText,
  momentLabel,
  momentSnapshot,
  pickReading,
  withWideMap,
  type AlertWideMap,
  type BubbleMoment,
} from "../bubbleMap";
import { cachedGet } from "../cache";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ApiError, lookupRequired, post, type Card, type Snapshot } from "../api";
import { usePolling } from "../hooks";
import { MIN_WIN_SOL, ago, change, minutes, multiple, pct, shortAddress, tokenLabel, usd } from "../format";
import { TokenImage } from "./TokenImage";
import { FoldHead } from "./Fold";
import { DevCard, FlowCard, SocialsCard, type TokenProfile } from "./TokenProfileCards";
import { cardOutcome, outcomeBadge } from "../outcome";
import { openSage } from "../sage";
import { QUICK_LINK_SITES, pumpFunHref, useAppearance } from "../appearance";
import { useShowNarrativeNote } from "../narrativeNote";
import { scoreTone, scoreToneColor, useScoreWeights } from "../scoreWeights";
import {
  candleCloses,
  linePoints,
  stitch,
  stitchVolume,
  withCallPoint,
  pointWidthMs,
  type CloseRun,
  type MarkerKind,
  type ScanFlow,
  type VolumeCandle,
} from "../priceChart";
import {
  cardReadings,
  oldFirstBuyersText,
  cexCountText,
  countCutFor,
  linkedReading,
  nowReading,
  recordedPeakOf,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  SniperTile,
  WalletStat,
} from "./AlertCard";
import { PriceChart, type ChartEvent, type ChartTrade } from "./PriceChart";
import { TradePanel, solText, tokensText } from "./TradePanel";
import { summarizePosition, usePosition, useProWallet } from "../proTrade";
import { LIVE_POLL_MS, useFineCandles, useLiveTail, type LiveTail } from "./chartFeeds";
import {
  categoryText,
  count,
  CrowdChart,
  INPUTS,
  LINEAGE,
  LineageText,
  pct0,
  RELATION,
  TREND_SOURCE,
  words,
  type SageRead,
  type SageView,
} from "./SageView";
import { Skeleton } from "./Charts";
import { LoadingNote, LoadSteps, SkelValue, Spinner, useElapsed } from "./Loading";
import { openWallet } from "../walletModal";
import { BubbleMapPlaceholder, BubbleMapSection, reloadBubbleMaps, useBubbleMaps } from "./BubbleMap";
import { TopHolders } from "./TopHolders";
import type { HolderEntry } from "../holderEntry";
import { WalletText } from "./WalletText";
import { FilterGlyph } from "./FilterBadge";
import { filterCardStyle } from "../filterStyle";
import { useWalletNames, walletText } from "../walletNames";
import {
  BrainIcon,
  ChartIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  ClockIcon,
  LockIcon,
  RobotIcon,
  SageIcon,
  ShieldIcon,
} from "./Icons";
import { safetyChecks, safetyVerdict, type SafetyVerdict } from "../safetyScreen";

/** Mirrors apps/api/src/routes/tokens.ts TokenChart. */
interface TokenChart {
  mint: string;
  /** Pump.fun's minute candles as market cap (apps/api/src/tokenChart.ts McapCandle). */
  candles: { t: number; o: number; h: number; l: number; c: number; vol?: number }[] | null;
  /** buys/sells: the 5-minute counts before the scan; absent from older API builds. */
  marketCap: { t: number; usd: number; buys?: number | null; sells?: number | null }[];
  /** Absent from an API older than this page. */
  tape?: { status: string; anchorAt: number; windowEnd: number; readAt: number } | null;
  /** When the coin's trades were last read live, before a call; null when never. */
  live?: { readAt: number } | null;
  wallets?: FlaggedWallet[];
  /** How each top holder got in, by wallet (HolderEntry). Absent from older API builds. */
  holderEntries?: Record<string, HolderEntry>;
}

/** Mirrors apps/api/src/routes/tokens.ts TokenFirstMinutes. */
interface TokenFirstMinutes {
  startAt: number | null;
  stepSec: 1 | 15;
  live: boolean;
  candles: { t: number; o: number; h: number; l: number; c: number; vol?: number }[] | null;
}

/** Mirrors apps/api/src/tokenChart.ts MarkedWallet. */
interface FlaggedWallet {
  wallet: string;
  tags: ("risky" | "dumper" | "linked" | "creator" | "kol" | "winner")[];
  score: number | null;
  dumps: number | null;
  coins: number | null;
  funder: string | null;
  /** A known KOL's name ("" when unnamed). Absent from older API builds. */
  kol?: string | null;
  /** A KOL's Known Side: the KOL's main wallet (`kol` is then the KOL's name). */
  knownSideOf?: string;
  solIn: number;
  solOut: number;
  heldPct: number | null;
  trades: [number, 1 | -1, number | null][];
}

/** The swatch colour a flagged wallet gets: the creator first, then a risky one, a KOL, a winner, else linked. */
function kindOf(w: FlaggedWallet): MarkerKind {
  if (w.tags.includes("creator")) return "dev";
  if (w.tags.includes("risky") || w.tags.includes("dumper")) return "risky";
  if (w.tags.includes("kol")) return "kol";
  if (w.tags.includes("winner")) return "winner";
  return "linked";
}

type Range = "model" | "first" | "alert" | "1h" | "all";
const RANGES: { id: Range; label: string; title?: string }[] = [
  {
    id: "model",
    label: "Model View",
    title: "Up to 5 minutes either side of the call: what the model had to go on, and what came next",
  },
  {
    id: "first",
    label: "First 15m",
    title:
      "The coin's first 15 minutes from launch: second by second while it is in them, then in 15-second steps",
  },
  { id: "alert", label: "From alert" },
  { id: "1h", label: "1h" },
  { id: "all", label: "All" },
];
/** "First 15m" is offered while Pump.fun's 15-second candles still reach back to the launch. */
const FIRST_VIEW_MAX_AGE_MS = 6 * 3_600_000;
/** The first-minutes view re-reads this often while the coin is inside them, else rarely. */
const FIRST_LIVE_POLL_MS = 5_000;
const FIRST_POLL_MS = 120_000;
/** How much of the run-up the "From alert" view shows before the alert. */
const LEAD_IN_MS = 10 * 60_000;
/** How far either side of the call "Model View" reaches (never before the first trade). */
const MODEL_SPAN_MS = 5 * 60_000;
/** Points drawn at most: enough for a smooth line, few enough that each one stays hoverable. */
const MAX_POINTS = 240;
/** Views this short read Pump.fun's 1-second candles, and up to QUARTER_VIEW_MAX_MS its 15-second ones. */
const SECOND_VIEW_MAX_MS = 20 * 60_000;
const QUARTER_VIEW_MAX_MS = 6 * 3_600_000;
/** The fine candles are re-read this often: 1-second ones on a view running to now, others rarely. */
const FINE_LIVE_POLL_MS = 5_000;
const FINE_POLL_MS = 60_000;
/** The live tail counts as live while its price was confirmed this recently. */
const LIVE_STALE_MS = 10_000;
/** The First 15m view's span. */
const FIRST_MINUTES_MS = 15 * 60_000;
const CHART_POLL_MS = 30_000;
/** While a lookup's scan is still landing, its chart (and the flagged wallets on it) is re-read faster. */
const SCANNING_POLL_MS = 8_000;

const LINKS = [
  { label: "DexScreener", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump.fun", href: pumpFunHref },
  { label: "Solscan", href: (m: string) => `https://solscan.io/token/${m}` },
];

/**
 * The Utilities tab's token lookup opens this same modal for any mint (UtilitiesTab.tsx): its data
 * comes from the lookup's own routes, and there is no call to explain.
 */
export interface UtilityMode {
  /** Where the chart and the TokenSage read come from: "/utilities/token" instead of "/tokens". */
  apiBase: string;
  /** Whether the lookup's fresh scan has landed yet. */
  scan: "scanning" | "scanned";
  /** When the lookup was paid for (its scan started then); absent from older API builds. */
  since?: number;
}

const UtilityContext = createContext<UtilityMode | null>(null);

/** The modal's data routes for a mint: the feed's, or a utility lookup's. */
function useTokenApi(mint: string): string {
  const utility = useContext(UtilityContext);
  return `${utility?.apiBase ?? "/tokens"}/${encodeURIComponent(mint)}`;
}

/**
 * Everything about one token on a feed card, in a native modal dialog (a centred panel on desktop,
 * a sheet from the bottom on phones): its market-cap chart since launch with the alert marked, the
 * card's numbers, why it was called, and TokenSage's read. Opened by clicking a card.
 *
 * The card's own data comes in as a prop and stays live (the card re-renders it); the chart
 * (GET /tokens/:mint/chart) and the TokenSage read (GET /tokens/:mint/sage) are fetched here and
 * need access, so a guest sees the card's numbers with the rest locked.
 */
export function TokenModal({
  card,
  now,
  onClose,
  utility = null,
  opening,
}: {
  /** Null while the view is still being fetched: `opening` then says for which coin. */
  card: Card | null;
  now: number;
  onClose: () => void;
  utility?: UtilityMode | null;
  opening?: OpeningView;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal tm-modal"
      aria-labelledby="tm-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      // Rendered through a portal, so React would bubble the click on to whatever rendered it (a
      // Utilities panel, or the app around a feed card's modal); it stops here.
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <UtilityContext.Provider value={utility}>
        {card ? (
          <TokenBody card={card} now={now} onClose={() => ref.current?.close()} />
        ) : (
          opening && <OpeningBody {...opening} onClose={() => ref.current?.close()} />
        )}
      </UtilityContext.Provider>
    </dialog>
  );
}

/** A coin's view before its data has landed: what is known of it, and whether the fetch failed. */
export interface OpeningView {
  mint: string;
  /** What the lookup list already knows of the coin, for the header. */
  token?: { symbol: string | null; name: string | null; imageUrl: string | null } | null;
  error?: Error | null;
  onRetry?: () => void;
}

/**
 * The modal while its view is still on the way (user ask 2026-10-16): the same frame, header and
 * links as the coin's own, each section's place held at about its final size, so the coin's data
 * fills in where the reader is already looking. Said plainly, with a retry, when the fetch fails.
 */
function OpeningBody({ mint, token, error, onRetry, onClose }: OpeningView & { onClose: () => void }) {
  const { hideSafetyPill } = useAppearance();
  const label = token ? tokenLabel({ mintAddress: mint, symbol: token.symbol, name: token.name }) : null;
  const title = label ?? shortAddress(mint);
  const failed = !!error;
  return (
    <div className="about-body tm-body tm-opening" aria-busy={!failed}>
      <header className="tm-head">
        <div className="tm-token">
          <div className="avatar-wrap tone-neutral">
            <TokenImage
              url={token?.imageUrl ?? null}
              size={160}
              className="avatar tm-avatar"
              width={56}
              height={56}
              eager
              fallback={
                label ? (
                  <span className="avatar placeholder tm-avatar">{label.replace("$", "").slice(0, 2)}</span>
                ) : (
                  <span className="skeleton round tm-avatar" />
                )
              }
            />
          </div>
          <div className="tm-title-block">
            <div className="tm-title-row">
              <h2 id="tm-title" className="tm-title" tabIndex={-1} autoFocus>
                {title}
                {token?.name && token.symbol && <span className="token-name"> {token.name}</span>}
              </h2>
              <MintChip mint={mint} />
            </div>
            <div className="tm-sub">
              {failed ? (
                <span className="when">Not opened</span>
              ) : (
                <span className="when tm-scanning">
                  <Spinner size={10} /> Opening the scan…
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="tm-actions">
          {!failed && !hideSafetyPill && <SafetyPill verdict={PENDING_SAFETY} />}
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        <QuickLinks mint={mint} />
        <nav className="tm-nav" aria-label="Sections">
          {SECTIONS.map((x) => (
            <button key={x.id} type="button" className="tm-nav-btn" disabled>
              {x.id === "call" ? "Market" : x.label}
            </button>
          ))}
        </nav>
      </header>
      {failed ? (
        <section className="sage-card tm-open-failed" role="alert">
          <h4>Couldn&apos;t open this coin</h4>
          <p className="small muted">{error.message}</p>
          <div className="tm-open-actions">
            {onRetry && (
              <button type="button" className="primary" onClick={onRetry}>
                Try again
              </button>
            )}
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="tm-figs" aria-label="Market cap">
            {["At scan", "Now", "Peak", "Age"].map((l) => (
              <div key={l} className="tm-fig">
                <label>{l}</label>
                <span className="num">
                  <SkelValue width="4.4em" />
                </span>
              </div>
            ))}
          </section>
          <section className="tm-group" aria-label="Chart">
            <section className="sage-card tm-chart">
              <h4>
                <ChartIcon size={14} /> Market cap
                <span className="tm-ranges" aria-hidden="true">
                  {["From scan", "1h", "All"].map((r) => (
                    <button key={r} type="button" className={`tm-range${r === "All" ? " on" : ""}`} disabled>
                      {r}
                    </button>
                  ))}
                </span>
              </h4>
              <ChartSkeleton>Loading the chart…</ChartSkeleton>
            </section>
          </section>
          <section className="tm-group">
            <GroupLabel id="tm-opening-holders">Holders</GroupLabel>
            <HoldersPlaceholder>Loading the top holders…</HoldersPlaceholder>
          </section>
        </>
      )}
    </div>
  );
}

/** The copyable mint, beside the coin's name: what a reader reaches for before anything else. */
function MintChip({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button type="button" className="mint tm-mint" onClick={copy} title="Copy mint address">
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied ? "Copied" : shortAddress(mint)}
    </button>
  );
}

/** The coin on the trading sites (Settings › Quick links) and the explorers, as pills under Sage. */
function QuickLinks({ mint, socials }: { mint: string; socials?: TokenProfile["socials"] | null }) {
  const { quickLinks } = useAppearance();
  // The coin's own X, Telegram and website (user ask 2026-10-16), launcher-supplied, https only.
  const own = socials
    ? [
        { label: "X", href: socials.x },
        { label: "Telegram", href: socials.telegram },
        { label: "Website", href: socials.website },
      ].filter((l): l is { label: string; href: string } => !!l.href)
    : [];
  const trade = QUICK_LINK_SITES.filter((l) => quickLinks.includes(l.id));
  return (
    <nav className="tm-quick" aria-label="Open this coin elsewhere">
      {trade.map((l) => (
        <a key={l.id} className="trade" href={l.href(mint)} target="_blank" rel="noreferrer">
          {l.label}
          <ExternalIcon size={11} />
        </a>
      ))}
      {LINKS.map((l) => (
        <a key={l.label} href={l.href(mint)} target="_blank" rel="noreferrer">
          {l.label}
          <ExternalIcon size={11} />
        </a>
      ))}
      {own.map((l) => (
        <a key={l.label} className="social" href={l.href} target="_blank" rel="noopener noreferrer nofollow">
          {l.label}
          <ExternalIcon size={11} />
        </a>
      ))}
    </nav>
  );
}

const PENDING_SAFETY: SafetyVerdict = { state: "pending", reading: null, reasons: [], passedAtAlert: false };
const SAFETY_WORD = { passed: "Passed", failed: "Failed", pending: "Pending" } as const;

/** The safety screen's verdict, left of Sage: a link down to the Safety section. */
function SafetyPill({ verdict, onClick }: { verdict: SafetyVerdict; onClick?: () => void }) {
  const { state } = verdict;
  const title =
    state === "passed"
      ? "Passed the safety screen. See the Safety section."
      : state === "failed"
        ? `Failed the safety screen${verdict.passedAtAlert ? " on a scan after the alert" : ""}. See the Safety section.`
        : "The safety screen's verdict lands with the coin's scan.";
  return (
    <button
      type="button"
      className={`tm-safety-pill ${state}`}
      onClick={onClick}
      disabled={!onClick}
      title={title}
      aria-label={`Safety screen: ${SAFETY_WORD[state].toLowerCase()}`}
    >
      {state === "pending" ? <Spinner size={11} /> : <ShieldIcon size={13} />}
      <span className="tm-safety-word">Safety </span>
      {SAFETY_WORD[state]}
    </button>
  );
}

/** The chart's place while it loads, the height the chart will take. */
function ChartSkeleton({ children }: { children: ReactNode }) {
  return (
    <div className="tm-chart-skeleton" style={{ height: chartBoxHeight() }}>
      <LoadingNote className="tm-skel-note" slow="Still loading the chart…">
        {children}
      </LoadingNote>
    </div>
  );
}

/** The chart's plot height for this window, and the whole box it draws (axis and volume lane included). */
function chartHeight(expanded = false): number {
  const phone = window.innerWidth <= 640;
  // Pro Mode's bigger chart, while trading or holding the coin: room for the trade marks.
  if (expanded) return phone ? 260 : 380;
  return phone ? 180 : 220;
}
function chartBoxHeight(): number {
  return chartHeight() + CHART_CHROME_PX;
}
/** What PriceChart draws around its plot: the time axis and the volume lane. */
const CHART_CHROME_PX = 40;

/** The Holders section's place while its reading is taken: the bubble map's frame, and the list's. */
function HoldersPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="tm-holders">
      <BubbleMapPlaceholder>{children}</BubbleMapPlaceholder>
    </div>
  );
}

function TokenBody({ card, now, onClose }: { card: Card; now: number; onClose: () => void }) {
  const { hideSafetyPill } = useAppearance();
  const mint = card.token.mintAddress;
  const s = card.snapshot;
  const curated = card.curated;
  const outcome = cardOutcome(card, now);
  const badge = outcomeBadge(outcome);
  const showVerdict = outcome !== null && !(outcome.status === "watching" && !outcome.hit2x);
  // The moment the card shows: a filter alert a call folded into keeps the filter alert's time, as
  // its price and verdict are that alert's; its calls are drawn on the chart at their own times.
  const alertAt = Date.parse(
    card.kind === "curated" ? (curated?.alertedAt ?? card.matchedAt) : card.matchedAt,
  );
  const alertMcap = s.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  const { pct: recordedPeak } = recordedPeakOf(card);
  const peak = move !== null && move > 0 ? Math.max(recordedPeak ?? 0, move) : recordedPeak;
  const hasPeak = peak !== null && peak > 0;
  const label = tokenLabel(card.token);
  const utility = useContext(UtilityContext);
  const what = utility
    ? "Scanned"
    : card.kind === "stream"
      ? "Passed screen"
      : card.kind === "curated"
        ? "Called"
        : "Alert";
  // One poll for the chart and the wallet sections that read the same answer.
  /** The lookup's fresh scan (holders, safety checks) is still on its way. */
  const scanning = utility?.scan === "scanning";
  const chart = usePolling<TokenChart>(
    `${useTokenApi(mint)}/chart`,
    scanning ? SCANNING_POLL_MS : CHART_POLL_MS,
  );
  // Kept as the same list while a poll brings the same wallets, so the map isn't rebuilt for nothing.
  const flaggedKey = JSON.stringify(chart.data?.wallets ?? []);
  const flagged = useMemo(() => JSON.parse(flaggedKey) as FlaggedWallet[], [flaggedKey]);
  const flags = chart.data ? "ok" : chart.error ? "failed" : "loading";
  const entriesKey = JSON.stringify(chart.data?.holderEntries ?? {});
  const entries = useMemo(() => JSON.parse(entriesKey) as Record<string, HolderEntry>, [entriesKey]);
  const linked = useHolderReading(card, mint, !!utility);
  const holders = useHoldersView(card, linked, alertAt, !!utility);
  useFilterCatchKept(card, !!utility);
  const ids = useId().replace(/:/g, "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(bodyRef, ids);
  const headH = useHeadHeight(bodyRef);
  const goTo = (id: SectionId) =>
    document.getElementById(`${ids}-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const safety = safetyVerdict(card, scanning);
  // A pass starts folded, a fail or a pending verdict open; the reader's own choice then holds.
  const [safetyOpenSet, setSafetyOpen] = useState<boolean | null>(null);
  const safetyOpen = safetyOpenSet ?? safety.state !== "passed";
  const openSafety = () => {
    setSafetyOpen(true);
    goTo("safety");
  };
  // A lookup asks TokenSage for a fresh read, which lands within minutes: check more often.
  const sage = usePolling<SageView>(`${useTokenApi(mint)}/sage`, utility ? 20_000 : 120_000);
  // The Dev, Socials and Order flow cards' read (user ask 2026-10-16); the flow moves with each scan.
  const profile = usePolling<TokenProfile>(
    `${useTokenApi(mint)}/profile`,
    scanning ? SCANNING_POLL_MS : CHART_POLL_MS,
  );
  // The moment the scan lands, re-read what it feeds (the flagged wallets, the read) rather than
  // waiting for their next poll.
  const wasScanning = useRef(scanning);
  const { reload: reloadChart } = chart;
  const { reload: reloadSage } = sage;
  useEffect(() => {
    if (wasScanning.current && !scanning) {
      reloadChart();
      reloadSage();
    }
    wasScanning.current = scanning;
  }, [scanning, reloadChart, reloadSage]);

  return (
    <div
      className="about-body tm-body"
      ref={bodyRef}
      style={headH ? ({ "--tm-head-h": `${headH}px` } as React.CSSProperties) : undefined}
    >
      <header className="tm-head">
        <div className="tm-token">
          <div className={`avatar-wrap tone-${badge.tone}`}>
            <TokenImage
              url={card.token.imageUrl}
              size={160}
              className="avatar tm-avatar"
              width={56}
              height={56}
              eager
              fallback={
                <span className="avatar placeholder tm-avatar">{label.replace("$", "").slice(0, 2)}</span>
              }
            />
          </div>
          <div className="tm-title-block">
            <div className="tm-title-row">
              <h2 id="tm-title" className="tm-title" tabIndex={-1} autoFocus>
                {label}
                {card.token.name && card.token.symbol && (
                  <span className="token-name"> {card.token.name}</span>
                )}
              </h2>
              <MintChip mint={mint} />
            </div>
            <div className="tm-sub">
              {showVerdict && badge.tone !== "neutral" && (
                <span className={`badge ${badge.tone}`}>{badge.text}</span>
              )}
              <span className="when">
                {utility?.scan === "scanning" ? (
                  <span className="tm-scanning">Scanning now…</span>
                ) : (
                  `${what} ${ago(new Date(alertAt), now)}`
                )}
              </span>
              {card.kind === "match" && card.filter && (
                <span
                  className={`pill ${card.filter.color ? "pill-filter" : "pill-mine"}`}
                  style={filterCardStyle(card.filter.color) as React.CSSProperties}
                >
                  {card.filter.icon && <FilterGlyph icon={card.filter.icon} />}
                  {card.filter.name}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="tm-actions">
          {!hideSafetyPill && <SafetyPill verdict={safety} onClick={openSafety} />}
          <button
            type="button"
            className="sage-btn"
            onClick={() => openSage(mint)}
            title="Open TokenSage's full read of this coin"
          >
            <SageIcon size={13} />
            Sage
          </button>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        <QuickLinks mint={mint} socials={profile.data?.socials} />
        <nav className="tm-nav" aria-label="Sections">
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`tm-nav-btn${active === x.id ? " on" : ""}`}
              aria-current={active === x.id ? "true" : undefined}
              onClick={() => (x.id === "safety" ? openSafety() : goTo(x.id))}
            >
              {utility && x.id === "call" ? "Market" : x.label}
            </button>
          ))}
        </nav>
      </header>

      {utility && (
        <ScanProgress
          since={utility.since}
          steps={[
            { label: "Market data", done: true },
            { label: "Chart", done: !!chart.data || !!chart.error },
            { label: "Holders and safety checks", done: !scanning },
            {
              label: "TokenSage read",
              done:
                !!sage.data?.read ||
                (!!sage.error && !sage.data) ||
                sage.data?.status === "failed" ||
                sage.data?.status === "expired",
            },
          ]}
        />
      )}

      <section className="tm-figs" aria-label="Market cap">
        <div className="tm-fig">
          <label>{utility ? "At scan" : what === "Passed screen" ? "At screen" : "At alert"}</label>
          <span className="num">{usd(alertMcap)}</span>
        </div>
        <div className="tm-fig">
          <label>Now</label>
          <span className="num">{usd(nowMcap)}</span>
          {move !== null && (
            <small className={`num delta ${move >= 0 ? "up" : "down"}`}>
              {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
            </small>
          )}
        </div>
        <div className={`tm-fig${hasPeak && peak >= 100 ? " hot" : ""}`}>
          <label>Peak</label>
          <span className={hasPeak ? "num" : "num none"}>{hasPeak ? multiple(peak) : "–"}</span>
          {hasPeak && alertMcap > 0 && (
            <small className="num muted">ATH {usd(alertMcap * (1 + peak / 100))}</small>
          )}
        </div>
        <div className="tm-fig">
          <label>{utility ? "Age" : "Age at alert"}</label>
          <span className="num">
            {s.ageMinutes == null && scanning ? <SkelValue width="2.6em" /> : minutes(s.ageMinutes)}
          </span>
          {s.liquidityUsd != null && <small className="num muted">Liq {usd(s.liquidityUsd)}</small>}
        </div>
      </section>

      <section id={`${ids}-chart`} className="tm-group" aria-label="Chart">
        <ChartCard card={card} chart={chart} alertAt={alertAt} alertMcap={alertMcap} what={what} />
        {profile.data?.flow && <FlowCard flow={profile.data.flow} now={now} />}
      </section>

      <section id={`${ids}-holders`} className="tm-group" aria-labelledby={`${ids}-holders-h`}>
        <GroupLabel id={`${ids}-holders-h`}>Holders</GroupLabel>
        {(holders.canSwitch || (holders.reading && hasHolderList(holders.reading))) && (
          <div className={`tm-holders-bar${holders.isKept ? " at-alert" : ""}`}>
            {holders.canSwitch && (
              <div className="segmented small tm-holders-switch" role="radiogroup" aria-label="Holders at">
                {[...holders.options, { view: "now" as const, label: "Now", at: Infinity }].map((o) => (
                  <button
                    key={o.view}
                    type="button"
                    role="radio"
                    aria-checked={holders.view === o.view}
                    className={holders.view === o.view ? "on" : ""}
                    onClick={() => holders.setView(o.view)}
                  >
                    {o.view !== "now" && <ClockIcon size={12} />}
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {holders.kept ? (
              <MomentHoldersWhen moment={holders.kept} />
            ) : holders.atAlert ? (
              <AlertHoldersWhen
                alertAt={alertAt}
                word={holders.word}
                frozen={holders.frozen}
                reading={holders.reading}
              />
            ) : (
              linked &&
              hasHolderList(linked) && (
                <HolderFreshness
                  takenAt={linked.takenAt}
                  now={now}
                  moment={utility || holders.canSwitch ? undefined : holdersMoment(card, linked)}
                />
              )
            )}
          </div>
        )}
        <div className={`tm-holders${holders.isKept ? " at-alert" : ""}`}>
          <BubbleMapSection
            // A fresh map for each view: its picks, open lists and toggles belong to one reading.
            key={holders.view}
            token={card.token}
            snapshot={holders.reading}
            moment={holders.moment}
            {...holders.wide}
            pending={scanning}
            flagged={flagged}
            flags={flags}
          />
          <TopHolders snapshot={holders.listReading} flagged={flagged} entries={entries} pending={scanning} />
        </div>
        {flagged.length > 0 && <WalletsCard wallets={flagged} />}
        <StonkFeesCard mint={mint} />
      </section>

      <section id={`${ids}-call`} className="tm-group" aria-labelledby={`${ids}-call-h`}>
        <GroupLabel id={`${ids}-call-h`}>{utility ? "Market" : "The call"}</GroupLabel>
        {utility ? (
          // A lookup has no call to explain: the numbers take the full width.
          <StatsCard card={card} />
        ) : (
          <div className="tm-grid">
            <StatsCard card={card} />
            <CallCard card={card} />
          </div>
        )}
      </section>

      <section id={`${ids}-dev`} className="tm-group" aria-labelledby={`${ids}-dev-h`}>
        <GroupLabel id={`${ids}-dev-h`}>Dev and socials</GroupLabel>
        <div className="tm-grid tm-dev-grid">
          <DevCard dev={profile.data ? profile.data.dev : undefined} />
          <SocialsCard socials={profile.data?.socials} x={sage.data?.read?.x} />
        </div>
      </section>

      <section id={`${ids}-safety`} className="tm-group" aria-labelledby={`${ids}-safety-h`}>
        <GroupLabel id={`${ids}-safety-h`}>Safety</GroupLabel>
        <SafetyCard
          verdict={safety}
          scanning={scanning}
          now={now}
          open={safetyOpen}
          onToggle={() => setSafetyOpen(!safetyOpen)}
        />
      </section>

      <section id={`${ids}-sage`} className="tm-group" aria-labelledby={`${ids}-sage-h`}>
        <GroupLabel id={`${ids}-sage-h`}>TokenSage</GroupLabel>
        <SageSection mint={mint} sage={sage} />
      </section>
    </div>
  );
}

/**
 * A lookup's scan, part by part (user ask 2026-10-16): which of the coin's reads have landed, so a
 * blank or placeholder section reads as "on its way", not "missing". Shown only when the view
 * opened mid-scan, and kept (all ticked) once it finishes, so nothing below moves when it does.
 */
function ScanProgress({ steps, since }: { steps: { label: string; done: boolean }[]; since?: number }) {
  const busy = steps.some((s) => !s.done);
  const [shown] = useState(busy);
  // Counted from when the lookup started, so a lookup re-opened mid-scan says how long it has run.
  const secs = useElapsed(busy, since);
  // TokenSage's read is the slow part: once it is all that is left, say so rather than blame holders.
  const onlySage = steps.filter((s) => !s.done).every((s) => s.label === "TokenSage read");
  if (!shown) return null;
  return (
    <section className={`tm-scan${busy ? "" : " done"}`} aria-label="Scan progress" aria-live="polite">
      <p className="tm-scan-head small">
        {busy ? <Spinner size={11} /> : <CheckIcon size={13} />}
        <strong>{busy ? "Scanning this coin" : "Scan complete"}</strong>
        <span className="faint tm-scan-sub">
          {busy
            ? secs < 45
              ? "Each section fills in as its part lands, usually within a minute."
              : onlySage
                ? `Waiting on TokenSage's read (${secs}s): a deep read can take a few minutes.`
                : `Still going (${secs}s): a busy coin's holders take longer.`
            : "Every section is up to date."}
        </span>
      </p>
      <LoadSteps steps={steps} />
    </section>
  );
}

/** The modal's sections, in the order they appear, for the nav under the header. */
const SECTIONS = [
  { id: "chart", label: "Chart" },
  { id: "holders", label: "Holders" },
  { id: "call", label: "The call" },
  { id: "dev", label: "Dev" },
  { id: "safety", label: "Safety" },
  { id: "sage", label: "TokenSage" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * The section the reader is in: the last one whose top has passed under the sticky header, as the
 * modal scrolls (the dialog itself is the scroller).
 */
function useActiveSection(bodyRef: RefObject<HTMLDivElement | null>, ids: string): SectionId {
  const [active, setActive] = useState<SectionId>("chart");
  useEffect(() => {
    const scroller = bodyRef.current?.closest("dialog");
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const head = bodyRef.current?.querySelector(".tm-head")?.getBoundingClientRect().bottom ?? 0;
        let current: SectionId = "chart";
        for (const x of SECTIONS) {
          const el = document.getElementById(`${ids}-${x.id}`);
          if (el && el.getBoundingClientRect().top <= head + 24) current = x.id;
        }
        // Scrolled to the end: the last section, even when it is too short to reach the header.
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = "sage";
        setActive(current);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [bodyRef, ids]);
  return active;
}

/**
 * The sticky header's height, followed as it wraps, so a section the nav or the safety pill jumps
 * to lands just under it (the sections' scroll margin reads it).
 */
function useHeadHeight(bodyRef: RefObject<HTMLDivElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const head = bodyRef.current?.querySelector(".tm-head");
    if (!head || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(Math.round(head.getBoundingClientRect().height)));
    ro.observe(head);
    return () => ro.disconnect();
  }, [bodyRef]);
  return h;
}

/**
 * The safety screen on this coin (user ask 2026-10-16): its verdict on the newest scan, why it
 * failed, and each of its rules against what the scan read.
 */
/**
 * The safety screen's verdict and each check. A pass folds to its heading (user ask 2026-10-16):
 * the badge says it all until someone asks, by opening it here or clicking the header's pill.
 */
function SafetyCard({
  verdict,
  scanning,
  now,
  open,
  onToggle,
}: {
  verdict: SafetyVerdict;
  scanning: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { state, reading } = verdict;
  const bodyId = useId();
  return (
    <section className={`sage-card tm-safety ${state}${open ? "" : " folded"}`}>
      <FoldHead open={open} onToggle={onToggle} controls={bodyId}>
        <ShieldIcon size={14} /> Safety screen
        <span className={`badge ${state === "passed" ? "good" : state === "failed" ? "bad" : ""}`}>
          {SAFETY_WORD[state]}
        </span>
        {reading && (
          <span className="tm-h4-meta small muted">Scan {ago(new Date(reading.takenAt), now)}</span>
        )}
      </FoldHead>
      {open && (
        <div id={bodyId}>
          <p className="small muted tm-safety-lead">
            {state === "passed"
              ? "Its newest scan clears every rule of the safety screen. The screen runs on every scan, and a coin that fails it is never alerted."
              : state === "failed"
                ? `Its newest scan fails the safety screen, so nothing alerts on it while it does.${
                    verdict.passedAtAlert ? " It passed when it was alerted; a later scan failed it." : ""
                  }`
                : scanning
                  ? "The screen runs with this coin's scan. Its verdict lands here as soon as the scan does."
                  : "No scan has screened this coin yet."}
          </p>
          {verdict.reasons.length > 0 && (
            <ul className="tm-safety-reasons">
              {verdict.reasons.map((r) => (
                <li key={r}>
                  <CloseIcon size={12} />
                  {r}
                </li>
              ))}
            </ul>
          )}
          {reading ? (
            <ul className="tm-safety-checks">
              {safetyChecks(reading).map((c) => (
                <li key={c.label} className={c.status} title={c.rule}>
                  <span
                    className="tm-safety-mark"
                    aria-label={c.status === "ok" ? "Clears" : c.status === "fail" ? "Fails" : "Not read"}
                  >
                    {c.status === "ok" ? (
                      <CheckIcon size={12} />
                    ) : c.status === "fail" ? (
                      <CloseIcon size={12} />
                    ) : (
                      "–"
                    )}
                  </span>
                  <span className="tm-safety-label">
                    {c.label}
                    <small className="faint">{c.rule}</small>
                  </span>
                  <span
                    className={`tm-safety-value${c.status === "unknown" ? " muted" : /\d/.test(c.value) ? " num" : ""}`}
                  >
                    {c.value}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            scanning && (
              <ul className="tm-safety-checks" aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i} className="unknown">
                    <span className="tm-safety-mark">–</span>
                    <span className="tm-safety-label">
                      <SkelValue width="7em" />
                    </span>
                    <span className="tm-safety-value">
                      <SkelValue width="3em" />
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The reading the bubble map and the top holders draw: the card's newest that kept a holder list,
 * else the newest of the coin's scans that did (fetched; a lookup's card is already its latest
 * scan). Undefined while that loads, null when no scan has a list.
 */
function useHolderReading(card: Card, mint: string, lookup: boolean): Snapshot | null | undefined {
  const seed = linkedReading(card);
  // Newest first, so the section follows the coin's scans and its "Last updated" means it.
  const own = [card.latestSnapshot, seed, card.snapshot].find((s) => s && hasHolderList(s)) ?? null;
  const [fetched, setFetched] = useState<{ mint: string; snapshot: Snapshot | null } | null>(null);
  const fetch = !own && !lookup;
  useEffect(() => {
    if (!fetch) return;
    let live = true;
    const read = () =>
      cachedGet<{ snapshots?: Snapshot[] }>(`/tokens/${encodeURIComponent(mint)}`, HOLDER_SCAN_MS)
        .then((d) => {
          if (!live) return;
          const snapshot = pickReading(d.snapshots ?? []) ?? null;
          // A newer reading replaces the one shown; a failed or empty re-read keeps it.
          setFetched((f) =>
            f?.mint === mint && f.snapshot && !snapshot ? f : { mint, snapshot: snapshot ?? seed },
          );
        })
        .catch(() => live && setFetched((f) => (f?.mint === mint ? f : { mint, snapshot: seed })));
    void read();
    // The worker saves a reading each scan: follow it while the view is open.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, HOLDER_SCAN_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [fetch, mint]);
  if (own) return own;
  if (!fetch) return seed;
  return fetched?.mint === mint ? fetched.snapshot : undefined;
}

/**
 * Which moment the Holders reading is from. The call's numbers are the alert's; this section reads
 * the newest scan with a holder list, which can disagree with them (another moment, and often
 * another holder set), so each says which it is.
 */
function holdersMoment(card: Card, reading: Snapshot | null | undefined) {
  if (!reading) return undefined;
  return reading.takenAt === card.snapshot.takenAt
    ? {
        label: "At the alert",
        title:
          "The alert's reading, the same one The call shows. Counts are over the top holders it read (the /25 or /10).",
      }
    : {
        label: "Now",
        title:
          "The latest scan's reading, not the alert's: The call below shows the holders at the alert. Counts are over the top holders this scan read (the /25 or /10), which can be a different set.",
      };
}

/** Filter alerts this page already told the API were opened. */
const openedFilterAlerts = new Set<string>();

/**
 * Opening one of your filter's alerts keeps the coin's bubble map at that filter's first catch of
 * it (POST /tokens/:mint/bubble-moments/filter, user ask 2026-10-16), once: shown to you, or to
 * everyone for a public filter. Then the kept maps are read again so it is offered at once.
 */
function useFilterCatchKept(card: Card, utility: boolean) {
  const mint = card.token.mintAddress;
  const isFilterAlert = !utility && card.kind === "match" && !!card.filter;
  useEffect(() => {
    if (!isFilterAlert || openedFilterAlerts.has(card.id)) return;
    openedFilterAlerts.add(card.id);
    post<{ result: string }>(`/tokens/${encodeURIComponent(mint)}/bubble-moments/filter`, {
      matchId: card.id,
    })
      .then((r) => {
        if (r?.result === "kept") reloadBubbleMaps(mint);
      })
      .catch(() => {
        // Nothing to show for it: the next opening tries again.
        openedFilterAlerts.delete(card.id);
      });
  }, [isFilterAlert, card.id, mint]);
}

/**
 * A Holders view: "now", the newest scan's; "alert", as kept at the alert or call; or a kept
 * moment (BubbleMoment), by its id.
 */
type HoldersView = "alert" | "now" | `moment:${string}`;

/** Which Holders view the modal opened on last: the next token view opens on the same one, where it has it. */
let lastHoldersView: HoldersView = "now";

/** One button on the Holders switch, in time order. */
interface HoldersOption {
  view: HoldersView;
  label: string;
  at: number;
}

/**
 * The Holders section's views (user ask 2026-10-14, 2026-10-16): "At the alert", the holders as
 * they stood when the coin was alerted or called, kept and never updated; the maps kept at the
 * coin's first safety-screen pass and at filters' first catches (BubbleMoment: everyone's, the
 * reader's own filter's, and public filters'); and "Now", the newest scan's.
 * At the alert draws the alert's own scan (its top 25, the numbers The call shows) under the
 * top-50 map kept at the coin's first model call, when that was read near this alert
 * (alertWideMap). A kept moment draws its own top 25 alone. A coin with none of them has only Now.
 */
function useHoldersView(card: Card, linked: Snapshot | null | undefined, alertAt: number, utility: boolean) {
  /** What the moment is called: a model's call, or a filter's alert. */
  const word: "call" | "alert" = card.kind === "curated" ? "call" : "alert";
  const maps = useBubbleMaps(card.token.mintAddress);
  const [picked, setPicked] = useState<HoldersView>(lastHoldersView);
  const s = card.snapshot;
  const frozen = utility || card.kind === "stream" ? null : alertWideMap(maps?.atAlert, alertAt);
  const alertHasList = !utility && card.kind !== "stream" && hasHolderList(s);
  // Both views would draw the same thing: the newest reading is the alert's and nothing kept differs.
  const same = linked?.takenAt === s.takenAt && !frozen && !maps?.map;
  const alertOffered = (alertHasList || !!frozen) && !same;
  // A filter alert's own catch is the At the alert view already: not offered twice.
  const moments = (maps?.moments ?? []).filter(
    (m) =>
      !(
        alertOffered &&
        card.kind === "match" &&
        m.kind === "filter" &&
        m.mine &&
        Math.abs(Date.parse(m.at) - Date.parse(card.matchedAt)) < 1_000
      ),
  );
  const options: HoldersOption[] = [
    ...(alertOffered ? [{ view: "alert" as const, label: `At the ${word}`, at: alertAt }] : []),
    ...moments.map((m) => ({
      view: `moment:${m.id}` as const,
      label: momentLabel(m).short,
      at: Date.parse(m.at),
    })),
  ].sort((a, b) => a.at - b.at);
  const canSwitch = options.length > 0;
  const view: HoldersView = options.some((o) => o.view === picked) ? picked : "now";
  const atAlert = view === "alert";
  const kept = view === "now" ? null : (moments.find((m) => view === `moment:${m.id}`) ?? null);
  const setView = (v: HoldersView) => {
    lastHoldersView = v;
    setPicked(v);
  };
  const keptReading = kept ? momentSnapshot(s, kept) : null;
  const moment = kept
    ? {
        label: momentLabel(kept).short,
        title: `The holders as they stood ${momentLabel(kept).long}: that scan's top holders, kept and never updated.`,
      }
    : utility
      ? undefined
      : atAlert
        ? {
            label: `At the ${word}`,
            title: frozen
              ? `The holders as they stood at the ${word}: the top 50 read ${fromAlertText(Date.parse(frozen.readAt), alertAt, word)}, kept and never updated. Counts are the ${word}'s own scan (the /25), the same numbers The call shows.`
              : `The holders the ${word}'s scan read, kept as they stood: the same reading The call shows.`,
          }
        : canSwitch
          ? {
              label: "Now",
              title:
                "The latest scan's reading. Switch to an earlier moment for the holders as they stood then.",
            }
          : holdersMoment(card, linked);
  return {
    word,
    view,
    setView,
    options,
    canSwitch,
    atAlert,
    /** The kept moment on view, if one is. */
    kept,
    /** Any view kept as it stood: the alert's or a moment's. */
    isKept: atAlert || !!kept,
    frozen,
    moment,
    /** The top-50 map to draw over the reading: the one kept at the call, none for a moment, else the live one. */
    wide: atAlert ? { wide: frozen } : kept ? { wide: null } : {},
    /** The reading the map draws. */
    reading: keptReading ?? (atAlert ? s : linked),
    /** The reading the top-holder list draws: the map's, through the kept top 50 when the scan kept no list. */
    listReading: keptReading ?? (atAlert ? (alertHasList ? s : withWideMap(s, frozen)) : linked),
  };
}

/** When a kept moment's holders were read, and that they are kept as they stood. */
function MomentHoldersWhen({ moment }: { moment: BubbleMoment }) {
  const at = Date.parse(moment.at);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day =
    new Date(at).toDateString() === new Date().toDateString()
      ? ""
      : `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  const what =
    moment.kind === "screen"
      ? "Passed the screen"
      : `${moment.mine ? "Your filter" : "Public filter"}${moment.filterName ? ` "${moment.filterName}"` : ""} caught it`;
  return (
    <p className="tm-holders-when">
      <b>
        {what} {day}
        {hm(at)}
      </b>{" "}
      ·{" "}
      <span>
        Holders read{" "}
        {fromAlertText(Date.parse(moment.readAt), at, moment.kind === "screen" ? "pass" : "catch")}
      </span>{" "}
      · <span>Kept as it stood</span>
    </p>
  );
}

/** When the holders at the alert were read, and that they are kept as they stood. */
function AlertHoldersWhen({
  alertAt,
  word,
  frozen,
  reading,
}: {
  alertAt: number;
  word: "call" | "alert";
  frozen: AlertWideMap | null;
  reading: Snapshot | null | undefined;
}) {
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const readAt = frozen ? Date.parse(frozen.readAt) : reading ? Date.parse(reading.takenAt) : alertAt;
  const day =
    new Date(alertAt).toDateString() === new Date().toDateString()
      ? ""
      : `${new Date(alertAt).toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  return (
    <p className="tm-holders-when">
      <b>
        {word === "call" ? "Called" : "Alerted"} {day}
        {hm(alertAt)}
      </b>{" "}
      ·{" "}
      <span>
        Holders read {fromAlertText(readAt, alertAt, word)}
        {frozen && <>, top {frozen.holdersRead}</>}
      </span>{" "}
      · <span>Kept as it stood</span>
    </p>
  );
}

/** When the holder reading was saved, and when the next is due (user ask 2026-10-13). */
function HolderFreshness({
  takenAt,
  now,
  moment,
}: {
  takenAt: string;
  now: number;
  moment?: { label: string; title: string };
}) {
  const { last, next } = holderFreshness(takenAt, now);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <p className="tm-holders-when">
      {moment && <b title={moment.title}>{moment.label} · </b>}
      Last updated {hm(last)} ·{" "}
      {next === null
        ? "No further updates: the coin is no longer being scanned"
        : `Next update due ~${hm(next)}`}
    </p>
  );
}

/** A group's heading: a small label with a rule running to the edge. */
function GroupLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="tm-group-label">
      <span>{children}</span>
    </h3>
  );
}

/** Why an access-gated part couldn't load, in words. */
function lockedText(error: Error, what: string): string | null {
  if (lookupRequired(error)) return error.message;
  if (error instanceof ApiError && (error.status === 401 || error.status === 402)) {
    return `The ${what} comes with access. Connect a wallet with access to see it.`;
  }
  return null;
}

export function ChartCard({
  card,
  chart: { data, error },
  alertAt,
  alertMcap,
  what,
}: {
  card: Card;
  chart: { data: TokenChart | null; error: Error | null };
  alertAt: number;
  alertMcap: number;
  what: string;
}) {
  const utility = useContext(UtilityContext);
  const api = useTokenApi(card.token.mintAddress);
  // Every token view opens on the coin's whole history; Model View is a click away.
  const [range, setRange] = useState<Range>("all");

  // Pro Mode: the signed-in wallet's position in the coin and the Trade panel. Null for everyone
  // else, so nothing of it is fetched or drawn without Pro Mode.
  const pro = useProWallet();
  const mint = card.token.mintAddress;
  const position = usePosition(pro ? mint : null);
  const [trading, setTrading] = useState(false);
  const [tradeOpened, setTradeOpened] = useState(false);
  useEffect(() => {
    if (trading) setTradeOpened(true);
  }, [trading]);
  const holds = !!position.data && BigInt(position.data.balance) > 0n;
  const expanded = !!pro && (trading || holds);

  // Read from the window on each render; a resize re-renders.
  const [, setResized] = useState(0);
  useEffect(() => {
    const onResize = () => setResized((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const height = chartHeight(expanded);

  const events = useMemo<ChartEvent[]>(() => {
    const out: ChartEvent[] = [{ t: alertAt, label: what, mcap: alertMcap > 0 ? alertMcap : null }];
    // Every other model that called it, once each, at its own call time - on a filter alert a
    // call folded into, its call(s) too.
    const curated = card.curated;
    const calls = curated?.calledBy?.length
      ? curated.calledBy
      : card.kind === "match" && curated
        ? [{ alertedAt: curated.alertedAt, modelName: curated.modelName ?? null }]
        : [];
    for (const c of calls) {
      const t = Date.parse(c.alertedAt);
      if (!Number.isFinite(t) || Math.abs(t - alertAt) < 30_000) continue;
      out.push({ t, label: c.modelName ?? "Model" });
    }
    return out;
  }, [alertAt, alertMcap, what, card.kind, card.curated]);

  // The coin's first trade, for whether its first minutes can still be drawn in fine detail.
  const firstTradeAt = data?.candles?.[0]?.t ?? data?.marketCap[0]?.t ?? null;
  const young = firstTradeAt !== null && Date.now() - firstTradeAt <= FIRST_VIEW_MAX_AGE_MS;
  const shownRange: Range = range === "first" && !young ? "all" : range;

  // The view's window over the minute data, before the finer reads that fill it in.
  const bounds = useMemo(
    () => (data ? viewBounds(data, shownRange, alertAt) : null),
    [data, shownRange, alertAt],
  );
  // Finer candles where they add detail: 1-second ones for a view of minutes, 15-second ones for
  // hours - and for a short view the 1-second page doesn't reach back across (Pump.fun sends the
  // most recent 1,000 with a trade, minutes of a busy coin).
  const span = bounds ? bounds.to - bounds.from : Infinity;
  const fineOk = shownRange !== "first" && !!data?.candles?.length;
  // Only for a view of the last minutes: the 1-second page never reaches back further, and each
  // read spends the shared Pump.fun budget.
  const wantSecond =
    fineOk && !!bounds && span <= SECOND_VIEW_MAX_MS && bounds.from >= Date.now() - SECOND_VIEW_MAX_MS;
  const second = useFineCandles(
    api,
    wantSecond ? "1s" : null,
    bounds?.live ? FINE_LIVE_POLL_MS : FINE_POLL_MS,
  );
  const secondReaches = !!second?.candles?.length && !!bounds && second.candles[0]!.t <= bounds.from + 60_000;
  const quarter = useFineCandles(
    api,
    fineOk && span <= QUARTER_VIEW_MAX_MS && (!wantSecond || (second !== null && !secondReaches))
      ? "15s"
      : null,
    FINE_POLL_MS,
  );
  // The live curve's every price change, while the view runs to now on a young coin.
  const tail = useLiveTail(api, young && shownRange !== "first" && !!bounds?.live);

  // A call card's alert price is the call's own anchor; a filter alert's can be a scan's reading.
  const callPriced = card.kind === "curated" && alertMcap > 0;
  const view = useMemo(() => {
    if (!data || !bounds) return null;
    const fromCandles = !!data.candles && data.candles.length > 0;
    // The newest candle is still open: its close so far is drawn at now, not at its end.
    const now = Date.now();
    const runOf = (candles: NonNullable<TokenChart["candles"]>, stepMs: number) => ({
      stepMs,
      candles: candles.map((k) => ({ ...k, vol: k.vol ?? 0 })),
      points: candleCloses(candles, stepMs).map((p) => (p.t > now ? { ...p, t: now } : p)),
    });
    // Coarse to fine: the minute candles, then the 15-second and 1-second ones wherever they reach.
    const fines = [quarter, second].flatMap((f) =>
      f?.candles?.length ? [runOf(f.candles, f.stepSec * 1_000)] : [],
    );
    // The line runs through each candle's close at its end - the finest candles wherever they
    // reach, the coarser ones before - then every live curve change after the newest candle.
    // Without candles, through the scan's readings.
    const runs: (CloseRun & { candles: VolumeCandle[] })[] = fromCandles
      ? [runOf(data.candles!, 60_000), ...fines]
      : [{ points: data.marketCap.map((p) => ({ t: p.t, v: p.usd })), stepMs: 0, candles: [] }];
    const candled = stitch(runs);
    const source = stitch(runs, bounds.live ? tail.ticks : []);
    if (source.length < 2) return null;
    const last = source[source.length - 1]!.t;
    const from = bounds.from;
    const to = bounds.live ? last : bounds.to;
    // Which widths the view is drawn from: a run is used where it wins (stitch's rule) in view.
    const used = runs.filter((r, i) => {
      const next = runs.slice(i + 1).find((n) => n.points.length > 0);
      const until = next ? next.points[0]!.t - next.stepMs : Infinity;
      return r.points.some((p) => p.t >= from && p.t <= to && p.t <= until);
    });
    const candledTo = candled.length > 0 ? candled[candled.length - 1]!.t : -Infinity;
    const usesTail = bounds.live && tail.ticks.some((p) => p.t >= from && p.t > candledTo);
    const finest = usesTail ? 1_000 : Math.min(...used.map((r) => r.stepMs || 30_000), 60_000);
    const step = pointWidthMs(Math.max(1_000, Math.min(to, last) - from), maxPoints(), finest);
    const line = linePoints(source, from, step, to);
    return {
      // A call is priced from a fresh quote (its anchor), so its price goes on the line at its
      // time: the "Called" marker then sits on the price the call and its grade start from.
      points: callPriced ? withCallPoint(line, { t: alertAt, v: alertMcap }) : line,
      fromCandles,
      step,
      // Whether the view runs to the latest reading (Model View's window can end before it).
      live: bounds.live,
      latest: source[source.length - 1]!.v,
      // The scans the model read before calling it, drawn as dots in Model View.
      scans:
        shownRange === "model"
          ? data.marketCap.filter((p) => p.t >= from && p.t <= alertAt).map((p) => ({ t: p.t, v: p.usd }))
          : [],
      // The candles in view for the volume lane, each stretch from one width only.
      candles: stitchVolume(runs).filter((k) => k.t + (k.w ?? 60_000) >= from && k.t <= to),
    };
  }, [data, bounds, quarter, second, tail.ticks, tail.source, shownRange, alertAt, alertMcap, callPriced]);

  // The scans' buy and sell counts, for the buy share in the chart's readouts.
  const flow = useMemo<ScanFlow[]>(
    () =>
      (data?.marketCap ?? []).flatMap((p) =>
        p.buys != null && p.sells != null ? [{ t: p.t, buys: p.buys, sells: p.sells }] : [],
      ),
    [data],
  );

  const latestMcap = view?.live ? view.latest : (data?.marketCap.at(-1)?.usd ?? null);
  const summary = useMemo(
    () => (pro && position.data ? summarizePosition(position.data, latestMcap) : null),
    [pro, position.data, latestMcap],
  );
  const chartTrades = useMemo<ChartTrade[]>(() => {
    const p = position.data;
    if (!pro || !p) return [];
    const scale = 10 ** (p.decimals ?? 6);
    return p.trades.flatMap((tr) => {
      if (tr.side !== "buy" && tr.side !== "sell") return [];
      const sol = Math.abs(Number(BigInt(tr.lamports))) / 1e9;
      const tokens = Number(BigInt(tr.tokens)) / scale;
      const what = tr.side === "buy" ? "You bought" : "You sold";
      return [{ t: tr.t, side: tr.side, text: `${what} ${tokensText(tokens)} for ${solText(sol)}` }];
    });
  }, [pro, position.data]);
  const entry = summary && summary.held > 0 ? summary.entryMcap : null;

  const streaming = shownRange !== "first" && isStreaming(tail);
  const locked = error && !data ? lockedText(error, "chart") : null;
  return (
    <>
      <section className="sage-card tm-chart">
        <h4>
          <ChartIcon size={14} /> Market cap
          {view && !view.fromCandles && view.points.length > 1 && (
            <span className="sage-tag" title="Pump.fun had no candles for this coin; these are our scans">
              Scan readings
            </span>
          )}
          {streaming && <LiveBadge tail={tail} />}
          {pro && (
            <button
              type="button"
              className={`tm-range tm-trade-toggle${trading ? " on" : ""}`}
              aria-pressed={trading}
              aria-expanded={trading}
              title="Buy and sell this coin with your wallet (Pro Mode)"
              onClick={() => setTrading(!trading)}
            >
              Trade
            </button>
          )}
          <span className="tm-ranges" role="group" aria-label="Chart range">
            {RANGES.filter((r) => (!utility || r.id !== "model") && (young || r.id !== "first")).map((r) => (
              <button
                key={r.id}
                type="button"
                className={`tm-range${shownRange === r.id ? " on" : ""}`}
                aria-pressed={shownRange === r.id}
                title={r.title}
                onClick={() => setRange(r.id)}
              >
                {utility && r.id === "alert" ? "From scan" : r.label}
              </button>
            ))}
          </span>
        </h4>
        {shownRange === "first" && (
          <FirstMinutesChart
            mint={card.token.mintAddress}
            label={tokenLabel(card.token)}
            events={events}
            height={height}
          />
        )}
        {shownRange !== "first" && !data && !error && <ChartSkeleton>Loading the chart…</ChartSkeleton>}
        {locked && (
          <p className="tm-locked muted small">
            <LockIcon size={14} /> {locked}
          </p>
        )}
        {error && !data && !locked && (
          <p className="error small">Couldn&apos;t load the chart: {error.message}</p>
        )}
        {shownRange !== "first" && data && (!view || view.points.length < 2) && (
          <p className="muted small tm-chart-empty">
            No trades to chart yet{shownRange !== "all" ? " in this range" : ""}.
          </p>
        )}
        {shownRange !== "first" && view && view.points.length >= 2 && (
          <>
            <PriceChart
              points={view.points}
              stepMs={view.step}
              events={events}
              candles={view.candles}
              flow={flow}
              seenUntil={shownRange === "model" ? alertAt : undefined}
              live={view.live}
              now={view.latest}
              scans={view.scans}
              height={height}
              trades={chartTrades}
              entry={entry}
              ariaLabel={`${tokenLabel(card.token)} market cap from ${usd(view.points[0]!.v)} to ${usd(view.points[view.points.length - 1]!.v)}`}
            />
            {shownRange === "model" && (
              <p className="faint small tm-chart-src">
                <i className="tm-scan-dot" aria-hidden="true" />{" "}
                {view.scans.length > 0
                  ? `${view.scans.length} scan${view.scans.length === 1 ? "" : "s"} the model read · `
                  : ""}
                5 minutes either side of the call; shaded is after it, which the model never saw.
              </p>
            )}
          </>
        )}
      </section>
      {/* Mounted once opened and only hidden after, so a trade still confirming keeps its status. */}
      {pro && (trading || tradeOpened) && (
        <div hidden={!trading}>
          <TradePanel
            owner={pro}
            mint={mint}
            symbol={card.token.symbol ?? "tokens"}
            position={position.data}
            summary={summary}
            onTraded={position.reload}
          />
        </div>
      )}
      {pro && !trading && holds && summary && (
        <p className="small muted tm-trade-held">
          You hold this coin
          {summary.pnlSol !== null && (
            <>
              {" "}
              ·{" "}
              <span className={`num ${summary.pnlSol >= 0 ? "up" : "down"}`}>
                {solText(summary.pnlSol, true)}
              </span>
            </>
          )}
          .{" "}
          <button type="button" className="link" onClick={() => setTrading(true)}>
            Open Trade
          </button>
        </p>
      )}
    </>
  );
}

/** A view's window over the minute data: where it starts and ends, and whether it runs to now. */
function viewBounds(
  data: TokenChart,
  range: Range,
  alertAt: number,
): { from: number; to: number; live: boolean } | null {
  const times = data.candles?.length ? data.candles.map((k) => k.t + 60_000) : data.marketCap.map((p) => p.t);
  if (times.length === 0) return null;
  const first = Math.min(times[0]!, data.candles?.[0]?.t ?? Infinity);
  const last = times[times.length - 1]!;
  const from =
    range === "all"
      ? first
      : range === "1h"
        ? Math.max(first, last - 3_600_000)
        : range === "model"
          ? Math.max(first, alertAt - MODEL_SPAN_MS)
          : // From the alert: unless the data starts after it (then all of it).
            Math.max(first, alertAt - LEAD_IN_MS);
  // Model View's window can end before the latest reading; every other view runs to it.
  const to = range === "model" ? alertAt + MODEL_SPAN_MS : Math.max(last, Date.now());
  return { from, to, live: range !== "model" || to >= Date.now() };
}

/** Whether the live tail is current: its price confirmed within the last few polls. */
function isStreaming(tail: LiveTail): boolean {
  return (
    !tail.done &&
    (tail.source === "stream" || tail.source === "rpc") &&
    tail.readAt !== null &&
    Date.now() - tail.readAt < LIVE_STALE_MS
  );
}

/** The header's "Live" pill: the chart is drawing the coin's curve as it changes. */
function LiveBadge({ tail }: { tail: LiveTail }) {
  const how =
    tail.source === "stream"
      ? "every price change, block by block, from the Helius stream"
      : `the bonding curve, read every ${LIVE_POLL_MS / 1_000} seconds (the stream is catching up)`;
  return (
    <span className="tm-live" title={`Live: ${how}`}>
      <i aria-hidden="true" /> Live
    </span>
  );
}

/** Points drawn at most: fewer on a phone, where each still needs room to be hovered. */
function maxPoints(): number {
  return window.innerWidth <= 640 ? 160 : MAX_POINTS;
}

/**
 * The "First 15m" view (user ask 2026-10-17): the coin's first 15 minutes from Pump.fun's candles
 * (GET /tokens/:mint/chart/first), every second while the coin is inside them and re-read every
 * few seconds, then in 15-second steps. While it is inside them the live curve's changes run on
 * past the newest candle. The axis counts from the launch. Read only while the view is open.
 */
function FirstMinutesChart({
  mint,
  label,
  events,
  height,
}: {
  mint: string;
  label: string;
  events: ChartEvent[];
  height: number;
}) {
  const api = useTokenApi(mint);
  const [live, setLive] = useState(true);
  const { data, error } = usePolling<TokenFirstMinutes>(
    `${api}/chart/first`,
    live ? FIRST_LIVE_POLL_MS : FIRST_POLL_MS,
  );
  useEffect(() => {
    if (data && !data.live) setLive(false);
  }, [data]);
  const tail = useLiveTail(api, live && !!data?.live);
  const view = useMemo(() => {
    const candles = data?.candles;
    if (!data || !candles || candles.length === 0) return null;
    const step = data.stepSec * 1_000;
    const start = data.startAt ?? candles[0]!.t;
    const end = start + FIRST_MINUTES_MS;
    // From the first trade's open, then each candle's close at its end, when that price held, then
    // the curve's own changes after the newest candle, inside the 15 minutes.
    const points = stitch(
      [{ points: [{ t: candles[0]!.t, v: candles[0]!.o }, ...candleCloses(candles, step)], stepMs: step }],
      data.live ? tail.ticks.filter((p) => p.t <= end) : [],
    );
    return {
      points: linePoints(points, start, pointWidthMs(FIRST_MINUTES_MS, maxPoints() * 2, step)),
      step,
      start,
      candles: candles.map((k) => ({ ...k, vol: k.vol ?? 0, w: step })),
    };
  }, [data, tail.ticks]);

  if (!data && !error) return <ChartSkeleton>Loading the first minutes…</ChartSkeleton>;
  if (error && !data) {
    const locked = lockedText(error, "chart");
    return locked ? (
      <p className="tm-locked muted small">
        <LockIcon size={14} /> {locked}
      </p>
    ) : (
      <p className="error small">Couldn&apos;t load the first minutes: {error.message}</p>
    );
  }
  if (!view || view.points.length < 2) {
    return (
      <p className="muted small tm-chart-empty">
        {data?.live
          ? "No trades to chart yet."
          : "Pump.fun no longer has this coin's first minutes in fine detail."}
      </p>
    );
  }
  const streaming = isStreaming(tail);
  return (
    <>
      <PriceChart
        points={view.points}
        stepMs={view.step}
        events={events}
        candles={view.candles}
        live={data!.live}
        origin={view.start}
        height={height}
        ariaLabel={`${label} market cap in its first 15 minutes, from ${usd(view.points[0]!.v)} to ${usd(view.points[view.points.length - 1]!.v)}`}
      />
      <p className="faint small tm-chart-src">
        {streaming && <LiveBadge tail={tail} />} Time since launch, over the first 15 minutes.
      </p>
    </>
  );
}

const TAG_TEXT: Record<FlaggedWallet["tags"][number], { text: string; tone: string }> = {
  creator: { text: "Dev", tone: "dev" },
  risky: { text: "Risky", tone: "risky" },
  dumper: { text: "Known dumper", tone: "risky" },
  linked: { text: "Linked", tone: "linked" },
  kol: { text: "KOL", tone: "kol" },
  winner: { text: "Winner", tone: "winner" },
};

/** GET /tokens/:mint/stonk-fees (api routes/tokens.ts). */
interface StonkFees {
  stonks: boolean;
  wallet: string;
  label: string;
  pct: number | null;
}

/** A share of supply as the card shows it: two decimals, a sliver as "<0.01%". */
function stonkFeesPctText(pct: number): string {
  return pct > 0 && pct < 0.01 ? "<0.01%" : `${pct.toFixed(2)}%`;
}

/**
 * Stonks' fee wallet's share of a Stonks coin (user ask 2026-10-16): the 3% transfer fee it sweeps
 * up. It is left out of every holder figure, bundle and the bubble map (on every coin), so its
 * share shows here on its own. Nothing for any other coin.
 */
function StonkFeesCard({ mint }: { mint: string }) {
  const { data } = usePolling<StonkFees>(`/tokens/${encodeURIComponent(mint)}/stonk-fees`, 120_000);
  if (!data?.stonks) return null;
  return (
    <section className="sage-card tm-stonk-fees" aria-label="Stonk fee wallet">
      <h4>
        Stonk fee wallet
        <span className="tm-h4-meta muted small">left out of holders</span>
      </h4>
      <div className="tm-stonk-fees-row">
        <button
          type="button"
          className="tm-wallet tm-wallet-btn"
          onClick={() => openWallet(data.wallet)}
          title="Open this wallet's details"
        >
          {data.label} <span className="muted">{shortAddress(data.wallet)}</span>
        </button>
        <b className="tm-stonk-fees-pct">{data.pct === null ? "n/a" : stonkFeesPctText(data.pct)}</b>
      </div>
      <p className="muted small tm-stonk-fees-note">
        Stonks' fee wallet holds the coin's 3% transfer fee, swept from trades. It isn't counted in the top
        holders, bundles, linked wallets or the bubble map.
      </p>
    </section>
  );
}

/** The flagged wallets in the coin: what each is, its score, and what it did in the coin. */
function WalletsCard({ wallets }: { wallets: FlaggedWallet[] }) {
  const [all, setAll] = useState(false);
  // Folded to its heading until opened (user ask 2026-10-16); the map marks these wallets too.
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const shown = all ? wallets : wallets.slice(0, 6);
  // One read names the whole list (and the funders its Linked tags mention).
  const names = useWalletNames(
    useMemo(() => wallets.flatMap((w) => [w.wallet, w.funder ?? null]), [wallets]),
  );
  return (
    <section className={`sage-card tm-wallets${open ? "" : " folded"}`}>
      <FoldHead open={open} onToggle={() => setOpen((o) => !o)} controls={bodyId}>
        Flagged wallets
        <span className="sage-tag">{wallets.length}</span>
        <span className="tm-h4-meta muted small">trading this coin</span>
      </FoldHead>
      {open && (
        <div id={bodyId}>
          <div className="fw-table" role="table" aria-label="Flagged wallets">
            <div className="fw-row fw-headrow" role="row">
              <span role="columnheader">Wallet</span>
              <span role="columnheader" className="fw-score-h" title="Risk score, 0-100">
                Risk
              </span>
              <span role="columnheader" className="fw-num">
                SOL in
              </span>
              <span role="columnheader" className="fw-num">
                SOL out
              </span>
              <span role="columnheader" className="fw-num">
                Net
              </span>
            </div>
            {shown.map((w) => {
              const net = w.solOut - w.solIn;
              const tone = w.score === null ? "none" : w.score >= 70 ? "high" : w.score >= 40 ? "mid" : "low";
              return (
                <div key={w.wallet} className="fw-row" role="row">
                  <span className="fw-who" role="cell">
                    <i className={`pc-swatch k-${kindOf(w)}`} aria-hidden="true" />
                    <button
                      type="button"
                      className="tm-wallet tm-wallet-btn"
                      onClick={() => openWallet(w.wallet)}
                      title="Open this wallet's details"
                    >
                      <WalletText wallet={w.wallet} names={names} />
                    </button>
                    <span className="tm-tags">
                      {w.tags.map((t) => (
                        <span
                          key={t}
                          className={`tm-tag k-${TAG_TEXT[t].tone}`}
                          title={
                            t === "linked" && w.funder
                              ? `Funded by ${walletText(w.funder, names)}, like other top holders`
                              : t === "dumper" && w.dumps !== null
                                ? `Sold into the stop on ${w.dumps} of its called coins (4+, three quarters of them, 10+ coins on record)`
                                : t === "winner"
                                  ? `Sold 3 or more of the coins it bought at 2x or better for ${MIN_WIN_SOL}+ SOL profit, at least twice as often as the market, with 10+ coins on record`
                                  : t === "kol" && w.knownSideOf
                                    ? `One of ${w.kol || "a KOL"}'s own wallets, not its main one`
                                    : undefined
                          }
                        >
                          {t === "kol" && w.knownSideOf
                            ? names[w.wallet]?.source === "kol-side" || !w.kol
                              ? "Known Side"
                              : `${w.kol} Known Side`
                            : t === "kol" && w.kol && names[w.wallet]?.name !== w.kol
                              ? `KOL: ${w.kol}`
                              : TAG_TEXT[t].text}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span
                    role="cell"
                    className={`fw-score num s-${tone}`}
                    title={
                      w.score === null
                        ? "Not scored: seen in fewer than two read coins"
                        : `Risk score ${Math.round(w.score)} of 100${w.coins ? `, from ${w.coins} coins` : ""}`
                    }
                  >
                    {w.score === null ? "–" : Math.round(w.score)}
                  </span>
                  <span role="cell" className="fw-num num">
                    {w.solIn.toFixed(2)}
                  </span>
                  <span role="cell" className="fw-num num">
                    {w.solOut.toFixed(2)}
                  </span>
                  {/* Before it sells, its SOL in is a position, not a loss. */}
                  <span
                    role="cell"
                    className={`fw-num num ${w.solOut > 0 ? (net >= 0 ? "up" : "down") : "faint"}`}
                    title={w.solOut > 0 ? undefined : "Still holding: nothing sold yet"}
                  >
                    {w.solOut > 0 ? `${net >= 0 ? "+" : ""}${net.toFixed(2)}` : "holding"}
                  </span>
                </div>
              );
            })}
          </div>
          {wallets.length > 6 && (
            <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${wallets.length}`}
            </button>
          )}
          <p className="faint small tm-wallets-note">
            Risky: a score of 70+ from selling into earlier calls&apos; stops. Linked: funded by the same
            wallet as other top holders. KOL: a known KOL&apos;s wallet. Winner: sells its coins at 2x or
            better for {MIN_WIN_SOL}+ SOL profit at least twice as often as the market. KOL and Winner mark
            presence only, not a buy signal. SOL is what each wallet put into and took out of this coin.
          </p>
        </div>
      )}
    </section>
  );
}

/** The card's numbers, all of them, whatever the reader hides on the card itself. */
function StatsCard({ card }: { card: Card }) {
  const s = card.snapshot;
  const r = cardReadings(card);
  const utility = useContext(UtilityContext);
  const { scale } = useScoreWeights();
  const { scoreColor } = useAppearance();
  const tone = scoreColor ? scoreTone(s.score ?? null, scale) : null;
  const latest = card.latestSnapshot;
  /** The lookup's scan is still reading this: a placeholder, not "–" or "Not checked". */
  const pending = utility?.scan === "scanning";
  const wait = (missing: boolean, width?: string) =>
    pending && missing ? <SkelValue width={width} /> : null;
  const waitTile = (label: string) => (
    <div>
      <dt>{label}</dt>
      <dd>
        <SkelValue />
      </dd>
    </div>
  );
  return (
    <section className="sage-card">
      <h4>
        {utility ? "At the scan" : "At the alert"}
        {pending && (
          <span className="sage-tag tm-tag-busy">
            <Spinner size={9} /> Scanning
          </span>
        )}
      </h4>
      <dl className="tm-stats">
        <div>
          <dt>Score</dt>
          <dd className="num" style={tone === null ? undefined : { color: scoreToneColor(tone) }}>
            {wait(s.score == null, "2em") ?? (s.score == null ? "–" : Math.round(s.score))}
          </dd>
        </div>
        <div
          title={
            s.liveHolderCount != null
              ? "Jupiter's count seconds before the alert (the count the Min holders filter reads); the arrow is the latest"
              : "RugCheck's count (no live count was read for this alert); the arrow is the latest"
          }
        >
          <dt>Holders</dt>
          <dd className="num">
            {wait((s.liveHolderCount ?? s.holderCount) == null) ?? s.liveHolderCount ?? s.holderCount ?? "–"}
            {(() => {
              const then = s.liveHolderCount ?? s.holderCount;
              const now = latest ? (latest.liveHolderCount ?? latest.holderCount) : null;
              return now != null && now !== then ? <small className="muted"> → {now}</small> : null;
            })()}
          </dd>
        </div>
        <div>
          <dt>Vol 5m</dt>
          <dd className="num">{usd(s.volume5mUsd ?? null)}</dd>
        </div>
        <div>
          <dt>Vol 1h</dt>
          <dd className="num">{usd(s.volume1hUsd ?? null)}</dd>
        </div>
        <div>
          <dt>Vol 24h</dt>
          <dd className="num">{usd(s.volume24hUsd)}</dd>
        </div>
        <div title="Buys and sells over the last 24 hours (since launch, for a younger token)">
          <dt>Buys / sells</dt>
          <dd className="num">
            {s.buys24h != null && s.sells24h != null ? `${s.buys24h} / ${s.sells24h}` : "–"}
          </dd>
        </div>
        <div
          className={
            s.top10HolderPct != null && s.top10HolderPct >= SAFETY_REJECT_TOP10_HOLDER_PCT
              ? "risky"
              : undefined
          }
          title="Share of supply the ten largest holders own (pool aside)"
        >
          <dt>Top 10</dt>
          <dd className="num">{wait(s.top10HolderPct == null) ?? pct(s.top10HolderPct)}</dd>
        </div>
        <div
          className={
            r.largestPct !== null && r.largestPct > SAFETY_MAX_LARGEST_HOLDER_PCT ? "risky" : undefined
          }
          title={`One wallet's share of supply (pools aside, its accounts summed). The safety screen rejects over ${SAFETY_MAX_LARGEST_HOLDER_PCT}%.`}
        >
          <dt>Largest holder</dt>
          <dd className={r.largestPct === null ? "muted" : "num"}>
            {wait(r.largestPct === null) ?? (r.largestPct === null ? "–" : pct(r.largestPct))}
          </dd>
        </div>
        {pending && r.freshPct === null ? (
          waitTile("Fresh")
        ) : (
          <WalletStat
            label="Fresh"
            value={r.freshPct}
            of={r.freshOf}
            failsAbove={SAFETY_MAX_FRESH_WALLET_PCT}
            atAlert={r.freshAtAlert !== null}
            explain="top-holder wallets first used, or used again after a week or more idle, in the last 24h"
          />
        )}
        {pending && r.emptyPct === null ? (
          waitTile("Empty")
        ) : (
          <WalletStat
            label="Empty"
            value={r.emptyPct}
            of={r.emptyOf}
            failsAt={SAFETY_REJECT_EMPTY_WALLET_PCT}
            atAlert={r.emptyAtAlert !== null}
            explain="top-10 holder wallets with under $25 of other tokens"
          />
        )}
        {pending && r.snipers === null ? waitTile("Snipers") : <SniperTile reading={r.snipers} />}
        <div
          className={
            r.linkedCount !== null &&
            r.linkedCount.linked >= countCutFor(SAFETY_REJECT_LINKED_COUNT, r.linkedCount.of)
              ? "risky"
              : undefined
          }
          title={`Top holders one wallet funded, that funded each other, or that were funded within a minute of each other${
            r.linkedPct === null ? "" : `, holding ${pct(r.linkedPct)} of supply`
          }. The safety screen rejects ${countCutFor(SAFETY_REJECT_LINKED_COUNT, r.linkedCount?.of)} or more of the ${r.linkedCount?.of ?? 25}.`}
        >
          <dt>Linked</dt>
          <dd className={r.linkedPct === null ? "muted" : "num"}>
            {wait(r.linkedPct === null) ??
              (r.linkedPct === null ? "Not checked" : (linkedCountText(r.linkedCount) ?? pct(r.linkedPct)))}
          </dd>
        </div>
        <div
          className={
            r.cexCount !== null && r.cexCount >= countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, r.cexHolders)
              ? "risky"
              : undefined
          }
          title={`Of the ${r.cexHolders ?? 25} largest holders, how many were opened from an exchange (or a busy service like a bridge). The safety screen rejects ${countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, r.cexHolders)} or more.`}
        >
          <dt>CEX-funded</dt>
          <dd className={r.cexPct === null ? "muted" : "num"}>
            {wait(r.cexPct === null) ??
              (r.cexPct === null ? "Not checked" : (cexCountText(r.cexCount, r.cexHolders) ?? pct(r.cexPct)))}
          </dd>
        </div>
        <div
          title={
            r.firstHolding === null && r.firstHoldingOld !== null
              ? `Not recorded under the 0.1% count for this token. ${oldFirstBuyersText(r.firstHoldingOld, r.firstSeenOld)}`
              : "How many of the launch's first 25 buyers still hold 0.1% of the supply or more"
          }
        >
          <dt>First buyers holding</dt>
          <dd className="num">
            {wait(r.firstHolding === null, "2.4em") ??
              (r.firstHolding !== null
                ? `${r.firstHolding}/${r.firstSeen ?? 25}`
                : r.firstHoldingOld !== null
                  ? `${r.firstHoldingOld}/${r.firstSeenOld ?? 25}*`
                  : "–")}
          </dd>
        </div>
        <div title={r.feeLine ?? undefined}>
          <dt>Dev</dt>
          <dd>
            {wait(r.devHolding === null) ?? (r.devHolding === null ? "–" : r.devHolding ? "Holding" : "Sold")}
          </dd>
        </div>
      </dl>
      {r.feeLine && <p className="small muted tm-fee">Creator fee: {r.feeLine}</p>}
    </section>
  );
}

/** Who called it and why: each model with its confidence, the reasons, and the AI reviewer's view. */
/** Mirrors apps/api/src/tokenWhy.ts TokenWhy. */
interface TokenWhy {
  moment: { at: string } | null;
  gate: string | null;
  seats: {
    id: string;
    name: string;
    calls: boolean;
    topPct: number | null;
    callsTopPct: number | null;
    for: string[];
    against: string[];
  }[];
}

/** Seats listed before "Show all". */
const WHY_SEATS = 4;

function topText(p: number): string {
  return `top ${p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

/**
 * How the models read the coin at its decision moment (user ask 2026-10-16): each seat's rank of it
 * against the rank it calls at, and for the closest seats, what pushed its score up and down.
 * `at`: a call's time, for the moment it was decided on; null for the coin's newest. Nothing while
 * it loads or when the reader can't see it.
 */
function ModelsRead({ mint, at }: { mint: string; at: number | null }) {
  const [all, setAll] = useState(false);
  const { data } = usePolling<TokenWhy>(
    `/tokens/${encodeURIComponent(mint)}/why${at !== null ? `?at=${at}` : ""}`,
    300_000,
  );
  if (!data) return null;
  if (!data.moment) {
    return data.gate ? <p className="small muted tm-why-gate">No model scored it: {data.gate}.</p> : null;
  }
  const seats = data.seats;
  if (seats.length === 0) return null;
  const shown = all ? seats : seats.slice(0, WHY_SEATS);
  return (
    <div className="tm-why">
      <p className="tm-why-h small">
        How the models read it
        <span className="faint">
          {" "}
          · {at !== null ? "at the call" : `scored ${ago(new Date(data.moment.at), Date.now())}`}
        </span>
      </p>
      <ul className="tm-why-seats">
        {shown.map((x) => (
          <li key={x.id} className={x.calls ? "calls" : ""}>
            <span className="tm-why-name">{x.name}</span>
            <span
              className="tm-why-rank small"
              title="Where this coin ranked among the model's own scores of the last day, against the share it calls"
            >
              {x.topPct !== null && x.callsTopPct !== null ? (
                <>
                  {x.calls ? "Over its line," : "Ranked it"} {topText(x.topPct)}
                  <span className="faint"> · calls {topText(x.callsTopPct)}</span>
                </>
              ) : x.calls ? (
                "Over its line"
              ) : (
                "Under its line"
              )}
            </span>
            {(x.for.length > 0 || x.against.length > 0) && (
              <span className="tm-why-push small">
                {x.for.length > 0 && (
                  <span>
                    <i className="tm-why-up" aria-label="Pushed it up:">
                      ▲
                    </i>{" "}
                    {x.for.join(", ")}
                  </span>
                )}
                {x.against.length > 0 && (
                  <span>
                    <i className="tm-why-down" aria-label="Held it back:">
                      ▼
                    </i>{" "}
                    {x.against.join(", ")}
                  </span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {seats.length > WHY_SEATS && (
        <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${seats.length}`}
        </button>
      )}
    </div>
  );
}

function CallCard({ card }: { card: Card }) {
  const curated = card.curated;
  const showNarrative = useShowNarrativeNote();
  if (!curated) {
    return (
      <section className="sage-card tm-why-card">
        <h4>Why it&apos;s here</h4>
        <p className="small muted">
          {card.kind === "stream"
            ? "It passed the safety screen inside the market-cap band. No model has called it."
            : card.filter
              ? `Your filter "${card.filter.name}" caught it. No model has called it.`
              : "Your filter caught it. No model has called it."}
        </p>
        <ModelsRead mint={card.token.mintAddress} at={null} />
      </section>
    );
  }
  const calls =
    curated.calledBy && curated.calledBy.length > 0
      ? curated.calledBy
      : [
          {
            model: curated.model ?? null,
            modelName: curated.modelName ?? null,
            confidence: curated.confidence,
            tier: curated.tier,
            calibratedPct: curated.calibratedPct,
            alertedAt: curated.alertedAt,
          },
        ];
  const ai = curated.aiReview;
  return (
    <section className="sage-card">
      <h4>Why it was called</h4>
      <ul className="tm-calls">
        {calls.map((c, i) => (
          <li key={`${c.model ?? "m"}-${i}`}>
            <BrainIcon size={13} />
            <strong>{c.modelName ?? "Model"}</strong>
            <span className="num">{c.confidence.toFixed(0)}</span>
            {c.tier === "high" && <span className="sage-tag tone-good">High conviction</span>}
            {typeof c.calibratedPct === "number" && (
              <span
                className="muted small"
                title="Of recent out-of-sample calls ranked like this one, the share that doubled within 15 minutes"
              >
                ≈{c.calibratedPct.toFixed(0)}% 2x
              </span>
            )}
          </li>
        ))}
      </ul>
      {curated.reasons.length > 0 && (
        <ul className="reasons tm-reasons">
          {curated.reasons.slice(0, 6).map((r) => (
            <li key={r}>{r.replace(/^model signal: /, "")}</li>
          ))}
        </ul>
      )}
      <ModelsRead mint={card.token.mintAddress} at={Date.parse(curated.alertedAt)} />
      {curated.narrative && showNarrative && (
        <p className="small">
          <span className={`sage-tag ${curated.narrative.verdict === "agrees" ? "tone-good" : "tone-warn"}`}>
            Narrative {curated.narrative.verdict}
          </span>
        </p>
      )}
      {ai && (
        <div className={`tm-ai ${ai.decision === "buy" ? "buy" : ai.decision === "no_buy" ? "nobuy" : ""}`}>
          <span className="tm-ai-head">
            <RobotIcon size={13} /> AI reviewer:{" "}
            <strong>{ai.decision === "buy" ? "BUY" : ai.decision === "no_buy" ? "NO BUY" : "error"}</strong>
            {ai.probability2x !== null && (
              <span className="muted"> · {(ai.probability2x * 100).toFixed(0)}% to 2x</span>
            )}
          </span>
          {ai.reasoning && <p className="small">{ai.reasoning}</p>}
          {ai.risks.length > 0 && <p className="small muted">Risks: {ai.risks.join("; ")}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * TokenSage's part of the modal, kept to three cards (user ask 2026-10-16): what the coin refers to,
 * whether it is a copy or builds on another coin, and what it is trending on. The rest of the read
 * is one button away in TokenSage's own modal.
 */
function SageSection({
  mint,
  sage: { data, error },
}: {
  mint: string;
  sage: { data: SageView | null; error: Error | null };
}) {
  const utility = useContext(UtilityContext);
  const r = data?.read ?? null;
  // A lookup's read is on its way: its three cards keep their places meanwhile.
  const reading = !!utility && !r && !error && (!data || data.status === "none");
  return (
    <>
      {r ? (
        <div className="tm-sage-grid">
          <ReferentCard read={r} />
          <LineageCard read={r} />
          <TrendCard read={r} />
        </div>
      ) : reading ? (
        <>
          <LoadingNote slow="TokenSage is still reading this coin. A deep read can take a few minutes.">
            {data
              ? "TokenSage is reading this coin now. Its read fills in here as soon as it lands."
              : "Loading TokenSage's read…"}
          </LoadingNote>
          <div className="tm-sage-grid" aria-hidden="true">
            {["Refers to", "Copycat check", "Trending"].map((t) => (
              <section key={t} className="sage-card">
                <h4>{t}</h4>
                <Skeleton lines={3} />
              </section>
            ))}
          </div>
        </>
      ) : (
        <SageStatus data={data} error={error} />
      )}
      <button type="button" className="tm-sage-open" onClick={() => openSage(mint)}>
        <SageIcon size={14} /> Open TokenSage&apos;s full read
      </button>
    </>
  );
}

/** Why there are no cards yet: still loading, locked, failed, or TokenSage hasn't read the coin. */
function SageStatus({ data, error }: { data: SageView | null; error: Error | null }) {
  const locked = error && !data ? lockedText(error, "TokenSage read") : null;
  return (
    <section className="sage-card tm-sage">
      {!data && !error && <Skeleton lines={3} />}
      {locked && (
        <p className="tm-locked muted small">
          <LockIcon size={14} /> {locked}
        </p>
      )}
      {error && !data && !locked && (
        <p className="error small">Couldn&apos;t load the read: {error.message}</p>
      )}
      {data && (
        <p className="small muted">
          {data.status === "failed"
            ? "TokenSage couldn't read this coin."
            : data.status === "expired"
              ? "TokenSage's full read isn't kept for this coin (reads are kept for three weeks, and only for coins that reached the band)."
              : "TokenSage hasn't read this coin yet."}
        </p>
      )}
    </section>
  );
}

/**
 * What the coin is about: its referent and how sure TokenSage is, what kind of thing it is, the
 * signals that point at it, and the X post it was read from.
 */
function ReferentCard({ read: r }: { read: SageRead }) {
  const ref = r.referent;
  const supported = new Set(ref?.supportedBy ?? []);
  const signals = INPUTS.filter((i) => supported.has(i.id));
  const x = r.x?.url?.startsWith("https://") ? r.x : null;
  return (
    <section className="sage-card tm-referent-card">
      <h4>
        {ref?.generic ? "A kind of coin" : "Refers to"}
        <span className="sage-tag">{r.depth === "full" ? "Deep read" : "Quick read"}</span>
      </h4>
      <strong className="tm-referent-name">{ref ? ref.label : "No clear referent"}</strong>
      {ref?.confidence != null && (
        <span className="muted small">{Math.round(ref.confidence * 100)}% sure</span>
      )}
      {(ref?.kind || r.mainCategory) && (
        <div className="sage-marks">
          {ref?.kind && <span className="sage-tag tone-neutral">{words(ref.kind)}</span>}
          {r.mainCategory && <span className="sage-tag">{categoryText(r.mainCategory.label)}</span>}
        </div>
      )}
      {ref?.desc && <p className="tm-referent-desc small">{ref.desc}</p>}
      {signals.length > 0 && (
        <div className="tm-referent-signals" aria-label="What points at the referent">
          <span className="sage-eyebrow">Pointed at by</span>
          <span className="sage-inputs">
            {signals.map((i) => (
              <span key={i.id} className="sage-input on">
                <CheckIcon size={11} />
                {i.label}
              </span>
            ))}
          </span>
        </div>
      )}
      {x && (
        <p className="small tm-referent-x">
          <a href={x.url!} target="_blank" rel="noreferrer">
            {x.author?.handle ? `@${x.author.handle}` : "X post"}
            <ExternalIcon size={11} />
          </a>
          <span className="muted">
            {x.relation && ` · ${RELATION[x.relation] ?? words(x.relation)}`}
            {x.author?.followers != null && ` · ${count(x.author.followers)} followers`}
          </span>
        </p>
      )}
    </section>
  );
}

/** Where the coin comes from: what it copies or builds on, and how crowded its name and theme are. */
function LineageCard({ read: r }: { read: SageRead }) {
  const l = r.lineage;
  const lineage = l ? LINEAGE[l.kind] : undefined;
  const has = !!l || !!r.referent?.wave || r.copyOf.length > 0;
  return (
    <section className="sage-card tm-lineage">
      <h4>
        Copycat check
        {lineage && <span className={`sage-tag tone-${lineage.tone}`}>{lineage.text}</span>}
      </h4>
      {has ? (
        <>
          <LineageText read={r} />
          <CrowdChart read={r} />
        </>
      ) : (
        <p className="small muted">TokenSage didn&apos;t tie it to any earlier coin or crowd.</p>
      )}
    </section>
  );
}

/** What the coin is riding: the trending terms TokenSage matched it to, where, and how high. */
function TrendCard({ read: r }: { read: SageRead }) {
  const t = r.trend;
  const terms = t?.terms.slice(0, 3) ?? [];
  return (
    <section className="sage-card tm-trend">
      <h4>
        Trending
        {t?.score != null && (t.matched || terms.length > 0) && (
          <span className={`sage-tag ${t.score >= 0.6 ? "tone-good" : "tone-neutral"}`}>
            strength {pct0(t.score)}
          </span>
        )}
      </h4>
      {terms.length > 0 ? (
        <ul className="tm-terms">
          {terms.map((x, i) => (
            <li key={`${x.term}-${x.source}-${i}`}>
              <span className="tm-term-head">
                <strong>{x.term}</strong>
                <span className="tm-term-src">
                  {TREND_SOURCE[x.source] ?? words(x.source)}
                  {x.rank !== null && <span className="num"> #{x.rank}</span>}
                </span>
              </span>
              {x.score !== null && (
                <span className="tm-term-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, Math.min(1, x.score) * 100)}%` }} />
                </span>
              )}
              {x.headline && <span className="tm-term-line muted small">{x.headline}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">
          {t === null
            ? "Trends weren't checked on this read."
            : "Not trending: nothing it refers to is up on Wikipedia, Google Trends, the news or X right now."}
        </p>
      )}
    </section>
  );
}
