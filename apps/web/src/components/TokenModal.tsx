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
import { createPortal } from "react-dom";
import { LiveTradesCard, useBatchedWallets } from "./LiveTrades";
import { useLiveTrades } from "../liveTrades";
import { usePossibleSides } from "../possibleSides";
import {
  createContext,
  useCallback,
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
import { useLiveMarketCaps, usePolling } from "../hooks";
import { MIN_WIN_SOL, ago, change, minutes, multiple, pct, shortAddress, tokenLabel, usd } from "../format";
import { TokenImage } from "./TokenImage";
import { FoldHead } from "./Fold";
import { DevCard, FlowCard, SocialsCard, type TokenProfile } from "./TokenProfileCards";
import { cardOutcome, outcomeBadge } from "../outcome";
import { openSage } from "../sage";
import { QUICK_LINK_SITES, pumpFunHref, useAppearance } from "../appearance";
import { useIsAdmin } from "../session";
import { useShowNarrativeNote } from "../narrativeNote";
import { scoreTone, scoreToneColor, useScoreWeights } from "../scoreWeights";
import {
  candleCloses,
  linePoints,
  stitch,
  stitchVolume,
  withCallPoint,
  pointWidthMs,
  zoomWindow,
  type CloseRun,
  type MarkerKind,
  type Point,
  type ScanFlow,
  type VolumeCandle,
  type Zoom,
} from "../priceChart";
import {
  cardReadings,
  oldFirstBuyersText,
  cexCountText,
  countCutFor,
  linkedReading,
  nowReading,
  nowReadingAge,
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
import { CHART_MARKS_SECTION } from "./WalletMarksPicker";
import { CustomizeDrawer } from "./CustomizeDrawer";
import { markPrefsOf, walletMarks, withLiveMarks } from "../walletMarks";
import { PriceChart, type ChartEvent, type ChartKind, type ChartTrade } from "./PriceChart";
import { TradePanel, solText, tokensText } from "./TradePanel";
import { PRO_MODE_PERKS } from "./ProModeCard";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { LIVE_POLL_MS, useFineCandles, useLiveTail, type LiveTail } from "./chartFeeds";
import { guessPath, pathFrom, type PathGuess, type PathStep } from "../pricePathing";
import {
  categoryText,
  count,
  CrowdChart,
  INPUTS,
  LINEAGE,
  AtReadTime,
  LineageText,
  pct0,
  RELATION,
  TREND_SOURCE,
  words,
  type SageRead,
  type SageView,
} from "./SageView";
import { Skeleton } from "./Skeleton";
import { LoadingNote, LoadSteps, SkelValue, Spinner, useElapsed } from "./Loading";
import { openWallet } from "../walletModal";
import { closeTokenModal } from "../tokenModal";
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
  ChevronLeftIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  ClockIcon,
  CrownIcon,
  LockIcon,
  RobotIcon,
  SageIcon,
  ShieldIcon,
  SlidersIcon,
} from "./Icons";
import { XLinkPreview } from "./XLinkPreview";
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

/** Mirrors apps/api/src/tokenChart.ts MarkedWallet. */
interface FlaggedWallet {
  wallet: string;
  tags: ("risky" | "dumper" | "linked" | "creator" | "kol" | "winner" | "side" | "tracked")[];
  score: number | null;
  dumps: number | null;
  coins: number | null;
  funder: string | null;
  /** A known KOL's name ("" when unnamed). Absent from older API builds. */
  kol?: string | null;
  /** A KOL's Known Side: the KOL's main wallet (`kol` is then the KOL's name). */
  knownSideOf?: string;
  /** A KOL's funded wallet or Probable Side (tag "side"). Absent from older API builds. */
  side?: {
    kind: "funded" | "probable";
    kolWallet: string;
    kolName: string | null;
    /** A tie to a wallet the reader labeled: its kind. */
    tracked?: "kol" | "tracked";
  };
  /** Tagged "tracked": the name the reader gave it as a User Tracked wallet. */
  tracked?: string;
  solIn: number;
  solOut: number;
  heldPct: number | null;
  trades: [number, 1 | -1, number | null][];
}

/** The swatch colour a flagged wallet gets: the creator first, then a risky one, a KOL, a winner, else linked. */
function kindOf(w: FlaggedWallet): MarkerKind {
  if (w.tags.includes("creator")) return "dev";
  if (w.tags.includes("risky") || w.tags.includes("dumper")) return "risky";
  if (w.tags.includes("kol") || w.tags.includes("side") || w.tags.includes("tracked")) return "kol";
  if (w.tags.includes("winner")) return "winner";
  return "linked";
}

/**
 * The chart's two views (user ask 2026-10-19): Trading, the last minutes with the latest at the
 * right edge, and All, the coin's whole history. Customize › Token chart sets which one opens.
 */
type Range = "trading" | "all";
const RANGES: { id: Range; label: string; title: string }[] = [
  { id: "trading", label: "Trading", title: "The last 15 minutes, the latest candle at the right edge" },
  { id: "all", label: "All", title: "The coin's whole history" },
];
/** How far back the Trading view reaches (never before the first trade). */
const TRADING_SPAN_MS = 15 * 60_000;
/** Points drawn at most: enough for a smooth line, few enough that each one stays hoverable. */
const MAX_POINTS = 240;
/** Views this short read Pump.fun's 1-second candles, and up to QUARTER_VIEW_MAX_MS its 15-second ones. */
const SECOND_VIEW_MAX_MS = 20 * 60_000;
const QUARTER_VIEW_MAX_MS = 6 * 3_600_000;
/** The fine candles are re-read this often: 1-second ones on a view running to now, others rarely. */
const FINE_LIVE_POLL_MS = 5_000;
/** How often the predicted path is read afresh: its 5-second steps. */
const PATH_EVERY_MS = 5_000;
const FINE_POLL_MS = 60_000;
/**
 * The live tail counts as live while its price was confirmed this recently: past the API's
 * longest hold of a quiet coin's ask (apps/api/src/liveCurve.ts MAX_WAIT_MS, 8 seconds).
 */
const LIVE_STALE_MS = 15_000;
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

/** Wide enough for Scope's terminal layout: chart, bubble map and the trading rail side by side. */
const TERMINAL_QUERY = "(min-width: 1200px)";

function useMatches(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/**
 * Everything about one token on a feed card, in a native modal dialog (a centred panel on desktop,
 * a full page on phones, user ask 2026-10-18; the address bar stays as it was): its market-cap chart since launch with the alert marked, the
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
  scope = false,
}: {
  /** Null while the view is still being fetched: `opening` then says for which coin. */
  card: Card | null;
  now: number;
  onClose: () => void;
  utility?: UtilityMode | null;
  opening?: OpeningView;
  /** Opened from the Scope board: a wide window gets the terminal layout (user ask 2026-10-18). */
  scope?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Desktop only: a phone or a narrow window keeps the usual view whatever opened it.
  const wide = useMatches(TERMINAL_QUERY);
  const terminal = scope && !utility && wide && !!card;
  // Full window under the site's bar (user pick 2026-10-18), which stays in view above it.
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    if (!terminal) return;
    const bar = document.querySelector(".topbar");
    const measure = () => setBarH(Math.max(0, Math.round(bar?.getBoundingClientRect().bottom ?? 0)));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [terminal]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // The title, not the first button (on a phone, the back arrow), takes the focus.
    dialog.querySelector<HTMLElement>("#tm-title")?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`about-modal sheet-modal tm-modal${terminal ? " tm-terminal" : ""}`}
      style={terminal ? ({ "--tm-bar-h": `${barH}px` } as React.CSSProperties) : undefined}
      aria-labelledby="tm-title"
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) onClose();
      }}
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
          <TokenBody card={card} now={now} onClose={() => ref.current?.close()} terminal={terminal} />
        ) : (
          opening && <OpeningBody {...opening} onClose={() => ref.current?.close()} />
        )}
      </UtilityContext.Provider>
    </dialog>
  );
}

