import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Card } from "../api";
import { usePolling } from "../hooks";
import { ago, change, minutes, multiple, pct, shortAddress, tokenLabel, tokenThumb, usd } from "../format";
import { matchOutcome, outcomeAt, outcomeBadge } from "../outcome";
import { openSage } from "../sage";
import { QUICK_LINK_SITES, useAppearance } from "../appearance";
import { useShowNarrativeNote } from "../narrativeNote";
import { scoreTone, scoreToneColor, useScoreWeights } from "../scoreWeights";
import {
  linePoints,
  MARKER_KINDS,
  pointWidthMs,
  type MarkerKind,
  type MarkerTrade,
  type Point,
} from "../priceChart";
import {
  cardReadings,
  LINKED_WARN_PCT,
  linkedSeed,
  nowReading,
  recordedPeakOf,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
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
import { openBubbleMap } from "../bubbleMap";
import {
  BrainIcon,
  BubblesIcon,
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
  tags: ("risky" | "dumper" | "linked" | "creator")[];
  score: number | null;
  dumps: number | null;
  coins: number | null;
  funder: string | null;
  solIn: number;
  solOut: number;
  heldPct: number | null;
  trades: [number, 1 | -1, number | null][];
}

/** The marker colour a flagged wallet gets: the creator first, then a risky one, else linked. */
function kindOf(w: FlaggedWallet): MarkerKind {
  if (w.tags.includes("creator")) return "dev";
  if (w.tags.includes("risky") || w.tags.includes("dumper")) return "risky";
  return "linked";
}

type Range = "alert" | "1h" | "all";
const RANGES: { id: Range; label: string }[] = [
  { id: "alert", label: "From alert" },
  { id: "1h", label: "1h" },
  { id: "all", label: "All" },
];
/** How much of the run-up the "From alert" view shows before the alert. */
const LEAD_IN_MS = 10 * 60_000;
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
 * comes from the lookup's own routes, there is no call to explain, and the TokenSage page and
 * bubble map open only for a wallet with access (their hosts live behind the paywall).
 */
export interface UtilityMode {
  /** Where the chart and the TokenSage read come from: "/utilities/token" instead of "/tokens". */
  apiBase: string;
  /** Whether the lookup's fresh scan has landed yet. */
  scan: "scanning" | "scanned";
  /** Whether the TokenSage page and the bubble map can open (the wallet has access). */
  extras: boolean;
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

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="about-body tm-body">
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
          {(!utility || utility.extras) && (
            <button
              type="button"
              className="sage-btn"
              onClick={() => openSage(mint)}
              title="Open TokenSage's full read of this coin"
            >
              <SageIcon size={13} />
              Sage
            </button>
          )}
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
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
          <span className="num">{hasPeak ? multiple(peak) : "–"}</span>
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

      <ChartCard card={card} alertAt={alertAt} alertMcap={alertMcap} what={what} />

      {utility ? (
        // A lookup has no call to explain: the numbers take the full width.
        <StatsCard card={card} />
      ) : (
        <div className="tm-grid">
          <StatsCard card={card} />
          <CallCard card={card} />
        </div>
      )}

      <SageSection mint={mint} />

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

/** Why an access-gated part couldn't load, in words. */
function lockedText(error: Error, what: string): string | null {
  if (error instanceof ApiError && (error.status === 401 || error.status === 402)) {
    return `The ${what} comes with access. Connect a wallet with access to see it.`;
  }
  return null;
}

function ChartCard({
  card,
  alertAt,
  alertMcap,
  what,
}: {
  card: Card;
  alertAt: number;
  alertMcap: number;
  what: string;
}) {
  const mint = card.token.mintAddress;
  const { data, error } = usePolling<TokenChart>(`${useTokenApi(mint)}/chart`, CHART_POLL_MS);
  const utility = useContext(UtilityContext);
  // A lookup has no alert to start from: it opens on the coin's whole history.
  const [range, setRange] = useState<Range>(utility ? "all" : "alert");
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

  const view = useMemo(() => {
    if (!data) return null;
    const fromCandles = !!data.candles && data.candles.length > 0;
    // The line runs through each minute's close, else through the scan's readings.
    const source: Point[] = fromCandles
      ? data.candles!.map((c) => ({ t: c.t, v: c.c }))
      : data.marketCap.map((p) => ({ t: p.t, v: p.usd }));
    if (source.length < 2) return { points: [] as Point[], fromCandles, step: undefined };
    const first = source[0]!.t;
    const last = source[source.length - 1]!.t;
    const from =
      range === "all"
        ? first
        : range === "1h"
          ? last - 3_600_000
          : // From the alert: unless the data starts after it (then all of it).
            alertAt - LEAD_IN_MS > first
            ? alertAt - LEAD_IN_MS
            : first;
    const step = pointWidthMs(last - Math.max(from, first) + 60_000, MAX_POINTS);
    return { points: linePoints(source, from, step), fromCandles, step: fromCandles ? step : undefined };
  }, [data, range, alertAt]);

  const flagged = useMemo(() => data?.wallets ?? [], [data]);
  const markers = useMemo<MarkerTrade[]>(
    () =>
      flagged.flatMap((w) => {
        const kind = kindOf(w);
        if (hidden.has(kind)) return [];
        return w.trades.map(([t, side, sol]) => ({ t, side, sol, wallet: w.wallet, kind }));
      }),
    [flagged, hidden],
  );
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
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`tm-range${range === r.id ? " on" : ""}`}
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
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
            height={height}
            ariaLabel={`${tokenLabel(card.token)} market cap from ${usd(view.points[0]!.v)} to ${usd(view.points[view.points.length - 1]!.v)}`}
          />
        )}
        {data && (
          <div className="tm-legend">
            {flagged.length > 0 ? (
              <>
                <span className="tm-legend-key faint small">
                  <span className="tm-tri up" aria-hidden="true" /> buy
                  <span className="tm-tri down" aria-hidden="true" /> sell
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
      {flagged.length > 0 && <WalletsCard wallets={flagged} />}
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
};

/** The flagged wallets behind the markers: what each is, its score, and what it did in the coin. */
function WalletsCard({ wallets }: { wallets: FlaggedWallet[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? wallets : wallets.slice(0, 6);
  return (
    <section className="sage-card tm-wallets">
      <h4>
        Flagged wallets
        <span className="sage-tag">{wallets.length}</span>
      </h4>
      <ul>
        {shown.map((w) => {
          const net = w.solOut - w.solIn;
          return (
            <li key={w.wallet}>
              <i className={`pc-swatch k-${kindOf(w)}`} aria-hidden="true" />
              <a
                className="num tm-wallet"
                href={`https://solscan.io/account/${w.wallet}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(w.wallet)}
              </a>
              <span className="tm-tags">
                {w.tags.map((t) => (
                  <span
                    key={t}
                    className={`tm-tag k-${TAG_TEXT[t].tone}`}
                    title={
                      t === "linked" && w.funder
                        ? `Funded by ${shortAddress(w.funder)}, like other top holders`
                        : t === "dumper" && w.dumps !== null
                          ? `Sold into ${w.dumps} stopped calls`
                          : undefined
                    }
                  >
                    {TAG_TEXT[t].text}
                  </span>
                ))}
              </span>
              <span
                className="tm-score num"
                title={
                  w.score === null
                    ? "Not scored: seen in fewer than two read coins"
                    : `Risk score ${Math.round(w.score)} of 100${w.coins ? `, from ${w.coins} coins` : ""}`
                }
              >
                {w.score === null ? "–" : Math.round(w.score)}
              </span>
              <span className="tm-flow num" title="SOL in and out of this coin">
                {w.solIn.toFixed(2)} → {w.solOut.toFixed(2)}
                {/* Before it sells, its SOL in is a position, not a loss. */}
                {w.solOut > 0 && (
                  <span className={net >= 0 ? "up" : "down"}>
                    {" "}
                    ({net >= 0 ? "+" : ""}
                    {net.toFixed(2)})
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {wallets.length > 6 && (
        <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${wallets.length}`}
        </button>
      )}
      <p className="faint small tm-wallets-note">
        Risky: a score of 70+ from selling into earlier calls&apos; stops. Linked: funded by the same wallet
        as other top holders. Score is 0-100; SOL in → out of this coin.
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
          explain="top-10 holder wallets first used in the last 24h"
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
          className={r.linkedPct !== null && r.linkedPct >= LINKED_WARN_PCT ? "risky" : undefined}
          title="Share of supply held by top holders one wallet funded (or that funded each other)"
        >
          <dt>Linked</dt>
          <dd className={r.linkedPct === null ? "muted" : "num"}>
            {r.linkedPct === null ? "Not checked" : pct(r.linkedPct)}
            {r.linkedClusters.length > 0 && (!utility || utility.extras) && (
              <button
                type="button"
                className="tm-link bm-open"
                onClick={() => openBubbleMap(card.token.mintAddress, linkedSeed(card))}
                title="Open the bubble map of the linked wallets"
              >
                <BubblesIcon size={13} /> Map
              </button>
            )}
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
        {(!utility || utility.extras) && (
          <button type="button" className="tm-link" onClick={() => openSage(mint)}>
            Full read
          </button>
        )}
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
          {r.summary && <blockquote className="sage-summary">{r.summary}</blockquote>}
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

/** Where the coin comes from: what it copies or builds on, and how crowded its name and theme are. */
function LineageCard({ read: r }: { read: SageRead }) {
  const l = r.lineage;
  const utility = useContext(UtilityContext);
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
          {of && (!utility || utility.extras) && (
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
