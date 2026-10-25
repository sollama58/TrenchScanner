import { useEffect, useMemo, useState } from "react";
import { lookupRequired, type Card } from "../api";
import {
  hasHolderList,
  holderFreshness,
  HOLDER_LIVE_GRACE_MS,
  holderListAt,
  type FlaggedHolder,
} from "../bubbleMap";
import { cachedGet } from "../cache";
import { chartForMint } from "../chartPoll";
import { useLiveMarketCaps, usePolling } from "../hooks";
import { coversFrom } from "../liveShares";
import { BubbleMapPlaceholder, BubbleMapSection } from "./BubbleMap";
import {
  AlertHoldersWhen,
  HolderFreshness,
  MomentHoldersWhen,
  SCAN_READ_MS,
  holdersMoment,
  useCoinScans,
  useHolderReading,
  useHoldersView,
  useHoldersUpdatedAt,
  useLiveShares,
} from "./HoldersView";
import { ClockIcon } from "./Icons";
import { LoadingNote } from "./Loading";

/**
 * One coin's bubble map with its Holders switch, as the token view draws it, on its own: the
 * browser extension's side panel and token-page tab show the site's own map with this (user ask
 * 2026-10-25), so it looks and acts the same. Its reads are the token view's: the card, the
 * newest scans and their holder wait, the chart read's flagged wallets, the top 50 and the live
 * trades. The full token view is a link away.
 */

/** The chart read's flagged wallets, as the token view polls them (TokenModal CHART_POLL_MS). */
const CHART_POLL_MS = 30_000;
/** The card is read again this often, for a call or match that lands while the map is open. */
const CARD_POLL_MS = 60_000;

interface ChartWallets {
  mint: string;
  wallets?: FlaggedHolder[];
}

type CardRead = { mint: string; card: Card | null; problem: "missing" | "failed" | null };

export function TokenMapView({ mint }: { mint: string }) {
  const [read, setRead] = useState<CardRead | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      cachedGet<Card>(`/tokens/${encodeURIComponent(mint)}/card`, CARD_POLL_MS / 2).then(
        (card) => live && setRead({ mint, card, problem: null }),
        (e: unknown) =>
          live &&
          setRead((r) =>
            // A read that fails after one landed keeps the map up.
            r?.mint === mint && r.card
              ? r
              : { mint, card: null, problem: lookupRequired(e) || isMissing(e) ? "missing" : "failed" },
          ),
      );
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, CARD_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [mint]);
  const shown = read?.mint === mint ? read : null;
  if (!shown?.card)
    return (
      <BubbleMapPlaceholder>
        <LoadingNote>
          {shown?.problem === "missing"
            ? "TrenchScanner doesn't track this coin yet."
            : shown?.problem === "failed"
              ? "Couldn't read this coin's map. Trying again shortly."
              : "Reading the bubble map…"}
        </LoadingNote>
      </BubbleMapPlaceholder>
    );
  return <CoinMap key={mint} card={shown.card} />;
}

function isMissing(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404;
}

function CoinMap({ card: cardIn }: { card: Card }) {
  const mint = cardIn.token.mintAddress;
  const base = `/tokens/${encodeURIComponent(mint)}`;
  const now = useNow();
  const scans = useCoinScans(mint, true);
  // The newest scan on the card, as the token view's useFreshCard puts it there.
  const card = useMemo(() => {
    const snap = scans.snapshots?.[0];
    if (!snap) return cardIn;
    const had = cardIn.latestSnapshot ? Date.parse(cardIn.latestSnapshot.takenAt) : 0;
    return Date.parse(snap.takenAt) > had ? { ...cardIn, latestSnapshot: snap } : cardIn;
  }, [cardIn, scans.snapshots]);
  // The token view's live tick, which also keeps the coin viewed, so it stays scanned while open.
  useLiveMarketCaps(useMemo(() => [card], [card]));
  const reads = scans.nextRead === null ? null : { nextRead: scans.nextRead, everyMs: SCAN_READ_MS };
  const alertAt = Date.parse(
    card.kind === "curated" ? (card.curated?.alertedAt ?? card.matchedAt) : card.matchedAt,
  );
  const chart = usePolling<ChartWallets>(`${base}/chart`, CHART_POLL_MS);
  const chartData = chartForMint(mint, chart.data, chart.stale);
  const flaggedKey = JSON.stringify(chartData?.wallets ?? []);
  const flagged = useMemo(() => JSON.parse(flaggedKey) as FlaggedHolder[], [flaggedKey]);
  const flags = chart.stale ? "loading" : chartData ? "ok" : chart.error ? "failed" : "loading";
  const linked = useHolderReading(card, false, scans.snapshots);
  const holders = useHoldersView(card, linked, alertAt, false);
  const liveShares = useLiveShares(base, holders.isKept);
  const updatedAt = useHoldersUpdatedAt(mint, holders.listReading, liveShares, holders.isKept);
  const listAt = holders.listReading ? holderListAt(holders.listReading) : NaN;
  const sharesMove = coversFrom(liveShares, listAt);
  const holdersFresh = (() => {
    if (holders.isKept || !holders.listReading || !hasHolderList(holders.listReading)) return undefined;
    const chain = holderFreshness(holders.listReading, now, reads);
    const liveUntil = sharesMove && chain.due !== null ? chain.due + HOLDER_LIVE_GRACE_MS : null;
    return {
      last: Math.max(chain.last, updatedAt ?? 0),
      next: chain.due,
      late: false,
      live: liveUntil !== null,
      liveUntil,
      gone: chain.due === null,
    };
  })();
  const bar = holders.canSwitch || (holders.reading && hasHolderList(holders.reading));
  return (
    <div className="tm-holders tm-map-only">
      {bar && (
        <div className={`tm-holders-bar${holders.isKept ? " at-alert" : ""}`}>
          {holders.canSwitch && (
            <div className="segmented small tm-holders-switch" role="radiogroup" aria-label="Holders at">
              {[...holders.options, { view: "now" as const, label: "Latest", at: Infinity }].map((o) => (
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
            holdersFresh && (
              <HolderFreshness
                fresh={holdersFresh}
                moment={holders.canSwitch ? undefined : holdersMoment(card, linked)}
              />
            )
          )}
        </div>
      )}
      <BubbleMapSection
        key={`${mint}:${holders.view}`}
        token={card.token}
        snapshot={holders.reading}
        moment={holders.moment}
        {...holders.wide}
        flagged={flagged}
        flags={flags}
        live={liveShares}
        freshness={holdersFresh}
        stamp={!bar}
      />
    </div>
  );
}

/** The clock the freshness lines count from, a second at a time. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