/** On phones the token view is a full page: a back arrow at the header's start closes it (styles.css). */
function BackButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="ghost icon-btn tm-back" onClick={onClose} aria-label="Back">
      <ChevronLeftIcon size={20} />
    </button>
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
          <BackButton onClose={onClose} />
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
          <button type="button" className="ghost icon-btn tm-close" onClick={onClose} aria-label="Close">
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
                  {["Trading", "All"].map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`tm-range${r === "Trading" ? " on" : ""}`}
                      disabled
                    >
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
function ChartSkeleton({ children, height }: { children: ReactNode; height?: number }) {
  return (
    <div className="tm-chart-skeleton" style={{ height: height ?? chartBoxHeight() }}>
      <LoadingNote className="tm-skel-note" slow="Still loading the chart…">
        {children}
      </LoadingNote>
    </div>
  );
}

/** The chart's plot height for this window, and the whole box it draws (axis and volume lane included). */
function chartHeight(expanded = false): number {
  // Larger by default (user ask 2026-10-18), trading or not. On a phone, where the token view is a
  // full page, the chart takes a bit under half the screen's height: the screen's, not the window's,
  // which grows and shrinks as the browser's address bar hides on scroll.
  if (window.innerWidth <= 640) {
    const tall = window.screen?.height || window.innerHeight;
    return Math.round(Math.min(420, Math.max(280, tall * 0.44)));
  }
  // Pro Mode's bigger chart, while trading or holding the coin: room for the trade marks.
  return expanded ? 400 : 320;
}
/** The Scope terminal's chart: most of the window's height left over by the header and the tabs. */
function terminalChartHeight(): number {
  return Math.round(Math.min(620, Math.max(400, window.innerHeight - 360)));
}
function chartBoxHeight(): number {
  return chartHeight() + CHART_CHROME_PX + (window.innerWidth <= 640 ? CHART_READOUT_PX : 0);
}
/** The Line / Candles and zoom row under the chart. */
const CHART_TOOLS_PX = 34;
/** What PriceChart draws around its plot: the time axis, the volume lane and the row under it. */
const CHART_CHROME_PX = 40 + CHART_TOOLS_PX;
/** On a phone, the readout PriceChart docks under the chart (its .pc-readout min-height). */
const CHART_READOUT_PX = 84;

/** The Holders section's place while its reading is taken: the bubble map's frame, and the list's. */
function HoldersPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="tm-holders">
      <BubbleMapPlaceholder>{children}</BubbleMapPlaceholder>
    </div>
  );
}

/**
 * A card copy this long without a newer one has stopped being refreshed: it left the feed while
 * its modal stayed open, or the modal was opened from somewhere that never refreshes it (Scope,
 * Portfolio, Trades). The feed sends a new copy at least every poll (30 s).
 */
const CARD_QUIET_MS = 90_000;

/**
 * The modal's card, kept current on its own: "Now" from the live tick (as the feed's cards are),
 * and once the card copy goes quiet (CARD_QUIET_MS), the coin's newest scan laid over it, so the
 * safety verdict, peak and "Now" don't freeze where the feed left them.
 */
