import { hasHolderList, holderFreshness, linkedCountText, pickReading } from "../bubbleMap";
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
import { ApiError, type Card, type Snapshot } from "../api";
import { usePolling } from "../hooks";
import { ago, change, minutes, multiple, pct, shortAddress, tokenLabel, tokenThumb, usd } from "../format";
import { matchOutcome, outcomeAt, outcomeBadge } from "../outcome";
import { openSage } from "../sage";
import { QUICK_LINK_SITES, useAppearance } from "../appearance";
import { useShowNarrativeNote } from "../narrativeNote";
import { scoreTone, scoreToneColor, useScoreWeights } from "../scoreWeights";
import {
  candleCloses,
  linePoints,
  withCallPoint,
  MARKER_KINDS,
  pointWidthMs,
  type MarkerKind,
  type MarkerTrade,
  type Point,
} from "../priceChart";
import {
  cardReadings,
  cexCountText,
  LINKED_WARN_PCT,
  linkedSeed,
  nowReading,
  recordedPeakOf,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_SNIPER_WALLET_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  WalletStat,
} from "./AlertCard";
import { MARKER_LABEL, PriceChart, type ChartEvent } from "./PriceChart";
import {
  categoryText,
  CrowdChart,
  LINEAGE,
  LineageText,
  pct0,
  TREND_SOURCE,
  words,
  type SageRead,
  type SageView,
} from "./SageView";
import { WeekChart } from "./WeekChart";
import { Skeleton } from "./Charts";
import { openWallet } from "../walletModal";
import { BubbleMapSection } from "./BubbleMap";
import { TopHolders } from "./TopHolders";
import { WalletText } from "./WalletText";
import { useWalletNames, walletText } from "../walletNames";
import {
  BrainIcon,
  ChartIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  LockIcon,
  RobotIcon,
  SageIcon,
} from "./Icons";

/** Mirrors apps/api/src/routes/tokens.ts TokenChart. */
interface TokenChart {
  mint: string;
  /** Pump.fun's minute candles as market cap (apps/api/src/tokenChart.ts McapCandle). */
  candles: { t: number; o: number; h: number; l: number; c: number }[] | null;
  marketCap: { t: number; usd: number }[];
  /** Absent from an API older than this page. */
  tape?: { status: string; anchorAt: number; windowEnd: number; readAt: number } | null;
  /** When the coin's trades were last read live, before a call; null when never. */
  live?: { readAt: number } | null;
  wallets?: FlaggedWallet[];
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
  solIn: number;
  solOut: number;
  heldPct: number | null;
  trades: [number, 1 | -1, number | null][];
}

/** The marker colour a flagged wallet gets: the creator first, then a risky one, a KOL, a winner, else linked. */
function kindOf(w: FlaggedWallet): MarkerKind {
  if (w.tags.includes("creator")) return "dev";
  if (w.tags.includes("risky") || w.tags.includes("dumper")) return "risky";
  if (w.tags.includes("kol")) return "kol";
  if (w.tags.includes("winner")) return "winner";
  return "linked";
}

type Range = "model" | "alert" | "1h" | "all";
const RANGES: { id: Range; label: string; title?: string }[] = [
  {
    id: "model",
    label: "Model View",
    title: "Up to 5 minutes either side of the call: what the model had to go on, and what came next",
  },
  { id: "alert", label: "From alert" },
  { id: "1h", label: "1h" },
  { id: "all", label: "All" },
];
/** How much of the run-up the "From alert" view shows before the alert. */
const LEAD_IN_MS = 10 * 60_000;
/** How far either side of the call "Model View" reaches (never before the first trade). */
const MODEL_SPAN_MS = 5 * 60_000;
/** Points drawn at most: enough for a smooth line, few enough that each one stays hoverable. */
const MAX_POINTS = 200;
const CHART_POLL_MS = 30_000;

const LINKS = [
  { label: "DexScreener", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump.fun", href: (m: string) => `https://pump.fun/coin/${m}` },
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
}: {
  card: Card;
  now: number;
  onClose: () => void;
  utility?: UtilityMode | null;
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
      // Rendered through a portal from the card, so React would bubble the click on to the card's
      // own click handler (which opens this modal); it stops here.
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <UtilityContext.Provider value={utility}>
        <TokenBody card={card} now={now} onClose={() => ref.current?.close()} />
      </UtilityContext.Provider>
    </dialog>
  );
}

