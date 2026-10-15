import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CuratedStats, type Leaderboard, type MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { SkeletonCards } from "../components/Charts";
import { AboutModal } from "../components/AboutModal";
import { introSeen, markIntroSeen } from "../intro";
import { ArrowRightIcon, BrainIcon, InfoIcon, PaletteIcon, RadarIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { useLiveMarketCaps, usePolling, usePollingAll, useNow, useNudgeStream } from "../hooks";
import { fillPage, joinPages, MAX_FILL_PAGES, MAX_READ_PAGES } from "../feedFill";
import { ago, pct } from "../format";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { CustomizeDrawer } from "../components/CustomizeDrawer";
import { CaSearchBox, SearchResults } from "../components/CaSearch";
import { parseSearch } from "../caSearch";

/** This browser's "High conviction only" switch (the API takes it per request, not as a saved setting). */
const HIGH_CONVICTION_KEY = "ts-feed-high-conviction";

/** The "High conviction only" switch is hidden for now; flip this to bring it back. While hidden the
 *  saved choice stays in storage but isn't applied, so nobody is stuck on a filter they can't see. */
const SHOW_HIGH_CONVICTION = false;

function readHighConviction(): boolean {
  if (!SHOW_HIGH_CONVICTION) return false;
  try {
    return localStorage.getItem(HIGH_CONVICTION_KEY) === "1";
  } catch {
    return false;
  }
}

/** The main tab: your own filter's catches and the model calls you follow, in one stream. */
export function LiveTab({
  goTo,
  walletAddress,
}: {
  goTo: (tab: "model" | "filters" | "settings") => void;
  walletAddress: string;
}) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Model calls narrowed to every model's high-conviction tier instead of the followed models.
  const [highConviction, setHighConviction] = useState(readHighConviction);
  // The tour opens by itself the first time this wallet lands here.
  const [aboutOpen, setAboutOpen] = useState(() => !introSeen(walletAddress));
  const closeAbout = () => {
    setAboutOpen(false);
    markIntroSeen(walletAddress);
  };
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  // The search (address, ticker or name) is looked up in the API across the whole feed and shown
  // in the feed's place; the paged feed underneath carries on as it was.
  const [searchInput, setSearchInput] = useState("");
  const clearSearch = useCallback(() => setSearchInput(""), []);
  const searching = parseSearch(searchInput).kind !== "none";
  // "saved": the API mixes in model calls per this user's own switch and checked models; with
  // highConviction those calls are every model's high-conviction tier instead.
  const hc = highConviction ? "&highConviction=1" : "";
  const feedPath = (n: number) => `/matches?page=${n}&includeCurated=saved${hc}`;
  // The API's pages can come up short (a model call folded into your filter's card for the same
  // token, a card whose token was pruned), and hiding low market caps takes more cards out, so the
  // feed reads the API's pages from the first and lays out full pages of its own here: page 1
  // below, and `depth - 1` more after it, read as far as the page on screen needs.
  const [depth, setDepth] = useState(1);
  const feedPage = usePolling<MatchPage>(feedPath(1), 30_000);
  const morePaths = Array.from({ length: depth - 1 }, (_, i) => feedPath(i + 2));
  const morePages = usePollingAll<MatchPage>(morePaths, 30_000);
  const stats = usePolling<CuratedStats>("/curated/stats", 60_000);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000);
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  const nudged = () => {
    // Only the first page: the ones read ahead catch up on their own poll, and a burst of alerts
    // must not refetch all of them each time.
    feedPage.reload();
  };
  const curatedLive = useNudgeStream("/curated/stream", nudged, modelsOn);
  const matchesLive = useNudgeStream("/matches/stream", nudged);
  const loadedPages = [feedPage.data, ...morePages.data];
  const buffer = useMemo(
    () => (feedPage.data ? joinPages(loadedPages) : undefined),
    // loadedPages is rebuilt every render; its parts are what change.
    [feedPage.data, morePages.data],
  );
  // The live tick covers the page on screen and the hidden cards among it (which can climb back),
  // not every alert read ahead. Which those are depends on the tick itself, so it follows a render.
  const [tickIds, setTickIds] = useState<string[] | undefined>(undefined);
  // "Now" on each card, seconds old rather than as old as the last feed poll. A search ticks its
  // own cards (SearchResults), so the feed's tick rests meanwhile.
  const cards = useLiveMarketCaps(buffer, searching ? [] : tickIds);
  // The "hide below this market cap" setting only takes cards off the screen: the feed's stats and
  // grading are the API's, unchanged. Older alerts move up into the gaps, and a card that climbs
  // back over the line (with a margin, so a coin trading at the line doesn't flicker) takes its own
  // place again. Which cards were hidden last time carries over for that margin.
  const wasHidden = useRef<ReadonlySet<string>>(new Set());
  const filled = useMemo(
    () => (cards ? fillPage(cards, look, page, wasHidden.current) : null),
    [cards, look, page],
  );
  useEffect(() => {
    wasHidden.current = filled?.hidden ?? new Set();
  }, [filled]);
  const tickKey = filled?.tickTokenIds.join(",") ?? "";
  useEffect(() => setTickIds(tickKey ? tickKey.split(",") : undefined), [tickKey]);
  const lastLoaded = loadedPages[loadedPages.length - 1] ?? null;
  // Paging further back reads further: as many API pages as the page on screen, plus room to fill.
  const maxDepth = Math.min(page + MAX_FILL_PAGES - 1, MAX_READ_PAGES);
  const allLoaded = loadedPages.every((p) => p !== null);
  const apiHasMore = lastLoaded ? (lastLoaded.hasMore ?? false) : false;
  // Read one more API page while this one is short and the API has older alerts.
  useEffect(() => {
    if (filled && !filled.moreLoaded && allLoaded && apiHasMore && depth < maxDepth) setDepth((d) => d + 1);
  }, [filled, allLoaded, apiHasMore, depth, maxDepth]);
  // Back to reading the first page alone when the feed changes.
  useEffect(() => setDepth(1), [highConviction]);
  const shownCards = filled?.shown;
  const hiddenCount = filled?.hiddenHere ?? 0;

  const t = lb?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)) : [];
  const hasMore = filled ? filled.moreLoaded || (apiHasMore && depth < maxDepth) : false;
  const chosenNames =
    chosen.length === 0
      ? "–"
      : chosen.length <= 2
        ? chosen.map((e) => e.name).join(" + ")
        : `${chosen[0]!.name} +${chosen.length - 1}`;
  const streamLive = matchesLive && (!modelsOn || curatedLive);

  const toggleHighConviction = () => {
    const next = !highConviction;
    try {
      localStorage.setItem(HIGH_CONVICTION_KEY, next ? "1" : "0");
    } catch {
      // Private mode or blocked storage: the switch still applies for this visit.
    }
    setHighConviction(next);
    setPage(1);
  };

  return (
    <div className="stack">
      <CustomizeDrawer open={customizing} onClose={closeCustomize} />
      <AboutModal open={aboutOpen} onClose={closeAbout} targets={t} />
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Live feed</span>
            <div className="heading-row">
              <h2>
                Your alerts
                {modelsOn ? (highConviction ? " and high-conviction calls" : " and model calls") : ""}
              </h2>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => setAboutOpen(true)}
                aria-label="How this works"
                title="How this works"
              >
                <InfoIcon size={16} />
              </button>
            </div>
          </div>
          <div className="feed-controls">
            <button
              type="button"
              className={`ghost stats-btn${customizing ? " on" : ""}`}
              aria-expanded={customizing}
              onClick={() => setCustomizing((o) => !o)}
              title="Colors, spacing, columns and what each card shows, changed right here on your feed"
            >
              <PaletteIcon size={14} />
              Customize
            </button>
            {SHOW_HIGH_CONVICTION && (
              <button
                type="button"
                role="switch"
                aria-checked={highConviction}
                className={`switch${highConviction ? " on" : ""}`}
                disabled={!modelsOn}
                onClick={toggleHighConviction}
                title={
                  modelsOn
                    ? "Show only the calls that cleared each model's high-conviction line, from every model, in place of the models you follow. Your filter's alerts still show."
                    : "Turn on model alerts to narrow them to the high-conviction calls"
                }
              >
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                High conviction only
              </button>
            )}
            <CaSearchBox
              value={searchInput}
              onChange={setSearchInput}
              title="Find a token in your feed by its contract address, ticker or name. Press / to jump here."
            />
            <span className={`live-dot ${streamLive ? "on" : ""}`}>{streamLive ? "Live" : "Polling"}</span>
          </div>
        </header>
        {searching && (
          <SearchResults<MatchPage>
            input={searchInput}
            pathFor={(search, n) => (search ? `${feedPath(n)}&${search}` : feedPath(1))}
            pollMs={30_000}
            pollKey=""
            cardsOf={(d) => d.matches}
            hasMoreOf={(d) => d.hasMore ?? false}
            noun="alert"
            where="your feed"
            onClear={clearSearch}
            now={now}
            hide={hidden}
            look={look}
            labelSource
          />
        )}
        {!searching && feedPage.error && !feedPage.data && (
          <p className="error">Couldn&apos;t load your feed: {feedPage.error.message}</p>
        )}
        {!searching && (
          <>
            {!feedPage.data && !feedPage.error && <SkeletonCards count={4} />}
            {feedPage.data && feedPage.data.matches.length === 0 && page === 1 && (
              <div className="empty-state">
                <RadarIcon size={28} />
                <p>
                  {modelsOn
                    ? `Nothing yet from your filter or ${highConviction ? "the high-conviction calls" : chosenNames}. Alerts land here the moment one comes in.`
                    : "Nothing caught by your filter yet. Turn on Model alerts in Settings to see the models' calls here too."}
                </p>
                <button className="ghost" onClick={() => goTo("filters")}>
                  Tune your filter <ArrowRightIcon size={13} />
                </button>
              </div>
            )}
            <div
              className={`cards${feedPage.stale ? " stale" : ""}`}
              aria-busy={feedPage.stale}
              {...feedGridProps(look)}
            >
              {shownCards?.map((card) => (
                <AlertCard key={card.id} card={card} now={now} labelSource hide={hidden} />
              ))}
            </div>
            {hiddenCount > 0 && (
              <p className="muted small center mcap-hidden-note">
                {hiddenCount === 1 ? "1 alert" : `${hiddenCount} alerts`} now under $
                {look.hideBelowMcapUsd / 1000}K market cap {hiddenCount === 1 ? "is" : "are"} hidden here,
                with older alerts moved up in {hiddenCount === 1 ? "its" : "their"} place.{" "}
                <button type="button" className="link" onClick={() => setCustomizing(true)}>
                  Change
                </button>
              </p>
            )}
            {feedPage.data && (shownCards?.length ?? 0) === 0 && page > 1 && (
              <p className="muted small center">Nothing older here.</p>
            )}
            {(page > 1 || hasMore) && (
              <nav className="pager">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  ← Newer
                </button>
                <span className="muted small num">Page {page}</span>
                <button
                  disabled={!hasMore || feedPage.stale}
                  // Start the next page on hover/focus so the click usually finds it already here.
                  onPointerEnter={() => prefetch(feedPath(depth + 1))}
                  onFocus={() => prefetch(feedPath(depth + 1))}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Older →
                </button>
              </nav>
            )}
          </>
        )}
        {stats.data && look.learningNote && (
          <div className="learning-note">
            <BrainIcon size={14} />
            <span>
              Learning from{" "}
              <strong className="num">{stats.data.training.finalizedSamples.toLocaleString()}</strong> graded
              moments. Base 2x rate {pct(stats.data.training.baseWinRatePct, 1)}
              {stats.data.curator.modelTrainedAt &&
                `, model data to ${ago(stats.data.curator.modelTrainedAt, now)}`}
              .
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