function useFreshCard(cardIn: Card, followScans: boolean): Card {
  const mint = cardIn.token.mintAddress;
  const lastCopy = useRef({ card: cardIn, at: Date.now() });
  if (lastCopy.current.card !== cardIn) lastCopy.current = { card: cardIn, at: Date.now() };
  const [scan, setScan] = useState<{ mint: string; snapshot: Snapshot } | null>(null);
  useEffect(() => {
    if (!followScans) return;
    let live = true;
    const read = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCopy.current.at < CARD_QUIET_MS) return;
      cachedGet<{ snapshots?: Snapshot[] }>(`/tokens/${encodeURIComponent(mint)}`, HOLDER_SCAN_MS)
        .then((d) => {
          const newest = d.snapshots?.[0];
          if (live && newest) setScan({ mint, snapshot: newest });
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(read, HOLDER_SCAN_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [followScans, mint]);
  const withScan = useMemo(() => {
    const snap = scan?.mint === mint ? scan.snapshot : null;
    if (!snap) return cardIn;
    const snapAt = Date.parse(snap.takenAt);
    const had = cardIn.latestSnapshot ? Date.parse(cardIn.latestSnapshot.takenAt) : 0;
    if (!(snapAt > had)) return cardIn;
    const mcapAt = cardIn.currentMarketCapAt ? Date.parse(cardIn.currentMarketCapAt) : 0;
    const newerMcap = snap.marketCapUsd != null && snapAt > mcapAt;
    return {
      ...cardIn,
      latestSnapshot: snap,
      ...(newerMcap
        ? {
            currentMarketCapUsd: snap.marketCapUsd,
            currentMarketCapAt: snap.takenAt,
            currentMarketCapSource: undefined,
          }
        : {}),
    };
  }, [cardIn, scan, mint]);
  const cards = useMemo(() => [withScan], [withScan]);
  return useLiveMarketCaps(cards)?.[0] ?? withScan;
}

function TokenBody({
  card: cardIn,
  now,
  onClose,
  terminal = false,
}: {
  card: Card;
  now: number;
  onClose: () => void;
  /** Scope's desktop layout (TERMINAL_QUERY): chart beside the map, tabs below, a trading rail. */
  terminal?: boolean;
}) {
  const { hideSafetyPill } = useAppearance();
  const utility = useContext(UtilityContext);
  const card = useFreshCard(cardIn, !utility);
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
  const nowAge = nowReadingAge(card, nowMcap, now);
  const what = utility
    ? "Scanned"
    : card.kind === "stream"
      ? "Passed screen"
      : card.kind === "curated"
        ? "Model alert"
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
  // Who holds the coin now, by the latest scan's holder list, for the Labeled wallets toggle.
  const currentHolders = useMemo(
    () => new Set((linked?.linkedHolders ?? []).flatMap((h) => (h ? [h.wallet] : []))),
    [linked],
  );
  useFilterCatchKept(card, !!utility);
  const ids = useId().replace(/:/g, "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(bodyRef, ids);
  const navRef = useRef<HTMLElement>(null);
  useNavFollows(navRef, active);
  const headH = useHeadHeight(bodyRef);
  const goTo = (id: SectionId) =>
    document.getElementById(`${ids}-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const safety = safetyVerdict(card, scanning);
  // A pass starts folded, a fail or a pending verdict open; the reader's own choice then holds.
  const [safetyOpenSet, setSafetyOpen] = useState<boolean | null>(null);
  const safetyOpen = safetyOpenSet ?? safety.state !== "passed";
  // The terminal's column view and tab under the chart, and the rail's slot the chart's Trade panel
  // is drawn into. A tab that is now the column's shows the first of the others instead.
  const [side, setSide] = useTermSide();
  // The bubble map's tab opens first when the map is down in the tabs, else Holders: never Live
  // trades on its own, whose feed only runs while someone chose to watch it.
  const [tabPicked, setTab] = useState<TermTab>(side === "map" ? "holders" : "map");
  const tabRow = useTabRowScroll(terminal ? side : null);
  const tab = tabPicked === side ? (side === "holders" ? "map" : "holders") : tabPicked;
  const [tradeSlot, setTradeSlot] = useState<HTMLDivElement | null>(null);
  const openSafety = () => {
    setSafetyOpen(true);
    goTo("safety");
  };
  // A lookup asks TokenSage for a fresh read, which lands within minutes: check more often.
  const tokenApi = useTokenApi(mint);
  const sage = usePolling<SageView>(`${tokenApi}/sage`, utility ? 20_000 : 120_000);
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

  const headTop = (
    <>
      <div className="tm-token">
        <BackButton onClose={onClose} />
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
              {card.token.name && card.token.symbol && <span className="token-name"> {card.token.name}</span>}
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
        <button type="button" className="ghost icon-btn tm-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </div>
      <QuickLinks mint={mint} socials={profile.data?.socials} />
    </>
  );
  const figs = (
    <section className="tm-figs" aria-label="Market cap">
      <div className="tm-fig">
        <label>{utility ? "At scan" : what === "Passed screen" ? "At screen" : "At alert"}</label>
        <span className="num">{usd(alertMcap)}</span>
      </div>
      <div className={`tm-fig${nowAge !== null ? " aged" : ""}`}>
        <label>Now{nowAge !== null && <span className="fig-age"> · {nowAge}</span>}</label>
        <span className="num" title={nowAge !== null ? `Read ${nowAge} ago` : undefined}>
          {usd(nowMcap)}
        </span>
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
  );

  const holdersBar = (holders.canSwitch || (holders.reading && hasHolderList(holders.reading))) && (
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
  );
  const bubbleMapIn = (column: boolean) => (
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
      column={column}
      // Scope's wide tab: the map spreads across it (user ask 2026-10-19).
      spread={terminal && !column ? 2.6 : undefined}
    />
  );
  const bubbleMap = bubbleMapIn(false);

  if (terminal) {
    const counts: Partial<Record<TermTab, number>> = {
      holders: s.holderCount ?? undefined,
      wallets: flagged.length || undefined,
    };
    const tabs = TERM_VIEWS.filter((x) => x.id !== side);
    // A view's content, in the column (fit to it) or in the tabs' wide pane.
    const view = (id: TermTab, column: boolean) => {
      switch (id) {
        case "map":
          return (
            <>
              {holdersBar}
              {bubbleMapIn(column)}
            </>
          );
        case "trades":
          return <LiveTradesCard base={tokenApi} snapshot={holders.listReading} flagged={flagged} />;
        case "holders":
          return (
            <>
              <TopHolders
                snapshot={holders.listReading}
                flagged={flagged}
                entries={entries}
                pending={scanning}
                defaultOpen
              />
              <StonkFeesCard mint={mint} />
            </>
          );
        case "wallets":
          return flagged.length > 0 ? (
            <WalletsCard wallets={flagged} holders={currentHolders} defaultOpen />
          ) : (
            <p className="muted small tm-term-empty">
              {flags === "loading"
                ? "Reading the coin's wallets…"
                : "No KOLs or wallets you labeled have traded this coin."}
            </p>
          );
        case "flow":
          return (
            <>
              {profile.data?.flow ? (
                <FlowCard flow={profile.data.flow} now={now} />
              ) : (
                <p className="muted small tm-term-empty">
                  {profile.data || profile.error ? "No scan counts read for this coin yet." : "Loading…"}
                </p>
              )}
              <FlowMore
                points={chart.data?.marketCap ?? []}
                flagged={flagged}
                entries={entries}
                snap={card.latestSnapshot ?? card.snapshot}
              />
            </>
          );
        case "market":
          return <StatsCard card={card} />;
        case "dev":
          return (
            <div className="tm-grid tm-dev-grid">
              <DevCard dev={profile.data ? profile.data.dev : undefined} />
              <SocialsCard socials={profile.data?.socials} x={sage.data?.read?.x} />
            </div>
          );
        case "sage":
          return <SageSection mint={mint} sage={sage} />;
      }
    };
    const sideLabel = TERM_VIEWS.find((x) => x.id === side)?.label ?? "";
    return (
      <div className="about-body tm-body tm-term" ref={bodyRef}>
        <header className="tm-head">
          {headTop}
          {figs}
        </header>
        <div className="tm-term-grid">
          <div className="tm-term-main">
            <div className={`tm-term-top${side === "none" ? " solo" : side === "map" ? " with-map" : ""}`}>
              <section className="tm-term-chart" aria-label="Chart">
                <ChartCard
                  card={card}
                  chart={chart}
                  alertAt={alertAt}
                  alertMcap={alertMcap}
                  what={what}
                  tradeSlot={tradeSlot}
                />
              </section>
              {side !== "none" && (
                <section
                  className={`tm-term-map tm-side-${side}${side === "map" && holders.isKept ? " at-alert" : ""}`}
                  aria-label={sideLabel}
                >
                  <div className="tm-term-map-in">{view(side, true)}</div>
                </section>
              )}
            </div>
            <div className="tm-term-tabs">
              <div
                ref={tabRow.ref}
                className={`tm-term-tablist${tabRow.edges}`}
                role="tablist"
                aria-label="Sections"
              >
                {tabs.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.id}
                    className={`tm-nav-btn${tab === x.id ? " on" : ""}`}
                    onClick={() => setTab(x.id)}
                  >
                    {x.label}
                    {counts[x.id] != null && (
                      <span className="num muted"> {counts[x.id]!.toLocaleString()}</span>
                    )}
                  </button>
                ))}
              </div>
              {/* What sits beside the chart, the reader's pick (user asks 2026-10-19): the bubble
                  map at first; a view put there leaves the tabs, and None gives the chart the row. */}
              <div className="tm-term-pick">
                <label htmlFor={`${ids}-side`}>Beside the chart</label>
                <select
                  id={`${ids}-side`}
                  value={side}
                  onChange={(e) => {
                    const next = e.target.value as TermSide;
                    // The map moved down to the tabs opens there, so it doesn't seem to vanish.
                    if (side === "map" && next !== "map") setTab("map");
                    setSide(next);
                  }}
                >
                  <option value="none">None</option>
                  {TERM_VIEWS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="tm-term-pane" role="tabpanel">
              {view(tab, false)}
            </div>
          </div>
          <aside className="tm-term-rail" aria-label="Trade and checks">
            <div ref={setTradeSlot} className="tm-term-trade" />
            <div id={`${ids}-safety`} className="tm-term-safety">
              {/* Open from the start here: the rail is where the checks are read at a glance. */}
              <SafetyCard
                verdict={safety}
                scanning={scanning}
                now={now}
                open={safetyOpenSet ?? true}
                onToggle={() => setSafetyOpen(!(safetyOpenSet ?? true))}
              />
            </div>
            {!utility && <CallCard card={card} />}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div
      className="about-body tm-body"
      ref={bodyRef}
      style={headH ? ({ "--tm-head-h": `${headH}px` } as React.CSSProperties) : undefined}
    >
      <header className="tm-head">
        {headTop}
        <nav className="tm-nav" aria-label="Sections" ref={navRef}>
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

      {figs}

      <section id={`${ids}-chart`} className="tm-group" aria-label="Chart">
        <ChartCard card={card} chart={chart} alertAt={alertAt} alertMcap={alertMcap} what={what} />
        {profile.data?.flow && <FlowCard flow={profile.data.flow} now={now} />}
      </section>

      <section id={`${ids}-holders`} className="tm-group" aria-labelledby={`${ids}-holders-h`}>
        <GroupLabel id={`${ids}-holders-h`}>Holders</GroupLabel>
        {holdersBar}
        <div className={`tm-holders${holders.isKept ? " at-alert" : ""}`}>
          {bubbleMap}
          <TopHolders snapshot={holders.listReading} flagged={flagged} entries={entries} pending={scanning} />
        </div>
        {flagged.length > 0 && <WalletsCard wallets={flagged} holders={currentHolders} />}
        <StonkFeesCard mint={mint} />
      </section>

      <section id={`${ids}-call`} className="tm-group" aria-labelledby={`${ids}-call-h`}>
        <GroupLabel id={`${ids}-call-h`}>{utility ? "Market" : "The alert"}</GroupLabel>
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
  { id: "call", label: "The alert" },
  { id: "dev", label: "Dev" },
  { id: "safety", label: "Safety" },
  { id: "sage", label: "TokenSage" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
/**
 * The Scope terminal's views (user picks 2026-10-18): one in the column beside the chart, the
 * reader's pick (user ask 2026-10-19), and every other in the tabs under it.
 */
type TermTab = "map" | "trades" | "holders" | "wallets" | "flow" | "market" | "dev" | "sage";
const TERM_VIEWS: readonly { id: TermTab; label: string }[] = [
  { id: "map", label: "Bubble map" },
  { id: "trades", label: "Live trades" },
  { id: "holders", label: "Holders" },
  { id: "wallets", label: "Labeled wallets" },
  { id: "flow", label: "Order flow" },
  { id: "market", label: "Market" },
  { id: "dev", label: "Dev & socials" },
  { id: "sage", label: "TokenSage" },
];
/** What sits beside the chart: a view, or none so the chart takes the row. */
type TermSide = TermTab | "none";
/** The column's view, kept in this browser for every coin. */
const TERM_SIDE_KEY = "ts-scope-side";

function readTermSide(): TermSide {
  try {
    const v = localStorage.getItem(TERM_SIDE_KEY);
    return v === "none" || TERM_VIEWS.some((x) => x.id === v) ? (v as TermSide) : "map";
  } catch {
    return "map";
  }
}

/**
 * What sits beside the chart, the reader's pick: the bubble map until they choose another view,
 * or none so the chart takes the full row and the map is one of the tabs (user asks 2026-10-19).
 */
function useTermSide(): [TermSide, (v: TermSide) => void] {
  const [side, setSide] = useState<TermSide>(readTermSide);
  const pick = (v: TermSide) => {
    setSide(v);
    try {
      localStorage.setItem(TERM_SIDE_KEY, v);
    } catch {
      // Private mode: the pick holds for this window only.
    }
  };
  return [side, pick];
}

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
 * On a phone the section nav scrolls sideways: the section being read is brought into view as the
 * page scrolls, so "TokenSage" isn't lit up off the edge of the screen. Only the nav moves, never
 * the page.
 */
function useNavFollows(navRef: RefObject<HTMLElement | null>, active: SectionId): void {
  useEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>(".tm-nav-btn.on");
    if (!nav || !btn || nav.scrollWidth <= nav.clientWidth) return;
    const pad = 24;
    const box = btn.getBoundingClientRect();
    const left = box.left - nav.getBoundingClientRect().left + nav.scrollLeft;
    const right = left + box.width;
    if (left - pad < nav.scrollLeft) nav.scrollTo({ left: Math.max(0, left - pad), behavior: "smooth" });
    else if (right + pad > nav.scrollLeft + nav.clientWidth)
      nav.scrollTo({ left: right + pad - nav.clientWidth, behavior: "smooth" });
  }, [navRef, active]);
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
/** A holder report this much older than its scan says its own time on the safety card. */
const HOLDER_READ_LAG_MS = 2 * 60_000;

/** Whether the scan's holder figures (top 10, dev %, holders) came from a report older than it. */
function holderReadLags(reading: Snapshot): boolean {
  if (!reading.holderCountAt) return false;
  return Date.parse(reading.takenAt) - Date.parse(reading.holderCountAt) >= HOLDER_READ_LAG_MS;
}

function holderReadTitle(reading: Snapshot): string | undefined {
  if (!reading.holderCountAt) return undefined;
  const at = new Date(reading.holderCountAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Top 10, dev % and the holder count come from the holder report read at ${at}; the scan reuses a report for a few minutes.`;
}

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
          <span className="tm-h4-meta small muted" title={holderReadTitle(reading)}>
            Scan {ago(new Date(reading.takenAt), now)}
            {holderReadLags(reading) && reading.holderCountAt && (
              <>, holders read {ago(new Date(reading.holderCountAt), now)}</>
            )}
          </span>
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
          "The reading at the alert, the same one The alert section shows. Counts are over the top holders it read (the /25 or /10).",
      }
    : {
        label: "Now",
        title:
          "The latest scan's reading, not the alert's: The alert section below shows the holders at the alert. Counts are over the top holders this scan read (the /25 or /10), which can be a different set.",
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
  /** What the moment is named in the holders text: a model's alert and a filter's both read "alert". */
  const word = "alert";
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
              ? `The holders as they stood at the ${word}: the top 50 read ${fromAlertText(Date.parse(frozen.readAt), alertAt, word)}, kept and never updated. Counts are the ${word}'s own scan (the /25), the same numbers The alert section shows.`
              : `The holders the ${word}'s scan read, kept as they stood: the same reading The alert section shows.`,
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
  word: string;
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
        Alerted {day}
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

/** No traders: the side read asks for nothing. */
const NO_TRADERS: readonly string[] = [];

/**
 * A row of tabs that scrolls sideways when the picker beside it leaves too little room (user ask
 * 2026-10-19): a mouse wheel scrolls it, and its edges fade where more tabs are hidden.
 * `edges` is the class suffix for those fades. `layout` changes when the row's tabs do (null: no row).
 */
function useTabRowScroll(layout: string | null): { ref: RefObject<HTMLDivElement | null>; edges: string } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges(`${left ? " more-left" : ""}${right ? " more-right" : ""}`);
    };
    // A vertical wheel moves the row sideways while it has somewhere to go.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    read();
    const size = new ResizeObserver(read);
    size.observe(el);
    for (const c of el.children) size.observe(c);
    el.addEventListener("scroll", read, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      size.disconnect();
      el.removeEventListener("scroll", read);
      el.removeEventListener("wheel", onWheel);
    };
  }, [layout]);
  return { ref, edges };
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
  tradeSlot,
}: {
  card: Card;
  chart: { data: TokenChart | null; error: Error | null };
  alertAt: number;
  alertMcap: number;
  what: string;
  /**
   * The Scope terminal's rail: the Trade panel (or, without Pro Mode, what Pro Mode adds) is drawn
   * there rather than under the chart. Null until the rail is on the page; absent elsewhere.
   */
  tradeSlot?: HTMLElement | null;
}) {
  const api = useTokenApi(card.token.mintAddress);
  // Customize › Token chart sets the view it opens on; the switch over the chart this one.
  const look = useAppearance();
  const [rangePicked, setRange] = useState<Range | null>(null);
  const shownRange: Range = rangePicked ?? look.chartView;
  // Zoomed into the view (user ask 2026-10-18); a new range starts from the whole of it.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const pickRange = (r: Range) => {
    setRange(r);
    setZoom(null);
  };

  // Pro Mode: the signed-in wallet's position in the coin and the Trade panel. Null for everyone
  // else, so nothing of it is fetched or drawn without Pro Mode.
  const proState = useProState();
  const pro = proState?.wallet ?? null;
  // Pro Mode ended: the panel only says trading is off (no sells: #717), for a coin the wallet holds.
  const closeOnly = !!proState && !proState.pro;
  const graceEndsAt = proState?.pro ? proState.graceEndsAt : null;
  const mint = card.token.mintAddress;
  const position = usePosition(pro ? mint : null);
  const holds = !!position.data && BigInt(position.data.balance) > 0n;
  // Trade is its own section, always open (user ask 2026-10-18), for Pro Mode wallets (admins
  // included). Never where no wallet here could sign a trade (a phone signed in by QR, say).
  const canSign = useCanSignTrades(pro);
  const trading = !!pro && canSign && (!closeOnly || holds);
  // Only where the panel shows: a phone signed in by QR gets no empty space.
  const expanded = trading;

  // Read from the window on each render; a resize re-renders.
  const [, setResized] = useState(0);
  useEffect(() => {
    const onResize = () => setResized((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const inTerminal = tradeSlot !== undefined;
  const height = inTerminal ? terminalChartHeight() : chartHeight(expanded);

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

  // Labeled wallets' trades on the line (user ask 2026-10-18), as set in Customize › Chart wallet
  // trades, which the header's link opens over the token view.
  // The predicted path is admins-only while it is tried out (user ask 2026-10-18).
  const admin = useIsAdmin();
  const markPrefs = useMemo(() => markPrefsOf(look), [look]);
  // Line or candles: Customize › Token chart sets the default, the switch under the chart this view.
  const [kindPicked, setKind] = useState<ChartKind | null>(null);
  const kind = kindPicked ?? look.chartStyle;
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const labeled = data?.wallets ?? [];
  // The trader's own wallet is drawn as their own arrows, whatever its labels.
  // Live, as they happen (user ask 2026-10-19): the coin's live trades (one feed with the Live
  // trades tab) fold into the flagged wallets', and KOLs and tracked wallets the chart hasn't
  // flagged yet join by name.
  const liveFeed = useLiveTrades(api, markPrefs.on && markPrefs.kinds.length > 0);
  const liveTraders = useBatchedWallets(liveFeed.trades);
  const liveNames = useWalletNames(liveTraders);
  // KOL ties are read for every trader only while funded wallets or Probable Sides are marked.
  const sideMarks = markPrefs.on && markPrefs.kinds.some((k) => k === "funded" || k === "probable");
  const liveSides = usePossibleSides(sideMarks ? liveTraders : NO_TRADERS);
  const marked = useMemo(
    () => withLiveMarks(data?.wallets ?? [], liveFeed.trades, liveNames, liveSides),
    [data?.wallets, liveFeed.trades, liveNames, liveSides],
  );
  const marks = useMemo(
    () => walletMarks(marked, markPrefs, new Set(pro ? [pro] : [])),
    [marked, markPrefs, pro],
  );

  // The view's window over the minute data, before the finer reads that fill it in.
  const bounds = useMemo(() => (data ? viewBounds(data, shownRange) : null), [data, shownRange]);
  // Finer candles where they add detail: 1-second ones for a view of minutes, 15-second ones for
  // hours - and for a short view the 1-second page doesn't reach back across (Pump.fun sends the
  // most recent 1,000 with a trade, minutes of a busy coin).
  // Zoomed in, the window decides: zooming into minutes reads them finer.
  const shownBounds = bounds && zoom ? zoomWindow(zoom, bounds.from, bounds.to) : bounds;
  const span = shownBounds ? shownBounds.to - shownBounds.from : Infinity;
  const fineOk = !!data?.candles?.length;
  // Only for a view of the last minutes: the 1-second page never reaches back further, and each
  // read spends the shared Pump.fun budget.
  const wantSecond =
    fineOk &&
    !!shownBounds &&
    span <= SECOND_VIEW_MAX_MS &&
    shownBounds.from >= Date.now() - SECOND_VIEW_MAX_MS;
  // The experimental predicted path (Customize › Token chart, off by default) reads the last
  // minute second by second, so a live view with it on reads the 1-second page whatever its span;
  // the view itself still draws it only where it would anyway.
  const pathing = admin && look.chartPathing && fineOk && !!bounds?.live;
  const secondRead = useFineCandles(
    api,
    wantSecond || pathing ? "1s" : null,
    bounds?.live ? FINE_LIVE_POLL_MS : FINE_POLL_MS,
  );
  const second = wantSecond ? secondRead : null;
  const secondReaches =
    !!second?.candles?.length && !!shownBounds && second.candles[0]!.t <= shownBounds.from + 60_000;
  const quarter = useFineCandles(
    api,
    fineOk && span <= QUARTER_VIEW_MAX_MS && (!wantSecond || (second !== null && !secondReaches))
      ? "15s"
      : null,
    FINE_POLL_MS,
  );
  // The live curve's (or after bonding, pool's) every price change, while the view runs to now. Any
  // age (user ask 2026-10-18: too many charts were delayed): the API follows only open charts.
  const tail = useLiveTail(api, !!bounds?.live);
  // Whether the coin gets instant updates at all (user ask 2026-10-18): a Pump.fun coin on its curve
  // or in its PumpSwap pool has a live tail. Once the tail says nothing live prices it, it stays so
  // for this coin, so switching views doesn't bring the pill and the Trade note back and forth.
  const [offCurveFor, setOffCurveFor] = useState<string | null>(null);
  useEffect(() => {
    if (tail.done) setOffCurveFor(mint);
  }, [tail.done, mint]);
  const delayed = !!data && offCurveFor === mint;
  // When the chart last brought new prices, and how often it re-reads them without the live tail:
  // the 1-second candles every few seconds on a view of the last minutes, else the chart's own poll.
  const chartAt = useArrivedAt(data);
  const secondAt = useArrivedAt(second);
  const updatedAt = Math.max(chartAt ?? 0, second ? (secondAt ?? 0) : 0) || null;
  const everyMs = second ? FINE_LIVE_POLL_MS : CHART_POLL_MS;

  // The predicted path's last read, kept across renders so it is re-read only every PATH_EVERY_MS.
  const guessRef = useRef<{ mint: string; slot: number; guess: PathGuess | null } | null>(null);
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
    // The live tail says when the price was last known current: with no change since, the price
    // held, so the line runs on flat to then rather than stopping at the last change.
    const held = (pts: Point[]) => {
      const end = pts[pts.length - 1];
      const at = tail.readAt === null ? null : Math.min(tail.readAt, now);
      return bounds.live && end && tail.ticks.length > 0 && at !== null && at > end.t + 1_000
        ? [...pts, { t: at, v: end.v }]
        : pts;
    };
    const source = held(stitch(runs, bounds.live ? tail.ticks : []));
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
    const fullStep = pointWidthMs(Math.max(1_000, Math.min(to, last) - from), maxPoints(), finest);
    const full = linePoints(source, from, fullStep, to);
    if (full.length < 2) return null;
    const extent = { t0: full[0]!.t, t1: full[full.length - 1]!.t };
    // Zoomed in, the window is thinned on its own, a step past each edge, so it keeps its detail.
    const win = zoom ? zoomWindow(zoom, extent.t0, extent.t1) : null;
    const step = win ? pointWidthMs(Math.max(1_000, win.to - win.from), maxPoints(), finest) : fullStep;
    const line = win
      ? linePoints(source, Math.max(from, win.from - step), step, Math.min(to, win.to + step))
      : full;
    // The predicted path, from the finest reading of the last minute: the 1-second candles and
    // the live curve's changes after them.
    // It is read afresh every PATH_EVERY_MS, not on every tick, so its shape holds steady between
    // reads instead of twitching with each trade; in between it runs from the line's latest point.
    let path: PathStep[] = [];
    if (pathing && secondRead?.candles?.length) {
      const fine = held(stitch([...runs, runOf(secondRead.candles, 1_000)], bounds.live ? tail.ticks : []));
      const end = fine[fine.length - 1];
      if (end) {
        const slot = Math.floor(end.t / PATH_EVERY_MS);
        const kept = guessRef.current;
        const guess =
          kept && kept.mint === mint && kept.slot === slot
            ? kept.guess
            : guessPath(fine, end.t, secondRead.candles);
        guessRef.current = { mint, slot, guess };
        const start = source[source.length - 1]!;
        if (guess) path = pathFrom(guess, start);
      }
    }
    return {
      path,
      // A call is priced from a fresh quote (its anchor), so its price goes on the line at its
      // time: the "Called" marker then sits on the price the call and its grade start from.
      points: callPriced ? withCallPoint(line, { t: alertAt, v: alertMcap }) : line,
      extent,
      fromCandles,
      step,
      // Whether the view runs to the latest reading (Model View's window can end before it).
      live: bounds.live,
      latest: source[source.length - 1]!.v,
      latestAt: source[source.length - 1]!.t,
      // The candles in view for the volume lane, each stretch from one width only.
      candles: stitchVolume(runs).filter((k) => k.t + (k.w ?? 60_000) >= from && k.t <= to),
    };
  }, [
    data,
    bounds,
    quarter,
    second,
    secondRead,
    pathing,
    tail.ticks,
    tail.source,
    alertAt,
    alertMcap,
    callPriced,
    zoom,
    tail.readAt,
    mint,
  ]);

  // The scans' buy and sell counts, for the buy share in the chart's readouts.
  const flow = useMemo<ScanFlow[]>(
    () =>
      (data?.marketCap ?? []).flatMap((p) =>
        p.buys != null && p.sells != null ? [{ t: p.t, buys: p.buys, sells: p.sells }] : [],
      ),
    [data],
  );

  const latestMcap = view?.live ? view.latest : (data?.marketCap[data.marketCap.length - 1]?.usd ?? null);
  // When that market cap was read: the share card stamps this, not the moment it is drawn.
  const latestMcapAt = view?.live ? view.latestAt : (data?.marketCap[data.marketCap.length - 1]?.t ?? null);
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

  const tradePanel =
    trading && pro ? (
      <TradePanel
        owner={pro}
        mint={mint}
        symbol={card.token.symbol ?? "tokens"}
        name={card.token.name ?? null}
        position={position.data}
        positionStaleAt={position.error && position.data ? position.at : null}
        summary={summary}
        nowMcap={latestMcap}
        nowMcapAt={latestMcapAt}
        onTraded={position.reload}
        closeOnly={closeOnly}
        graceEndsAt={graceEndsAt}
        delayed={delayed}
      />
    ) : null;
  const streaming = isStreaming(tail);
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
          {delayed && !!bounds?.live && view && view.points.length >= 2 && (
            <DelayBadge updatedAt={updatedAt} everyMs={everyMs} />
          )}
          <span className="tm-ranges" role="group" aria-label="Chart range">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`tm-range${shownRange === r.id ? " on" : ""}`}
                aria-pressed={shownRange === r.id}
                title={r.title}
                onClick={() => pickRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </span>
          {labeled.length > 0 && (
            <button
              type="button"
              className={`cm-link${customizing ? " on" : ""}`}
              aria-expanded={customizing}
              title="Choose which labeled wallets' trades the chart marks (Customize › Chart wallet trades)"
              onClick={() => setCustomizing((o) => !o)}
            >
              <SlidersIcon size={12} /> Wallet trades
              <span className="num">{markPrefs.on ? marks.length : "off"}</span>
            </button>
          )}
        </h4>
        <CustomizeDrawer open={customizing} onClose={closeCustomize} section={CHART_MARKS_SECTION} nested />
        {!data && !error && (
          <ChartSkeleton height={height + CHART_CHROME_PX}>Loading the chart…</ChartSkeleton>
        )}
        {locked && (
          <p className="tm-locked muted small">
            <LockIcon size={14} /> {locked}
          </p>
        )}
        {error && !data && !locked && (
          <p className="error small">Couldn&apos;t load the chart: {error.message}</p>
        )}
        {data && (!view || view.points.length < 2) && (
          <p className="muted small tm-chart-empty">
            No trades to chart yet{shownRange !== "all" ? " in this view" : ""}.
          </p>
        )}
        {view && view.points.length >= 2 && (
          <>
            <PriceChart
              points={view.points}
              stepMs={view.step}
              events={events}
              candles={view.candles}
              flow={flow}
              live={view.live}
              now={view.latest}
              marks={marks}
              height={height}
              trades={chartTrades}
              entry={entry}
              extent={view.extent}
              zoom={zoom}
              onZoom={setZoom}
              kind={kind}
              onKind={setKind}
              pinEnd={shownRange === "trading"}
              // Trading keeps its own candle size, 1-second candles until another is picked there
              // (user ask 2026-10-19); All keeps the one picked before the views split.
              tfScope={shownRange === "trading" ? "trading" : undefined}
              defaultTimeframe={shownRange === "trading" ? 1_000 : null}
              path={view.path}
              ariaLabel={`${tokenLabel(card.token)} market cap from ${usd(view.points[0]!.v)} to ${usd(view.points[view.points.length - 1]!.v)}`}
            />
            {view.path.length > 1 && (
              <p className="faint small tm-chart-src">
                Right of the dashed line: the next minute (experimental). Shaded is where the price landed
                about 8 times in 10 in testing, read from the last minute&apos;s trading; the dotted middle is
                a rough guess. Not advice.
              </p>
            )}
          </>
        )}
      </section>
      {inTerminal
        ? tradeSlot && createPortal(tradePanel ?? (proState?.pro ? null : <ProModePrompt />), tradeSlot)
        : tradePanel}
    </>
  );
}