function TokenBody({ card, now, onClose }: { card: Card; now: number; onClose: () => void }) {
  const mint = card.token.mintAddress;
  const s = card.snapshot;
  const curated = card.curated;
  const outcome = curated ? outcomeAt(curated.outcome, curated.alertedAt, now) : matchOutcome(card, now);
  const badge = outcomeBadge(outcome);
  const showVerdict = outcome !== null && !(outcome.status === "watching" && !outcome.hit2x);
  const alertAt = Date.parse(curated?.alertedAt ?? card.matchedAt);
  const alertMcap = s.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  const { pct: recordedPeak } = recordedPeakOf(card);
  const peak = move !== null && move > 0 ? Math.max(recordedPeak ?? 0, move) : recordedPeak;
  const hasPeak = peak !== null && peak > 0;
  const img = card.token.imageUrl?.startsWith("https://") ? tokenThumb(card.token.imageUrl, 160) : null;
  const [imgFailed, setImgFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const { quickLinks } = useAppearance();
  const trade = QUICK_LINK_SITES.filter((l) => quickLinks.includes(l.id));
  const label = tokenLabel(card.token);
  const utility = useContext(UtilityContext);
  const what = utility ? "Scanned" : card.kind === "stream" ? "Passed screen" : curated ? "Called" : "Alert";
  // One poll for the chart and the wallet sections that read the same answer.
  const chart = usePolling<TokenChart>(`${useTokenApi(mint)}/chart`, CHART_POLL_MS);
  const flagged = useMemo(() => chart.data?.wallets ?? [], [chart.data]);
  const linked = useHolderReading(card, mint, !!utility);
  const ids = useId().replace(/:/g, "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(bodyRef, ids);

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="about-body tm-body" ref={bodyRef}>
      <header className="tm-head">
        <div className="tm-token">
          <div className={`avatar-wrap tone-${badge.tone}`}>
            {img && !imgFailed ? (
              <img
                className="avatar tm-avatar"
                src={img}
                alt=""
                width={56}
                height={56}
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
              />
            ) : (
              <span className="avatar placeholder tm-avatar">{label.replace("$", "").slice(0, 2)}</span>
            )}
          </div>
          <div className="tm-title-block">
            <h2 id="tm-title" className="tm-title" tabIndex={-1} autoFocus>
              {label}
              {card.token.name && card.token.symbol && <span className="token-name"> {card.token.name}</span>}
            </h2>
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
                <span className="pill pill-mine">{card.filter.name}</span>
              )}
            </div>
          </div>
        </div>
        <div className="tm-actions">
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
        <nav className="tm-nav" aria-label="Sections">
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`tm-nav-btn${active === x.id ? " on" : ""}`}
              aria-current={active === x.id ? "true" : undefined}
              onClick={() =>
                document
                  .getElementById(`${ids}-${x.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {utility && x.id === "call" ? "Market" : x.label}
            </button>
          ))}
        </nav>
      </header>

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
          <span className="num">{minutes(s.ageMinutes)}</span>
          {s.liquidityUsd != null && <small className="num muted">Liq {usd(s.liquidityUsd)}</small>}
        </div>
      </section>

      <section id={`${ids}-chart`} className="tm-group" aria-label="Chart">
        <ChartCard
          card={card}
          chart={chart}
          flagged={flagged}
          alertAt={alertAt}
          alertMcap={alertMcap}
          what={what}
        />
      </section>

      <section id={`${ids}-holders`} className="tm-group" aria-labelledby={`${ids}-holders-h`}>
        <GroupLabel id={`${ids}-holders-h`}>Holders</GroupLabel>
        {linked && hasHolderList(linked) && <HolderFreshness takenAt={linked.takenAt} now={now} />}
        <div className="tm-holders">
          <BubbleMapSection token={card.token} snapshot={linked} />
          <TopHolders snapshot={linked} flagged={flagged} />
        </div>
        {flagged.length > 0 && <WalletsCard wallets={flagged} />}
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

      <section id={`${ids}-sage`} className="tm-group" aria-labelledby={`${ids}-sage-h`}>
        <GroupLabel id={`${ids}-sage-h`}>TokenSage</GroupLabel>
        <SageSection mint={mint} />
      </section>

      <footer className="tm-foot">
        <button className="mint" onClick={copy} title="Copy mint address">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "Copied" : shortAddress(mint)}
        </button>
        <nav className="card-links">
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
        </nav>
      </footer>
    </div>
  );
}

/** The modal's sections, in the order they appear, for the nav under the header. */
const SECTIONS = [
  { id: "chart", label: "Chart" },
  { id: "holders", label: "Holders" },
  { id: "call", label: "The call" },
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

/** SOL with two decimals under 10, none above. */
const solText = (v: number) => `${v.toFixed(v >= 10 ? 0 : 2)} SOL`;

/**
 * Whether the flagged wallets bought or sold more in the chart's view: a green and red bar split by
 * SOL (by trade count when no amount is known), with the net in words.
 */
function FlowSummary({ trades }: { trades: readonly MarkerTrade[] }) {
  if (trades.length === 0) return null;
  const buys = trades.filter((t) => t.side === 1);
  const sells = trades.filter((t) => t.side === -1);
  const sum = (ts: readonly MarkerTrade[]) => ts.reduce((s, t) => s + (t.sol ?? 0), 0);
  const bySol = trades.some((t) => (t.sol ?? 0) > 0);
  const b = bySol ? sum(buys) : buys.length;
  const v = bySol ? sum(sells) : sells.length;
  const buyShare = b + v > 0 ? b / (b + v) : 0.5;
  const net = b - v;
  const even = Math.abs(net) <= (b + v) * 0.05;
  const verdict = even
    ? "Buying and selling about even"
    : bySol
      ? `Net ${net > 0 ? "buying" : "selling"} ${solText(Math.abs(net))}`
      : `More ${net > 0 ? "buys" : "sells"} than ${net > 0 ? "sells" : "buys"}`;
  return (
    <div className={`tm-bal ${even ? "even" : net > 0 ? "buying" : "selling"}`}>
      <div className="tm-bal-head">
        <span className="tm-bal-title">Flagged wallets in view</span>
        <strong className="tm-bal-verdict">{verdict}</strong>
      </div>
      <div
        className="tm-bal-bar"
        role="img"
        aria-label={`${Math.round(buyShare * 100)}% buys, ${Math.round((1 - buyShare) * 100)}% sells`}
      >
        <span className="buy" style={{ flexGrow: Math.max(0.02, buyShare) }} />
        <span className="sell" style={{ flexGrow: Math.max(0.02, 1 - buyShare) }} />
      </div>
      <div className="tm-bal-sides small num">
        <span className="buy">
          {buys.length} buy{buys.length === 1 ? "" : "s"}
          {bySol ? ` · ${solText(b)}` : ""}
        </span>
        <span className="sell">
          {sells.length} sell{sells.length === 1 ? "" : "s"}
          {bySol ? ` · ${solText(v)}` : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * The reading the bubble map and the top holders draw: the card's newest that kept a holder list,
 * else the newest of the coin's scans that did (fetched; a lookup's card is already its latest
 * scan). Undefined while that loads, null when no scan has a list.
 */
function useHolderReading(card: Card, mint: string, lookup: boolean): Snapshot | null | undefined {
  const seed = linkedSeed(card)?.snapshot ?? null;
  // Newest first, so the section follows the coin's scans and its "Last updated" means it.
  const own = [card.latestSnapshot, seed, card.snapshot].find((s) => s && hasHolderList(s)) ?? null;
  const [fetched, setFetched] = useState<{ mint: string; snapshot: Snapshot | null } | null>(null);
  const fetch = !own && !lookup;
  useEffect(() => {
    if (!fetch) return;
    let live = true;
    cachedGet<{ snapshots?: Snapshot[] }>(`/tokens/${encodeURIComponent(mint)}`, 60_000)
      .then((d) => live && setFetched({ mint, snapshot: pickReading(d.snapshots ?? []) ?? seed }))
      .catch(() => live && setFetched({ mint, snapshot: seed }));
    return () => {
      live = false;
    };
  }, [fetch, mint]);
  if (own) return own;
  if (!fetch) return seed;
  return fetched?.mint === mint ? fetched.snapshot : undefined;
}

/** When the holder reading was saved, and when the next is due (user ask 2026-10-13). */
function HolderFreshness({ takenAt, now }: { takenAt: string; now: number }) {
  const { last, next } = holderFreshness(takenAt, now);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <p className="tm-holders-when">
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
  if (error instanceof ApiError && (error.status === 401 || error.status === 402)) {
    return `The ${what} comes with access. Connect a wallet with access to see it.`;
  }
  return null;
}

function ChartCard({
  card,
  chart: { data, error },
  flagged,
  alertAt,
  alertMcap,
  what,
}: {
  card: Card;
  chart: { data: TokenChart | null; error: Error | null };
  flagged: FlaggedWallet[];
  alertAt: number;
  alertMcap: number;
  what: string;
}) {
  const utility = useContext(UtilityContext);
  // A lookup has no call to look around or start from: it opens on the coin's whole history.
  const [range, setRange] = useState<Range>(utility ? "all" : "model");
  const [hidden, setHidden] = useState<ReadonlySet<MarkerKind>>(() => new Set());
  const [height, setHeight] = useState(() => (window.innerWidth <= 640 ? 210 : 260));
  useEffect(() => {
    const onResize = () => setHeight(window.innerWidth <= 640 ? 210 : 260);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const events = useMemo<ChartEvent[]>(() => {
    const out: ChartEvent[] = [{ t: alertAt, label: what, mcap: alertMcap > 0 ? alertMcap : null }];
    // Every other model that called it, once each, at its own call time.
    for (const c of card.curated?.calledBy ?? []) {
      const t = Date.parse(c.alertedAt);
      if (!Number.isFinite(t) || Math.abs(t - alertAt) < 30_000) continue;
      out.push({ t, label: c.modelName ?? "Model" });
    }
    return out;
  }, [alertAt, alertMcap, what, card.curated?.calledBy]);

  // A call card's alert price is the call's own anchor; a filter alert's can be a scan's reading.
  const callPriced = card.kind === "curated" && alertMcap > 0;
  const view = useMemo(() => {
    if (!data) return null;
    const fromCandles = !!data.candles && data.candles.length > 0;
    // The line runs through each minute's close at the minute's end, else through the scan's readings.
    const source: Point[] = fromCandles
      ? candleCloses(data.candles!)
      : data.marketCap.map((p) => ({ t: p.t, v: p.usd }));
    if (source.length < 2)
      return {
        points: [] as Point[],
        fromCandles,
        step: undefined,
        live: true,
        latest: 0,
        scans: [] as Point[],
      };
    const first = source[0]!.t;
    const last = source[source.length - 1]!.t;
    const from =
      range === "all"
        ? first
        : range === "1h"
          ? last - 3_600_000
          : range === "model"
            ? Math.max(first, alertAt - MODEL_SPAN_MS)
            : // From the alert: unless the data starts after it (then all of it).
              alertAt - LEAD_IN_MS > first
              ? alertAt - LEAD_IN_MS
              : first;
    const to = range === "model" ? alertAt + MODEL_SPAN_MS : last;
    const step = pointWidthMs(Math.min(to, last) - Math.max(from, first) + 60_000, MAX_POINTS);
    const line = linePoints(source, from, step, to);
    return {
      // A call is priced from a fresh quote (its anchor), so its price goes on the line at its
      // time: the "Called" marker then sits on the price the call and its grade start from.
      points: callPriced ? withCallPoint(line, { t: alertAt, v: alertMcap }) : line,
      fromCandles,
      step: fromCandles ? step : undefined,
      // Whether the view runs to the latest reading (Model View's window can end before it).
      live: to >= last,
      latest: source[source.length - 1]!.v,
      // The scans the model read before calling it, drawn as dots in Model View.
      scans:
        range === "model"
          ? data.marketCap.filter((p) => p.t >= from && p.t <= alertAt).map((p) => ({ t: p.t, v: p.usd }))
          : [],
    };
  }, [data, range, alertAt, alertMcap, callPriced]);

  // Model View opens by default; a coin with nothing to draw around its call (too new, or no
  // candles there) falls back to its whole history rather than an empty chart. A range the viewer
  // picked stays put.
  const picked = useRef(false);
  const modelEmpty = range === "model" && !!view && view.points.length < 2;
  useEffect(() => {
    if (modelEmpty && !picked.current) setRange("all");
  }, [modelEmpty]);

  const markers = useMemo<MarkerTrade[]>(
    () =>
      flagged.flatMap((w) => {
        const kind = kindOf(w);
        if (hidden.has(kind)) return [];
        return w.trades.map(([t, side, sol]) => ({ t, side, sol, wallet: w.wallet, kind }));
      }),
    [flagged, hidden],
  );
  // The marker tips name the wallets that traded (the flagged list below reads the same names).
  const names = useWalletNames(useMemo(() => flagged.map((w) => w.wallet), [flagged]));
  const counts = MARKER_KINDS.map((k) => ({ k, n: flagged.filter((w) => kindOf(w) === k).length }));
  const toggle = (k: MarkerKind) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

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
          <span className="tm-ranges" role="group" aria-label="Chart range">
            {RANGES.filter((r) => !utility || r.id !== "model").map((r) => (
              <button
                key={r.id}
                type="button"
                className={`tm-range${range === r.id ? " on" : ""}`}
                aria-pressed={range === r.id}
                title={r.title}
                onClick={() => {
                  picked.current = true;
                  setRange(r.id);
                }}
              >
                {utility && r.id === "alert" ? "From scan" : r.label}
              </button>
            ))}
          </span>
        </h4>
        {!data && !error && <div className="tm-chart-skeleton" style={{ height }} />}
        {locked && (
          <p className="tm-locked muted small">
            <LockIcon size={14} /> {locked}
          </p>
        )}
        {error && !data && !locked && (
          <p className="error small">Couldn&apos;t load the chart: {error.message}</p>
        )}
        {view && view.points.length < 2 && (
          <p className="muted small tm-chart-empty">
            No trades to chart yet{range !== "all" ? " in this range" : ""}.
          </p>
        )}
        {view && view.points.length >= 2 && (
          <PriceChart
            points={view.points}
            stepMs={view.step}
            events={events}
            markers={markers}
            seenUntil={range === "model" ? alertAt : undefined}
            live={view.live}
            now={view.latest}
            scans={view.scans}
            names={names}
            height={height}
            ariaLabel={`${tokenLabel(card.token)} market cap from ${usd(view.points[0]!.v)} to ${usd(view.points[view.points.length - 1]!.v)}`}
          />
        )}
        {range === "model" && view && view.points.length >= 2 && (
          <p className="faint small tm-model-note">
            <i className="tm-scan-dot" aria-hidden="true" />{" "}
            {view.scans.length > 0
              ? `${view.scans.length} scan${view.scans.length === 1 ? "" : "s"} the model read · `
              : ""}
            5 minutes either side of the call; shaded is after it, which the model never saw.
          </p>
        )}
        {data && (
          <div className="tm-legend">
            {flagged.length > 0 ? (
              <>
                {view && view.points.length >= 2 && (
                  <FlowSummary
                    trades={markers.filter(
                      (m) => m.t >= view.points[0]!.t && m.t <= view.points[view.points.length - 1]!.t,
                    )}
                  />
                )}
                <span className="tm-legend-key faint small">
                  <i className="tm-bs buy" aria-hidden="true">
                    B
                  </i>{" "}
                  buy
                  <i className="tm-bs sell" aria-hidden="true">
                    S
                  </i>{" "}
                  sell
                </span>
                {counts
                  .filter((c) => c.n > 0)
                  .map(({ k, n }) => (
                    <button
                      key={k}
                      type="button"
                      className={`tm-chip k-${k}${hidden.has(k) ? " off" : ""}`}
                      aria-pressed={!hidden.has(k)}
                      onClick={() => toggle(k)}
                      title={`${hidden.has(k) ? "Show" : "Hide"} ${MARKER_LABEL[k].toLowerCase()} trades`}
                    >
                      <i className={`pc-swatch k-${k}`} aria-hidden="true" />
                      {MARKER_LABEL[k]}
                      {k !== "dev" && <span className="num">{n}</span>}
                    </button>
                  ))}
                {!data.tape && card.curated && (
                  <span className="faint small tm-legend-note">
                    From trades read before the call. Linked and dev wallets join once its full trade history
                    is read.
                  </span>
                )}
              </>
            ) : (
              <span className="faint small">{walletNote(data.tape ?? null, data.live ?? null, card)}</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Why the chart has no wallet markers. Risky wallets and known dumpers are read live before a
 * call (`live`); the full trade history, which adds linked and dev wallets, is read after it.
 */
function walletNote(tape: TokenChart["tape"], live: TokenChart["live"], card: Card): string {
  const before = live ? "No risky wallets or known dumpers traded it before the call" : null;
  if (tape?.status === "failed") {
    return before
      ? `${before}, and its later trades couldn't be read.`
      : "This coin's trades couldn't be read, so there are no wallet markers.";
  }
  if (tape) {
    return before
      ? "No risky, linked or dev wallets traded it before the call or in the half hour after."
      : "No risky, linked or dev wallets traded it in the half hour after the call.";
  }
  if (before) {
    return card.curated
      ? `${before}. Linked and dev wallets join once its full trade history is read.`
      : `${before}.`;
  }
  return card.curated
    ? "Its trades weren't read before the call. Flagged wallets show once its full trade history is read."
    : "Flagged-wallet trades are read for coins close to a call.";
}

