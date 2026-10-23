import { MarketBar } from "../components/MarketBar";
import { WatchlistChips } from "../components/WatchlistChips";
import { WatchlistPanel } from "../components/WatchlistPanel";
import { SectionBoundary } from "../components/SectionBoundary";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CuratedStats, type Leaderboard, type MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { ScopeRowSkeletons, SkeletonCards } from "../components/Skeleton";
import { introSeen, markIntroSeen } from "../intro";
import { ArrowRightIcon, BrainIcon, EyeOffIcon, InfoIcon, PaletteIcon, RadarIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { useLiveMarketCaps, usePolling, usePollingAll, useNow, useNudgeStream } from "../hooks";
import { FEED_PAGE_SIZE, fillPage, joinPages, MAX_FILL_PAGES, MAX_READ_PAGES, nextDepth } from "../feedFill";
import { ago, pct } from "../format";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { registerCardSearch } from "../cardSearch";
import { CaSearchButton } from "../components/CaSearchButton";
import { ScanStatus } from "../components/ScanStatus";
import { HiddenTokensDialog } from "../components/HiddenTokensDialog";
import { AsOf } from "../components/AsOf";
import { dueToUnhide, hideToken, unhideTokens, useHiddenTokenIds, useHiddenTokens } from "../hiddenTokens";
import { useHeldTokenIds } from "../heldTokens";
import { openCustomize, useCustomize } from "../customize";
import { setLayoutPrefs, useLayoutPrefs, type LiveView } from "../layoutPrefs";
import { AboutModal, loadAboutModal, ScopeBoard, SearchModal, useOpenedOnce } from "../livePanels";

/** This browser's "High conviction only" switch (the API takes it per request, not as a saved setting). */
const HIGH_CONVICTION_KEY = "ts-feed-high-conviction";

/** The "High conviction only" switch is hidden for now; flip this to bring it back. While hidden the
 *  saved choice stays in storage but isn't applied, so nobody is stuck on a filter they can't see. */
const SHOW_HIGH_CONVICTION = false;

/**
 * How many API pages each feed page took to fill last time, by feed and page ("<hc>|<page>"), kept
 * for the page's life rather than the tab's: coming back to Live (or paging back) reads that many
 * at once, from the cache where it has them, instead of growing one round trip at a time again.
 */
const filledDepth = new Map<string, number>();

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
  isAdmin = false,
}: {
  goTo: (tab: "model" | "filters" | "settings") => void;
  walletAddress: string;
  /** Admin wallets see the scanner's per-job rows in the Scanning pill's card. */
  isAdmin?: boolean;
}) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Cards or Scope (user decision 2026-10-18: a toggle, not a tab), synced to the account and also
  // set in Customize › Tabs, top bar and lists (layoutPrefs.ts).
  const view = useLayoutPrefs().liveView;
  const setView = (liveView: LiveView) => setLayoutPrefs({ liveView });
  // Tokens the user hid from Cards and Scope (user ask 2026-10-19), and the list to bring them back.
  const hiddenTokens = useHiddenTokens();
  const hiddenTokenIds = useHiddenTokenIds();
  // Pro: coins the wallet holds skip the filters below and Scope's (user ask 2026-10-19).
  const heldTokenIds = useHeldTokenIds();
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const scope = view === "scope";
  // Scope's held-still and failing reads, for the Scanning pill (user ask 2026-10-23).
  const [scopeStatus, setScopeStatus] = useState({ paused: false, failing: false });
  // Model calls narrowed to every model's high-conviction tier instead of the followed models.
  const [highConviction, setHighConviction] = useState(readHighConviction);
  // The tour opens by itself the first time this wallet lands here.
  const [aboutOpen, setAboutOpen] = useState(() => !introSeen(walletAddress));
  const closeAbout = () => {
    setAboutOpen(false);
    markIntroSeen(walletAddress);
  };
  // The one Customize window (customize.ts), opened here at Cards or Scope.
  const customize = useCustomize();
  const customizing = customize.open && (customize.section === "scope" || customize.section === "cards");
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  // The search (address, ticker or name) opens its own window over the feed (user ask
  // 2026-10-19), in both views; the feed underneath carries on as it was.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState<{ text: string; id: number } | null>(null);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const openSearchQuery = useCallback((text: string) => {
    setSearchSeed({ text, id: Date.now() });
    setSearchOpen(true);
  }, []);
  useEffect(() => registerCardSearch(openSearchQuery), [openSearchQuery]);
  // The windows' code loads on their first opening (livePanels.ts), and they stay mounted after.
  const aboutMounted = useOpenedOnce(aboutOpen);
  const searchMounted = useOpenedOnce(searchOpen);
  // "saved": the API mixes in model calls per this user's own switch and checked models; with
  // highConviction those calls are every model's high-conviction tier instead.
  const hc = highConviction ? "&highConviction=1" : "";
  const feedPath = (n: number) => `/matches?page=${n}&includeCurated=saved${hc}`;
  // The API's pages can come up short (a model call folded into your filter's card for the same
  // token, a card whose token was pruned), and hiding low market caps takes more cards out, so the
  // feed reads the API's pages from the first and lays out full pages of its own here: page 1
  // below, and `depth - 1` more after it, read as far as the page on screen needs.
  const [depth, setDepth] = useState(() => filledDepth.get(`${hc}|1`) ?? 1);
  const feedPage = usePolling<MatchPage>(feedPath(1), 30_000);
  const morePaths = Array.from({ length: depth - 1 }, (_, i) => feedPath(i + 2));
  const morePages = usePollingAll<MatchPage>(morePaths, 30_000);
  const stats = usePolling<CuratedStats>("/curated/stats", 60_000);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000);
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  // Settings' "Only alerts both caught": the API narrows the feed and its stats; this only words it.
  const bothOn = modelsOn && (lb?.bothOnly ?? false);
  // Only the first page refetches on a nudge: the ones read ahead catch up on their own poll, and
  // a burst of alerts must not refetch all of them each time.
  const nudged = () => feedPage.reload();
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
  // "Now" on each card, seconds old rather than as old as the last feed poll.
  const cards = useLiveMarketCaps(buffer, tickIds);
  // Hidden tokens come off the page like the low market caps below, older alerts moving up. With
  // auto-unhide on, one that graduated or reached a new 2x, 4x or 10x comes back. One the wallet
  // holds stays.
  const unhiddenCards = useMemo(
    () =>
      cards && hiddenTokenIds.size > 0
        ? cards.filter((c) => !hiddenTokenIds.has(c.tokenId) || heldTokenIds.has(c.tokenId))
        : cards,
    [cards, hiddenTokenIds, heldTokenIds],
  );
  useEffect(() => {
    if (cards) unhideTokens(dueToUnhide(hiddenTokens, cards));
  }, [cards, hiddenTokens]);
  // The "hide below this market cap" setting only takes cards off the screen: the feed's stats and
  // grading are the API's, unchanged. Older alerts move up into the gaps, and a card that climbs
  // back over the line (with a margin, so a coin trading at the line doesn't flicker) takes its own
  // place again. Which cards were hidden last time carries over for that margin.
  const wasHidden = useRef<ReadonlySet<string>>(new Set());
  const filled = useMemo(
    () =>
      unhiddenCards ? fillPage(unhiddenCards, look, page, wasHidden.current, undefined, heldTokenIds) : null,
    [unhiddenCards, look, page, heldTokenIds],
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
  // Read more API pages while this one is short and the API has older alerts: as many as it looks
  // to need at the rate the pages so far showed cards, all at once.
  useEffect(() => {
    if (!filled || !allLoaded) return;
    if (filled.moreLoaded) filledDepth.set(`${hc}|${page}`, depth);
    else if (apiHasMore && depth < maxDepth)
      setDepth(nextDepth(depth, filled.visible, page * FEED_PAGE_SIZE, maxDepth));
  }, [filled, allLoaded, apiHasMore, depth, maxDepth, hc, page]);
  // Back to the new feed's own depth when it changes. Not on mount: this ran after the effect above
  // and undid its first step, so a feed coming back from the cache sat short until the next poll.
  const lastHc = useRef(hc);
  useEffect(() => {
    if (hc === lastHc.current) return;
    lastHc.current = hc;
    setDepth(filledDepth.get(`${hc}|1`) ?? 1);
  }, [hc]);
  // Paged back: read only as deep as the page on screen took last time, growing again (above) if it
  // comes up short. Kept at its depth, every page read on the way out stayed polled for good.
  const lastPage = useRef(page);
  useEffect(() => {
    if (page < lastPage.current) setDepth((d) => Math.min(d, filledDepth.get(`${hc}|${page}`) ?? page));
    lastPage.current = page;
  }, [page, hc]);
  // The API pages the next page looks to need, started on hover/focus of Older so the click usually
  // finds them all here rather than filling in a few cards per round trip.
  const prefetchOlder = () => {
    const ahead = filled
      ? nextDepth(
          depth,
          filled.visible,
          (page + 1) * FEED_PAGE_SIZE,
          Math.min(page + MAX_FILL_PAGES, MAX_READ_PAGES),
        )
      : depth + 1;
    for (let n = depth + 1; n <= ahead; n++) prefetch(feedPath(n));
  };
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
      <MarketBar left={<WatchlistPanel fit />} leftMini={<WatchlistChips />} />
      <SectionBoundary label="Hidden tokens" resetKey={hiddenOpen} onClose={() => setHiddenOpen(false)}>
        <HiddenTokensDialog open={hiddenOpen} onClose={() => setHiddenOpen(false)} now={now} />
      </SectionBoundary>
      <Suspense fallback={null}>
        {aboutMounted && <AboutModal open={aboutOpen} onClose={closeAbout} targets={t} />}
      </Suspense>
      <SectionBoundary label="The search window" resetKey={searchOpen} onClose={() => setSearchOpen(false)}>
        <Suspense fallback={null}>
          {searchMounted && (
            <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} now={now} seed={searchSeed} />
          )}
        </Suspense>
      </SectionBoundary>
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Live feed</span>
            <div className="heading-row">
              <h2>
                {bothOn
                  ? "Alerts your filter and models both caught"
                  : `Your alerts${modelsOn ? (highConviction ? " and high-conviction alerts" : " and model alerts") : ""}`}
              </h2>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => setAboutOpen(true)}
                onPointerEnter={() => void loadAboutModal()}
                onFocus={() => void loadAboutModal()}
                aria-label="How this works"
                title="How this works"
              >
                <InfoIcon size={16} />
              </button>
            </div>
          </div>
          <div className="feed-controls">
            <div className="segmented small feed-view" role="radiogroup" aria-label="Feed view">
              {(["cards", "scope"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={view === v}
                  className={view === v ? "on" : ""}
                  onClick={() => setView(v)}
                  title={
                    v === "cards"
                      ? "Your feed as full alert cards, a page at a time"
                      : "Your feed as a dense board: your filters, models and graduated tokens side by side"
                  }
                >
                  {v === "cards" ? "Cards" : "Scope"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`ghost stats-btn${customizing ? " on" : ""}`}
              aria-expanded={customizing}
              aria-haspopup="dialog"
              onClick={() => openCustomize(scope ? "scope" : "cards")}
              title={
                scope
                  ? "Customize Scope: how the rows look and what each column shows, plus every other option"
                  : "Customize your feed: colors, spacing, columns and what each card shows, plus every other option"
              }
            >
              <PaletteIcon size={14} />
              Customize
            </button>
            {hiddenTokens.tokens.length > 0 && (
              <button
                type="button"
                className={`ghost stats-btn${hiddenOpen ? " on" : ""}`}
                aria-expanded={hiddenOpen}
                onClick={() => setHiddenOpen(true)}
                title="Tokens you hid from Cards and Scope: bring them back, or choose whether they come back by themselves"
              >
                <EyeOffIcon size={14} />
                Hidden <span className="num">{hiddenTokens.tokens.length}</span>
              </button>
            )}
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
                    ? "Show only the alerts that cleared each model's high-conviction line, from every model, in place of the models you follow. Your filter's alerts still show."
                    : "Turn on model alerts to narrow them to the high-conviction tier"
                }
              >
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                High conviction only
              </button>
            )}
            <CaSearchButton
              onOpen={openSearch}
              title="Find any token TrenchScanner tracks by its contract address, ticker or name. Press / to open."
            />
            <ScanStatus
              showJobs={isAdmin}
              feed={{
                live: streamLive,
                idle: "Polling",
                paused: scope && scopeStatus.paused,
                failing: scope ? scopeStatus.failing : !!feedPage.error,
              }}
            />
          </div>
        </header>
        {!scope && feedPage.error && !feedPage.data && (
          <p className="error">Couldn&apos;t load your feed: {feedPage.error.message}</p>
        )}
        {!scope && feedPage.error && feedPage.data && (
          <p className="muted small center feed-refresh-note" role="status">
            Couldn&apos;t refresh your feed, showing it from{" "}
            {feedPage.at !== null ? ago(new Date(feedPage.at), now) : "earlier"}. Trying again.
          </p>
        )}
        {scope && (
          <Suspense fallback={<ScopeRowSkeletons />}>
            <ScopeBoard
              feedPath={feedPath}
              modelsOn={modelsOn}
              heldTokenIds={heldTokenIds}
              onStatus={setScopeStatus}
            />
          </Suspense>
        )}
        {!scope && (
          <>
            {!feedPage.data && !feedPage.error && <SkeletonCards count={4} />}
            {feedPage.data && feedPage.data.matches.length === 0 && page === 1 && (
              <div className="empty-state">
                <RadarIcon size={28} />
                <p>
                  {bothOn
                    ? `Nothing yet that your filter and ${chosenNames} both caught. Only alerts both caught is on in Settings, so tokens only one side caught are left out.`
                    : modelsOn
                      ? `Nothing yet from your filter or ${highConviction ? "the high-conviction alerts" : chosenNames}. Alerts land here the moment one comes in.`
                      : "Nothing caught by your filter yet. Turn on Model alerts in Settings to see the models' alerts here too."}
                </p>
                <button className="ghost" onClick={() => goTo("filters")}>
                  Tune your filter <ArrowRightIcon size={13} />
                </button>
              </div>
            )}
            <div
              className={`cards${feedPage.stale || (feedPage.error && feedPage.data) ? " stale" : ""}`}
              aria-busy={feedPage.stale}
              {...feedGridProps(look)}
            >
              {shownCards?.map((card) => (
                <SectionBoundary key={card.id} label="This card" size="card" resetKey={card}>
                  <AlertCard
                    card={card}
                    now={now}
                    labelSource
                    hide={hidden}
                    onHide={() => hideToken(card, cards ?? [])}
                  />
                </SectionBoundary>
              ))}
            </div>
            {hiddenCount > 0 && (
              <p className="muted small center mcap-hidden-note">
                {hiddenCount === 1 ? "1 alert" : `${hiddenCount} alerts`} now under $
                {look.hideBelowMcapUsd / 1000}K market cap {hiddenCount === 1 ? "is" : "are"} hidden here,
                with older alerts moved up in {hiddenCount === 1 ? "its" : "their"} place.{" "}
                <button type="button" className="link" onClick={() => openCustomize("cards")}>
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
                  onPointerEnter={prefetchOlder}
                  onFocus={prefetchOlder}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Older →
                </button>
              </nav>
            )}
          </>
        )}
        {stats.data && look.learningNote && (
          <div className={`learning-note${stats.stale ? " stale" : ""}`}>
            <BrainIcon size={14} />
            <span>
              Learning from{" "}
              <strong className="num">{stats.data.training.finalizedSamples.toLocaleString()}</strong> graded
              moments. Base 2x rate {pct(stats.data.training.baseWinRatePct, 1)}
              {stats.data.curator.modelTrainedAt &&
                `, model last trained ${ago(stats.data.curator.modelTrainedAt, now)}`}
              . <AsOf computedAt={stats.data.computedAt} now={now} />
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