/** The rail's Trade place without Pro Mode (user pick 2026-10-18): what Pro Mode adds, and where to get it. */
function ProModePrompt() {
  return (
    <section className="sage-card tm-term-pro" aria-label="Pro Mode">
      <h4>
        <CrownIcon size={14} /> Trade here with Pro Mode
      </h4>
      <ul>
        {PRO_MODE_PERKS.slice(0, 3).map((p) => (
          <li key={p.title}>
            <b>{p.title}.</b> <span className="muted">{p.text}</span>
          </li>
        ))}
      </ul>
      {/* Opened from the Scope board only, so the host's close is this window's. */}
      <a className="tm-term-pro-go" href="#settings" onClick={closeTokenModal}>
        See Pro Mode in Settings
      </a>
    </section>
  );
}

/** The moment `value` last changed (a poll's new answer), null before it has one. */
function useArrivedAt(value: unknown): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (value != null) setAt(Date.now());
  }, [value]);
  return at;
}

/**
 * The header's "Delayed" pill when the coin isn't getting instant updates (user ask 2026-10-18):
 * its tooltip (a tap on a phone, touchTips.ts) says why, when the chart last brought new prices and
 * when it reads again. It ticks on its own, so the chart doesn't redraw every second.
 */
function DelayBadge({ updatedAt, everyMs }: { updatedAt: number | null; everyMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const why = "it isn't trading on a Pump.fun bonding curve or its PumpSwap pool";
  const clock = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const next = updatedAt !== null ? Math.ceil((updatedAt + everyMs - now) / 1_000) : null;
  const when =
    updatedAt !== null
      ? ` Updated ${clock(updatedAt)} · ${next !== null && next > 0 ? `next in ~${next}s` : "updating now"}.`
      : "";
  const text = `Delayed chart: this coin isn't getting instant updates (${why}), so the chart refreshes about every ${everyMs / 1_000} seconds.${when}`;
  return (
    <span className="tm-delay" title={text} aria-label={text}>
      <ClockIcon size={11} /> Delayed
    </span>
  );
}

/**
 * A view's window over the minute data, running to now: the whole history for All, the last
 * TRADING_SPAN_MS for Trading (all of it for a coin younger than that).
 */
function viewBounds(data: TokenChart, range: Range): { from: number; to: number; live: boolean } | null {
  const times = data.candles?.length ? data.candles.map((k) => k.t + 60_000) : data.marketCap.map((p) => p.t);
  if (times.length === 0) return null;
  const first = Math.min(times[0]!, data.candles?.[0]?.t ?? Infinity);
  const last = times[times.length - 1]!;
  const to = Math.max(last, Date.now());
  const from = range === "all" ? first : Math.max(first, to - TRADING_SPAN_MS);
  return { from, to, live: true };
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
  const where = tail.venue === "pool" ? "PumpSwap pool" : "bonding curve";
  const how =
    tail.source === "stream"
      ? `every price change in its ${where}, block by block, from the Helius stream`
      : `the ${where}, read every ${LIVE_POLL_MS / 1_000} seconds (the stream is catching up)`;
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

const TAG_TEXT: Record<FlaggedWallet["tags"][number], { text: string; tone: string }> = {
  creator: { text: "Dev", tone: "dev" },
  risky: { text: "Risky", tone: "risky" },
  dumper: { text: "Known dumper", tone: "risky" },
  linked: { text: "Linked", tone: "linked" },
  kol: { text: "KOL", tone: "kol" },
  winner: { text: "Winner", tone: "winner" },
  side: { text: "KOL side", tone: "side" },
  tracked: { text: "Tracked", tone: "kol" },
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
function WalletsCard({
  wallets: every,
  holders,
  defaultOpen = false,
}: {
  wallets: FlaggedWallet[];
  /** The latest scan's holders: who holds the coin now. */
  holders: ReadonlySet<string>;
  defaultOpen?: boolean;
}) {
  const [all, setAll] = useState(false);
  // Folded to its heading until opened (user ask 2026-10-16); the map marks these wallets too. The
  // Scope terminal's tab opens it, as the list is all the tab holds.
  const [open, setOpen] = useState(defaultOpen);
  // Current holders first (user ask 2026-10-19): the labeled wallets in the coin now, with every
  // labeled wallet that traded it a click away.
  const [scope, setScope] = useState<"current" | "all">("current");
  const bodyId = useId();
  const current = useMemo(() => every.filter((w) => holdsNow(w, holders)), [every, holders]);
  const wallets = scope === "current" ? current : every;
  const shown = all ? wallets : wallets.slice(0, 6);
  // One read names the whole list (and the funders its Linked tags mention).
  const names = useWalletNames(useMemo(() => every.flatMap((w) => [w.wallet, w.funder ?? null]), [every]));
  return (
    <section className={`sage-card tm-wallets${open ? "" : " folded"}`}>
      <FoldHead open={open} onToggle={() => setOpen((o) => !o)} controls={bodyId}>
        Labeled wallets
        <span className="sage-tag">{wallets.length}</span>
        <span className="tm-h4-meta muted small">trading this coin</span>
      </FoldHead>
      {open && (
        <div id={bodyId}>
          <div className="fw-scope">
            <span className="segmented small" role="radiogroup" aria-label="Show">
              {(
                [
                  ["current", "Current holders", current.length],
                  ["all", "All traders", every.length],
                ] as const
              ).map(([id, label, n]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={scope === id}
                  className={scope === id ? "on" : ""}
                  title={
                    id === "current"
                      ? "On the latest scan's holder list, or bought in and hasn't sold"
                      : "Every labeled wallet that traded this coin"
                  }
                  onClick={() => setScope(id)}
                >
                  {label} <span className="num muted">{n}</span>
                </button>
              ))}
            </span>
          </div>
          {wallets.length === 0 ? (
            <p className="muted small fw-none">
              None of them holds the coin now, as far as the latest scan and their trades show.{" "}
              <button type="button" className="tm-link" onClick={() => setScope("all")}>
                Show all {every.length} traders
              </button>
            </p>
          ) : (
            <div className="fw-table" role="table" aria-label="Labeled wallets">
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
                const tone =
                  w.score === null ? "none" : w.score >= 70 ? "high" : w.score >= 40 ? "mid" : "low";
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
                                  ? `Sold into the stop on ${w.dumps} of its alerted coins (4+, three quarters of them, 10+ coins on record)`
                                  : t === "winner"
                                    ? `Sold 3 or more of the coins it bought at 2x or better for ${MIN_WIN_SOL}+ SOL profit, at least twice as often as the market, with 10+ coins on record`
                                    : t === "kol" && w.knownSideOf
                                      ? `One of ${w.kol || "a KOL"}'s own wallets, not its main one`
                                      : undefined
                            }
                          >
                            {t === "side" && w.side
                              ? `${w.side.kolName ?? "KOL"} ${w.side.kind === "funded" ? (w.side.tracked === "tracked" ? "Funded Wallet" : "KOL Funded Wallet") : "Probable Side"}`
                              : t === "tracked" && w.tracked && names[w.wallet]?.name !== w.tracked
                                ? `Tracked: ${w.tracked}`
                                : t === "kol" && w.knownSideOf
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
          )}
          {wallets.length > 6 && (
            <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${wallets.length}`}
            </button>
          )}
          <p className="faint small tm-wallets-note">
            Risky: a score of 70+ from selling into earlier alerts&apos; stops. Linked: funded by the same
            wallet as other top holders. KOL: a known KOL&apos;s wallet. Winner: sells its coins at 2x or
            better for {MIN_WIN_SOL}+ SOL profit at least twice as often as the market. KOL and Winner mark
            presence only, not a buy signal. SOL is what each wallet put into and took out of this coin.
          </p>
        </div>
      )}
    </section>
  );
}

/** The labeled wallets' groups in the Order flow tab, in the order they list. */
const FLOW_GROUPS: readonly { kind: MarkerKind; label: string }[] = [
  { kind: "kol", label: "KOLs & sides" },
  { kind: "dev", label: "Dev" },
  { kind: "risky", label: "Risky & dumpers" },
  { kind: "winner", label: "Winners" },
  { kind: "linked", label: "Linked" },
];

/** Scan points the flow-over-time bars show at most, the newest. */
const FLOW_BARS = 24;

const solShort = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/**
 * More of the coin's order flow for the Scope terminal's tab (user ask 2026-10-19), from what the
 * page already read: buys against sells at each scan, where the labeled wallets' SOL went, how the
 * top holders got in and what they've sold, and whether the launch's first buyers and the dev hold.
 */
function FlowMore({
  points,
  flagged,
  entries,
  snap,
}: {
  points: TokenChart["marketCap"];
  flagged: readonly FlaggedWallet[];
  entries: Readonly<Record<string, HolderEntry>>;
  snap: Pick<
    Card["snapshot"],
    "firstBuyersHolding" | "firstBuyersSeen" | "firstBuyersHoldingCut" | "devHolding"
  > | null;
}) {
  const bars = useMemo(
    () =>
      points
        .filter((p) => typeof p.buys === "number" && typeof p.sells === "number" && p.buys + p.sells > 0)
        .slice(-FLOW_BARS) as { t: number; buys: number; sells: number }[],
    [points],
  );
  const groups = useMemo(
    () =>
      FLOW_GROUPS.flatMap((g) => {
        const ws = flagged.filter((w) => kindOf(w) === g.kind);
        if (ws.length === 0) return [];
        const solIn = ws.reduce((t, w) => t + w.solIn, 0);
        const solOut = ws.reduce((t, w) => t + w.solOut, 0);
        return [{ ...g, count: ws.length, holding: ws.filter((w) => w.solOut === 0).length, solIn, solOut }];
      }),
    [flagged],
  );
  const holders = useMemo(() => {
    const es = Object.values(entries);
    if (es.length === 0) return null;
    const bought = es.filter((e) => e.buys > 0);
    return {
      read: es.length,
      firstMinute: bought.filter((e) => e.afterLaunchS !== null && e.afterLaunchS < 60).length,
      firstBuyers: bought.filter((e) => e.firstBuyerRank !== null && e.firstBuyerRank <= 25).length,
      transfer: es.filter((e) => e.buys === 0).length,
      holdingAll: bought.filter((e) => e.sells === 0 || (e.soldShare ?? 0) <= 0).length,
      soldAll: bought.filter((e) => (e.soldShare ?? 0) >= 0.995).length,
      solIn: es.reduce((t, e) => t + e.solIn, 0),
      solOut: es.reduce((t, e) => t + e.solOut, 0),
    };
  }, [entries]);
  const peak = Math.max(1, ...bars.map((b) => b.buys + b.sells));
  const firstHolding = snap?.firstBuyersHoldingCut ?? snap?.firstBuyersHolding ?? null;
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="tm-flow-more">
      {bars.length >= 2 && (
        <section className="sage-card" aria-label="Buys and sells over time">
          <h4>
            Buys and sells over time
            <span className="tm-h4-meta small muted">5-minute counts at each scan</span>
          </h4>
          <div className="tm-fm-bars" role="img" aria-label="Buys and sells at each scan">
            {bars.map((b) => (
              <span
                key={b.t}
                className="tm-fm-bar"
                title={`${hm(b.t)}: ${b.buys} buys, ${b.sells} sells (${pct((b.buys / (b.buys + b.sells)) * 100)} buys)`}
              >
                <span className="sell" style={{ height: `${(b.sells / peak) * 100}%` }} />
                <span className="buy" style={{ height: `${(b.buys / peak) * 100}%` }} />
              </span>
            ))}
          </div>
          <div className="tm-fm-axis small muted num">
            <span>{hm(bars[0]!.t)}</span>
            <span>{hm(bars[bars.length - 1]!.t)}</span>
          </div>
        </section>
      )}
      {groups.length > 0 && (
        <section className="sage-card" aria-label="Labeled wallets' SOL">
          <h4>
            Labeled wallets&apos; SOL
            <span className="tm-h4-meta small muted">in and out of this coin</span>
          </h4>
          <div className="tm-fm-table" role="table">
            <div className="tm-fm-row head" role="row">
              <span role="columnheader">Wallets</span>
              <span role="columnheader">Holding</span>
              <span role="columnheader">SOL in</span>
              <span role="columnheader">SOL out</span>
              <span role="columnheader">Net</span>
            </div>
            {groups.map((g) => {
              const net = g.solOut - g.solIn;
              return (
                <div key={g.kind} className="tm-fm-row" role="row">
                  <span role="cell">
                    <i className={`pc-swatch k-${g.kind}`} aria-hidden="true" /> {g.label}{" "}
                    <span className="muted num">{g.count}</span>
                  </span>
                  <span role="cell" className="num" title="Bought in and haven't sold">
                    {g.holding}
                  </span>
                  <span role="cell" className="num">
                    {solShort(g.solIn)}
                  </span>
                  <span role="cell" className="num">
                    {solShort(g.solOut)}
                  </span>
                  <span
                    role="cell"
                    className={`num ${g.solOut > 0 ? (net >= 0 ? "up" : "down") : "faint"}`}
                    title={g.solOut > 0 ? "SOL out less SOL in" : "Nothing sold yet"}
                  >
                    {g.solOut > 0 ? `${net >= 0 ? "+" : "-"}${solShort(Math.abs(net))}` : "holding"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {(holders || firstHolding !== null || (snap?.devHolding ?? null) !== null) && (
        <section className="sage-card" aria-label="How the holders got in">
          <h4>How the holders got in</h4>
          <dl className="tm-fm-stats">
            {holders && (
              <>
                <div title="Top holders whose first buy came within a minute of the launch">
                  <dt>First-minute buyers</dt>
                  <dd className="num">
                    {holders.firstMinute}
                    <span className="muted">/{holders.read}</span>
                  </dd>
                </div>
                <div title="Top holders among the launch's first 25 buyers">
                  <dt>First 25 buyers</dt>
                  <dd className="num">
                    {holders.firstBuyers}
                    <span className="muted">/{holders.read}</span>
                  </dd>
                </div>
                <div title="Top holders that got the coin by transfer, never buying it">
                  <dt>By transfer</dt>
                  <dd className="num">
                    {holders.transfer}
                    <span className="muted">/{holders.read}</span>
                  </dd>
                </div>
                <div title="Top holders that bought and haven't sold any">
                  <dt>Holding all</dt>
                  <dd className="num">
                    {holders.holdingAll}
                    <span className="muted">/{holders.read}</span>
                  </dd>
                </div>
                <div title="Top holders that bought and have sold all of it">
                  <dt>Sold all</dt>
                  <dd className="num">
                    {holders.soldAll}
                    <span className="muted">/{holders.read}</span>
                  </dd>
                </div>
                <div title="What the top holders put into the coin and took out, from its trade tape">
                  <dt>Holders&apos; SOL</dt>
                  <dd className="num">
                    {solShort(holders.solIn)} in{" "}
                    <span className="muted">/ {solShort(holders.solOut)} out</span>
                  </dd>
                </div>
              </>
            )}
            {firstHolding !== null && snap?.firstBuyersSeen ? (
              <div title="Of the launch's first buyers, how many still hold 0.1% of the supply or more">
                <dt>Launch buyers holding</dt>
                <dd className="num">
                  {firstHolding}
                  <span className="muted">/{snap.firstBuyersSeen}</span>
                </dd>
              </div>
            ) : null}
            {(snap?.devHolding ?? null) !== null && (
              <div>
                <dt>Dev</dt>
                <dd className={snap!.devHolding ? "" : "down"}>{snap!.devHolding ? "Holding" : "Sold"}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}

/**
 * Whether a labeled wallet holds the coin now: on the latest scan's holder list, or it bought in and
 * hasn't sold (a wallet that sold some and isn't on the list can't be told apart from one that sold out).
 */
function holdsNow(
  w: Pick<FlaggedWallet, "wallet" | "solIn" | "solOut">,
  holders: ReadonlySet<string>,
): boolean {
  return holders.has(w.wallet) || (w.solIn > 0 && w.solOut === 0);
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
          · {at !== null ? "at the alert" : `scored ${ago(new Date(data.moment.at), Date.now())}`}
        </span>
      </p>
      <ul className="tm-why-seats">
        {shown.map((x) => (
          <li key={x.id} className={x.calls ? "calls" : ""}>
            <span className="tm-why-name">{x.name}</span>
            <span
              className="tm-why-rank small"
              title="Where this coin ranked among the model's own scores of the last day, against the share it alerts on"
            >
              {x.topPct !== null && x.callsTopPct !== null ? (
                <>
                  {x.calls ? "Over its line," : "Ranked it"} {topText(x.topPct)}
                  <span className="faint"> · alerts on {topText(x.callsTopPct)}</span>
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
            ? "It passed the safety screen inside the market-cap band. No model has flagged it."
            : card.filter
              ? `Your filter "${card.filter.name}" caught it. No model has flagged it.`
              : "Your filter caught it. No model has flagged it."}
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
      <h4>Why it was flagged</h4>
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
                title="Of recent out-of-sample alerts ranked like this one, the share that doubled within 15 minutes"
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
            <strong>{ai.decision === "buy" ? "PASS" : ai.decision === "no_buy" ? "REJECT" : "error"}</strong>
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
          <XLinkPreview href={x.url!} target="_blank" rel="noreferrer">
            {x.author?.handle ? `@${x.author.handle}` : "X post"}
            <ExternalIcon size={11} />
          </XLinkPreview>
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
        <AtReadTime at={r.trendAt ?? r.analyzedAt} />
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
        <AtReadTime at={r.analyzedAt} />
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
            : "Not trending: nothing it refers to is up on Wikipedia, Google Trends, the news or X when it was read."}
        </p>
      )}
    </section>
  );
}