const TAG_TEXT: Record<FlaggedWallet["tags"][number], { text: string; tone: string }> = {
  creator: { text: "Dev", tone: "dev" },
  risky: { text: "Risky", tone: "risky" },
  dumper: { text: "Known dumper", tone: "risky" },
  linked: { text: "Linked", tone: "linked" },
  kol: { text: "KOL", tone: "kol" },
  winner: { text: "Winner", tone: "winner" },
};

/** The flagged wallets behind the markers: what each is, its score, and what it did in the coin. */
function WalletsCard({ wallets }: { wallets: FlaggedWallet[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? wallets : wallets.slice(0, 6);
  // One read names the whole list (and the funders its Linked tags mention).
  const names = useWalletNames(
    useMemo(() => wallets.flatMap((w) => [w.wallet, w.funder ?? null]), [wallets]),
  );
  return (
    <section className="sage-card tm-wallets">
      <h4>
        Flagged wallets
        <span className="sage-tag">{wallets.length}</span>
        <span className="tm-h4-meta muted small">trading this coin</span>
      </h4>
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
                              ? "3 or more of the called coins it bought doubled, 60% of them or more, with 10+ coins on record"
                              : undefined
                      }
                    >
                      {t === "kol" && w.kol && names[w.wallet]?.name !== w.kol
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
        Risky: a score of 70+ from selling into earlier calls&apos; stops. Linked: funded by the same wallet
        as other top holders. SOL is what each wallet put into and took out of this coin.
      </p>
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
  return (
    <section className="sage-card">
      <h4>
        {utility ? (utility.scan === "scanning" ? "Market data (scanning…)" : "At the scan") : "At the alert"}
      </h4>
      <dl className="tm-stats">
        <div>
          <dt>Score</dt>
          <dd className="num" style={tone === null ? undefined : { color: scoreToneColor(tone) }}>
            {s.score == null ? "–" : Math.round(s.score)}
          </dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd className="num">
            {s.holderCount ?? "–"}
            {latest?.holderCount != null && latest.holderCount !== s.holderCount && (
              <small className="muted"> → {latest.holderCount}</small>
            )}
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
          <dd className="num">{pct(s.top10HolderPct)}</dd>
        </div>
        <WalletStat
          label="Fresh"
          value={r.freshPct}
          failsAbove={SAFETY_MAX_FRESH_WALLET_PCT}
          atAlert={r.freshAtAlert !== null}
          explain="top-10 holder wallets first used, or used again after a week or more idle, in the last 24h"
        />
        <WalletStat
          label="Empty"
          value={r.emptyPct}
          failsAt={SAFETY_REJECT_EMPTY_WALLET_PCT}
          atAlert={r.emptyAtAlert !== null}
          explain="top-10 holder wallets with under $25 of other tokens"
        />
        <WalletStat
          label="Top-10 snipers"
          value={r.sniperPct}
          failsAt={SAFETY_REJECT_SNIPER_WALLET_PCT}
          atAlert={r.sniperAtAlert !== null}
          explain="top-10 holder wallets that were among the first 25 buyers after launch"
        />
        <div
          className={
            (r.linkedPct !== null && r.linkedPct >= LINKED_WARN_PCT) ||
            (r.linkedCount !== null && r.linkedCount.linked >= SAFETY_REJECT_LINKED_COUNT)
              ? "risky"
              : undefined
          }
          title={`Top holders one wallet funded, that funded each other, or that were funded within a minute of each other${
            r.linkedPct === null ? "" : `, holding ${pct(r.linkedPct)} of supply`
          }. The safety screen rejects ${SAFETY_REJECT_LINKED_COUNT} or more of the top 25.`}
        >
          <dt>Linked</dt>
          <dd className={r.linkedPct === null ? "muted" : "num"}>
            {r.linkedPct === null ? "Not checked" : (linkedCountText(r.linkedCount) ?? pct(r.linkedPct))}
          </dd>
        </div>
        <div
          className={
            r.cexCount !== null && r.cexCount >= SAFETY_REJECT_CEX_FUNDED_COUNT ? "risky" : undefined
          }
          title={`Of the ${r.cexHolders ?? 20} largest holders, how many were opened from an exchange (or a busy service like a bridge). The safety screen rejects ${SAFETY_REJECT_CEX_FUNDED_COUNT} or more.`}
        >
          <dt>CEX-funded</dt>
          <dd className={r.cexPct === null ? "muted" : "num"}>
            {r.cexPct === null ? "Not checked" : (cexCountText(r.cexCount, r.cexHolders) ?? pct(r.cexPct))}
          </dd>
        </div>
        <div title="How many of the launch's first 25 buyers still hold it">
          <dt>First buyers holding</dt>
          <dd className="num">{r.firstHolding === null ? "–" : `${r.firstHolding}/${r.firstSeen ?? 25}`}</dd>
        </div>
        <div title={r.feeLine ?? undefined}>
          <dt>Dev</dt>
          <dd>{r.devHolding === null ? "–" : r.devHolding ? "Holding" : "Sold"}</dd>
        </div>
      </dl>
      {r.feeLine && <p className="small muted tm-fee">Creator fee: {r.feeLine}</p>}
    </section>
  );
}

/** Who called it and why: each model with its confidence, the reasons, and the AI reviewer's view. */
function CallCard({ card }: { card: Card }) {
  const curated = card.curated;
  const showNarrative = useShowNarrativeNote();
  if (!curated) {
    return (
      <section className="sage-card">
        <h4>Why it&apos;s here</h4>
        <p className="small muted">
          {card.kind === "stream"
            ? "It passed the safety screen inside the market-cap band. No model has called it."
            : card.filter
              ? `Your filter "${card.filter.name}" caught it.`
              : "Your filter caught it."}
        </p>
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
 * TokenSage's part of the modal: its read in brief, then the coin's lineage and crowd, what it is
 * trending on, and how calls on coins like it (its narrative) did this week.
 */
function SageSection({ mint }: { mint: string }) {
  const utility = useContext(UtilityContext);
  // A lookup asks TokenSage for a fresh read, which lands within minutes: check more often.
  const { data, error } = usePolling<SageView>(`${useTokenApi(mint)}/sage`, utility ? 20_000 : 120_000);
  const r = data?.read ?? null;
  return (
    <>
      <SageCard mint={mint} data={data} error={error} />
      {r && (
        <div className="tm-grid">
          <LineageCard read={r} />
          <TrendCard read={r} />
        </div>
      )}
      {data?.track && <WeekChart track={data.track} />}
    </>
  );
}

/** TokenSage's read in brief: the referent, theme, copy mark, summary, flags and X link. */
function SageCard({ mint, data, error }: { mint: string; data: SageView | null; error: Error | null }) {
  const r = data?.read ?? null;
  const locked = error && !data ? lockedText(error, "TokenSage read") : null;
  const ref = r?.referent ?? null;
  const utility = useContext(UtilityContext);
  const copyMark = r?.copyMark ? (LINEAGE[r.copyMark] ?? LINEAGE.copy) : undefined;
  const flags = r ? [...r.flags].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, 5) : [];
  return (
    <section className="sage-card tm-sage">
      <h4>
        <span className="sage-brand">
          <SageIcon size={14} /> TokenSage
        </span>
        {r && <span className="sage-tag">{r.depth === "full" ? "Deep read" : "Quick read"}</span>}
        <button type="button" className="tm-link" onClick={() => openSage(mint)}>
          Full read
        </button>
      </h4>
      {!data && !error && <Skeleton lines={3} />}
      {locked && (
        <p className="tm-locked muted small">
          <LockIcon size={14} /> {locked}
        </p>
      )}
      {error && !data && !locked && (
        <p className="error small">Couldn&apos;t load the read: {error.message}</p>
      )}
      {data && !r && (
        <p className="small muted">
          {data.status === "failed"
            ? "TokenSage couldn't read this coin."
            : data.status === "expired"
              ? "TokenSage's read of this coin has been cleared (reads are kept for three weeks)."
              : utility
                ? "TokenSage is reading this coin now. Its read shows here as soon as it lands."
                : "TokenSage hasn't read this coin yet."}
        </p>
      )}
      {r && (
        <>
          <div className="tm-referent">
            <span className="sage-eyebrow">
              {ref ? (ref.generic ? "A kind of coin" : "Refers to") : "Referent"}
            </span>
            <strong>{ref ? ref.label : "No clear referent"}</strong>
            {ref?.confidence != null && (
              <span className="muted small"> · {Math.round(ref.confidence * 100)}% sure</span>
            )}
          </div>
          {(r.mainCategory || copyMark) && (
            <div className="sage-marks">
              {r.mainCategory && <span className="sage-tag">{categoryText(r.mainCategory.label)}</span>}
              {copyMark && <span className={`sage-tag tone-${copyMark.tone}`}>{copyMark.text}</span>}
            </div>
          )}
          {r.summary && <Summary text={r.summary} />}
          {flags.length > 0 && (
            <ul className="sage-flags">
              {flags.map((f) => (
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
          {r.x?.url && r.x.url.startsWith("https://") && (
            <p className="small tm-x">
              <a href={r.x.url} target="_blank" rel="noreferrer">
                {r.x.author?.handle ? `@${r.x.author.handle}` : "X post"}
                <ExternalIcon size={11} />
              </a>
              {r.x.author?.followers != null && (
                <span className="muted"> · {r.x.author.followers.toLocaleString()} followers</span>
              )}
              {r.x.text && <span className="muted tm-x-text"> · {r.x.text}</span>}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** TokenSage's summary, clamped to a few lines with a toggle: reads run long. */
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  return (
    <div className="tm-summary">
      <blockquote className={`sage-summary${long && !open ? " clamped" : ""}`}>{text}</blockquote>
      {long && (
        <button type="button" className="tm-link" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Read all"}
        </button>
      )}
    </div>
  );
}

/** Where the coin comes from: what it copies or builds on, and how crowded its name and theme are. */
function LineageCard({ read: r }: { read: SageRead }) {
  const l = r.lineage;
  const lineage = l ? LINEAGE[l.kind] : undefined;
  const of = l?.ofMint && l.kind !== "original" && l.kind !== "unknown" ? l.ofMint : null;
  const ofLabel = l?.ofTicker ? `$${l.ofTicker}` : (l?.ofName ?? "the original");
  const has = !!l || !!r.referent?.wave || r.copyOf.length > 0;
  return (
    <section className="sage-card tm-lineage">
      <h4>
        Lineage
        {lineage && <span className={`sage-tag tone-${lineage.tone}`}>{lineage.text}</span>}
      </h4>
      {has ? (
        <>
          <LineageText read={r} />
          <CrowdChart read={r} />
          {of && (
            <button type="button" className="tm-link tm-of" onClick={() => openSage(of)}>
              TokenSage on {ofLabel}
            </button>
          )}
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
  const terms = t?.terms.slice(0, 6) ?? [];
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

function rank(severity: string): number {
  return severity === "high" ? 0 : severity === "warn" ? 1 : 2;
}
