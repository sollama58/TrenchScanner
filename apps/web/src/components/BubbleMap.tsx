import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { LoadingNote, SkelValue } from "./Loading";
import { LiveStamp, SecondsAgo, hms } from "./Freshness";
import type { Snapshot, Token } from "../api";
import { usePolling } from "../hooks";
import { invalidate } from "../cache";
import { ago, pct, tokenLabel } from "../format";
import {
  bubbleNameLines,
  showsPct,
  kolControl,
  kolBundledShare,
  type KolControl,
  type KolTie,
  cexSlots,
  CEX_COLOURS,
  cexGroupsOf,
  centreOf,
  exchangeName,
  regroupLayout,
  positionsOf,
  type MapPositions,
  needsRegroup,
  bundleOutline,
  kolBundleNodes,
  sideMembers,
  type SideGroup,
  MAP_COLOURS,
  nodeSlot,
  sameTimeSlot,
  buildGraph,
  HOLDER_POLL_MS,
  holderBadgeAt,
  holderListAt,
  liveWideFor,
  mapBadgeFreshness,
  clusterHalos,
  HALO_PAD,
  graphBounds,
  placeLabels,
  type MapLabel,
  layoutGraph,
  linkedCountText,
  type BubbleGraph,
  type SameTimeGroup,
  type FlaggedHolder,
  type FlagsRead,
  type MapNode,
  type BubbleMaps,
  type WideMap,
  withWideMap,
  clusterNumberText,
  funderNamed,
  largestSourceOnly,
  mapLinked,
  withoutTransfers,
  wideWithoutTransfers,
  TRAIT_ICON,
  RISKY_ICON,
  CLOCK_ICON,
  markerSpot,
  sameTimeShare,
  stretchWide,
  type TextBox,
  riskyShare,
  TRAIT_LABEL,
  traitShares,
  type WalletTrait,
  transferCurve,
  type TransferRoute,
  bandD,
  kolSideTies,
  linkKey,
  linkRoutes,
  transfersOfNode,
  transferWidth,
  type TransferLink,
} from "../bubbleMap";
import { renderBubbleCard } from "../bubbleMapCard";
import {
  coversFrom,
  listedShareDeltas,
  wideWithLiveShares,
  withLiveShares,
  type LiveTradeShares,
} from "../liveShares";
import { laneD } from "../linkLanes";
import { openWallet } from "../walletModal";
import {
  isFomoName,
  isKolLike,
  isPumpfunName,
  publicNames,
  isUsername,
  SWITCHABLE_NAMES,
  useWalletNames,
  visibleNames,
  walletText,
  type WalletName,
  type WalletNames,
} from "../walletNames";
import { WalletText } from "./WalletText";
import {
  cexCountText,
  countCutFor,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_LINKED_COUNT,
} from "./AlertCard";
import { useAppearance } from "../appearance";
import {
  possibleSideText,
  publicSides,
  sideGroups,
  usePossibleSides,
  type PossibleSides,
} from "../possibleSides";
import { ShareButton } from "./ShareImageDialog";
import { BubblesIcon, ChevronDownIcon, SlidersIcon } from "./Icons";
import { MAX_MAP_ZOOM, panZoom, zoomAround, zoomedBox, type MapBox, type MapZoom } from "../mapZoom";

/** How many cluster colours there are (styles.css --bm-0..4); more clusters reuse them. */
export const CLUSTER_COLOURS = MAP_COLOURS;

/**
 * A model-alerted coin's map over its top 50 (withWideMap), when it has one: null for any other
 * coin, or while it loads. The map stands without it.
 */
function useWideMap(mint: string): WideMap | null {
  return useBubbleMaps(mint)?.map ?? null;
}

/**
 * The coin's top-50 maps, live and as kept at its first call (GET /tokens/:mint/bubble-holders):
 * null while they load or when the read fails. One cached read serves every caller.
 */
export function useBubbleMaps(mint: string): BubbleMaps | null {
  // Re-read every HOLDER_POLL_MS while the view is open and the page visible, so a top 50 read
  // after it opened (or one that changed) shows without reopening it - and at once when
  // reloadBubbleMaps says so. Each read also marks the map as watched, which has the worker keep the
  // coin's top holders current while it is (user ask 2026-10-19): their balances from the holder
  // stream as they move, the list written each minute (bubbleMap.ts HOLDER_WRITE_MS).
  const path = bubbleMapsPath(mint);
  const version = useSyncExternalStore(subscribeMaps, () => mapsVersion.get(mint) ?? 0);
  const { data, stale } = usePolling<BubbleMaps>(path, HOLDER_POLL_MS, String(version));
  // A path change keeps the previous coin's maps up, flagged stale, until this coin's land.
  // Drawing those over this coin's holders mixes the two lists. A refetch of the same coin is
  // not stale.
  return stale ? null : data;
}

const bubbleMapsPath = (mint: string) => `/tokens/${encodeURIComponent(mint)}/bubble-holders`;

/** Per coin, bumped by reloadBubbleMaps: every view reading its maps re-reads them (a key bump). */
const mapsVersion = new Map<string, number>();
const mapsListeners = new Set<() => void>();
function subscribeMaps(listener: () => void) {
  mapsListeners.add(listener);
  return () => mapsListeners.delete(listener);
}

/**
 * Re-reads a coin's maps in every open view now, not on the next poll: a moment was just kept
 * (a filter alert's catch). Dropping the cache alone left it to the next poll, up to HOLDER_POLL_MS away, and
 * a read already in flight could put the answer from before it back.
 */
export function reloadBubbleMaps(mint: string): void {
  invalidate(bubbleMapsPath(mint));
  mapsVersion.set(mint, (mapsVersion.get(mint) ?? 0) + 1);
  for (const l of mapsListeners) l();
}

const hasReading = (v: { reading: unknown }) => v.reading != null;

/**
 * Whether a bubble-map refresh should wait for the redraw interval. Only a later reading of the
 * same coin waits. A different coin, or a frame that has nothing to draw, shows at once: the
 * previous coin's bubbles must not stay up for the interval (user ask 2026-10-19 is the same-coin
 * redraw, not a token switch).
 */
export function shouldHoldFrame(shownHasData: boolean, nextHasData: boolean, sameCoin: boolean): boolean {
  return sameCoin && shownHasData && nextHasData;
}

/**
 * `value`, taking each change at most once every `ms`: the newest when it comes due, so a run of
 * changes redraws once (user ask 2026-10-19). A value without data (`hasData` false), or the first
 * with it, shows at once. `coin` is the mint: a change drops the previous coin before paint.
 * `at` is when the value shown was taken, so the badge can say when the next redraw can come.
 */
function useEvery<T>(
  value: T,
  ms: number,
  hasData: (v: T) => boolean,
  coin: string,
): { value: T; at: number } {
  const [frame, setFrame] = useState(() => ({ coin, value, at: Date.now() }));
  const latest = useRef(value);
  latest.current = value;
  const lastAt = useRef(frame.at);
  // Adjusting state during render (React's previous-props pattern): the render that sees a new
  // coin returns that coin's value, so the previous coin's map cannot paint for a frame.
  if (frame.coin !== coin) {
    lastAt.current = Date.now();
    setFrame({ coin, value, at: lastAt.current });
  }
  useEffect(() => {
    if (frame.coin !== coin || value === frame.value) return;
    if (!shouldHoldFrame(hasData(frame.value), hasData(value), true)) {
      lastAt.current = Date.now();
      setFrame({ coin, value, at: lastAt.current });
      return;
    }
    const t = window.setTimeout(
      () => {
        lastAt.current = Date.now();
        setFrame({ coin, value: latest.current, at: lastAt.current });
      },
      Math.max(0, lastAt.current + ms - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [value, frame, ms, hasData, coin]);
  return frame.coin === coin ? { value: frame.value, at: frame.at } : { value, at: lastAt.current };
}

/**
 * The names of every wallet on the map. Funders are read with Helius's names, which tell an
 * exchange that funded holders; holders with TrenchScanner's own names only, unless Settings shows
 * Pump.fun, FOMO or Helius names on the map (user ask 2026-10-20: Helius's names rarely matter,
 * an exchange's aside).
 */
function useGraphNames(graph: BubbleGraph | null): WalletNames {
  const { bubbleNameLabels, bubbleNamesPumpfun, bubbleNamesFomo, bubbleNamesHelius } = useAppearance();
  const holderIdentity = bubbleNameLabels || !!bubbleNamesPumpfun || !!bubbleNamesFomo || !!bubbleNamesHelius;
  const funders = useWalletNames(
    useMemo(
      () => (graph ? [...graph.clusters.map((c) => c.funder), ...graph.cexLinks.map((l) => l.funder)] : []),
      [graph],
    ),
  );
  const holders = useWalletNames(
    useMemo(() => (graph ? graph.nodes.map((n) => n.wallet) : []), [graph]),
    holderIdentity ? FULL_NAMES : OWN_NAMES,
  );
  return useMemo(() => ({ ...holders, ...funders }), [holders, funders]);
}
/** useWalletNames' options: with Helius's names, or TrenchScanner's own only. */
const FULL_NAMES = { identity: true };
const OWN_NAMES = { identity: false };

/**
 * Whether the same-exchange ties show: the viewer's default from Settings, switchable on the map
 * (user ask 2026-10-13). Held above the map so its share image draws the ties too (2026-10-14).
 */
function useCexToggle(graph: BubbleGraph | null): { showCex: boolean; setCexOn: (on: boolean) => void } {
  const { bubbleCexLinks } = useAppearance();
  const [cexOn, setCexOn] = useState<boolean | null>(null);
  return { showCex: !!graph && (cexOn ?? bubbleCexLinks) && graph.cexLinks.length > 0, setCexOn };
}

/**
 * Whether the arrows between holders that sent the coin to each other show (user ask 2026-10-16):
 * on by default, switchable on the map like the exchange ties, with the default in Settings. Held
 * above the map so its share image draws them too.
 */
function useTransferToggle(snapshot: Snapshot | null | undefined): {
  showTransfers: boolean;
  setTransfersOn: (on: boolean) => void;
} {
  const { bubbleTransferLinks } = useAppearance();
  const [on, setTransfersOn] = useState<boolean | null>(null);
  return {
    showTransfers: (on ?? bubbleTransferLinks) && (snapshot?.holderTransfers?.length ?? 0) > 0,
    setTransfersOn,
  };
}

interface NameToggle {
  /** The names the map, its lists and its share image use: every name, or without the hidden kinds. */
  mapNames: WalletNames;
  /** Whether the map's one switch shows: the map has a name it would hide, and Settings doesn't set them kind by kind. */
  hasSwitchable: boolean;
  showNames: boolean;
  setNamesOn: (on: boolean) => void;
}

/**
 * Whether the Pump.fun, FOMO and Helius names show on the map (user ask 2026-10-16): off by
 * default, switchable on the map, with the default in Settings. Settings can also set each kind on
 * its own, and then the map has no switch for them. KOLs' names and exchanges' always show: an
 * exchange that funded holders keeps its Helius name. Held above the map so its share image follows
 * it too. `mapNames` is what the map, its lists and the share image name wallets by.
 */
function useNameToggle(graph: BubbleGraph | null, names: WalletNames): NameToggle {
  const { bubbleNameLabels, bubbleNamesPumpfun, bubbleNamesFomo, bubbleNamesHelius } = useAppearance();
  const [on, setNamesOn] = useState<boolean | null>(null);
  const split = bubbleNamesPumpfun !== null || bubbleNamesFomo !== null || bubbleNamesHelius !== null;
  const showNames = split ? bubbleNameLabels : (on ?? bubbleNameLabels);
  return useMemo(() => {
    const exchanges = new Set(graph?.cexLinks.map((l) => l.funder) ?? []);
    const hasSwitchable =
      !split && Object.keys(names).some((w) => SWITCHABLE_NAMES.has(names[w]!.source) && !exchanges.has(w));
    const look = { bubbleNameLabels, bubbleNamesPumpfun, bubbleNamesFomo, bubbleNamesHelius };
    const mapNames = visibleNames(names, look, showNames, exchanges);
    return { mapNames, hasSwitchable, showNames, setNamesOn };
  }, [
    graph,
    names,
    showNames,
    split,
    bubbleNameLabels,
    bubbleNamesPumpfun,
    bubbleNamesFomo,
    bubbleNamesHelius,
  ]);
}

/**
 * KOLs' possible side wallets among the holders (the Side Wallet Checker's recent matches), and
 * whether their ties show: on by default, switchable like the exchange ties (user ask 2026-10-14).
 * Held above the map so its share image draws and lists them too. Drawn only: never in the Linked
 * count, the safety screen or the models.
 */
function useSideToggle(graph: BubbleGraph | null): SideToggle {
  const { bubbleSideLinks } = useAppearance();
  const holderWallets = useMemo(
    () => (graph ? graph.nodes.flatMap((n) => (n.kind === "holder" && n.wallet ? [n.wallet] : [])) : []),
    [graph],
  );
  const sides = usePossibleSides(holderWallets);
  const groups = useMemo(() => sideGroups(holderWallets, sides), [holderWallets, sides]);
  const [sideOn, setSideOn] = useState<boolean | null>(null);
  const showSides = (sideOn ?? bubbleSideLinks) && groups.length > 0;
  return { sides, groups, showSides, shown: showSides ? groups : NO_SIDES, setSideOn };
}
/** Each KOL on the map with the holders tied to it (kolControl); none without a map. */
function useKols(
  graph: BubbleGraph | null,
  groups: readonly SideGroup[],
  names: WalletNames,
  transfers: boolean,
): KolControl[] {
  return useMemo(() => kolsOn(graph, groups, names, transfers), [graph, groups, names, transfers]);
}

/**
 * The share image's view of the map with none of the reader's own labels (user ask 2026-10-18:
 * labels stay private to the reader): their names, their side ties and the bundles drawn for them
 * left out, the roster's KOLs as everyone sees them.
 */
function publicShare(
  graph: BubbleGraph,
  names: WalletNames,
  allNames: WalletNames,
  side: SideToggle,
  transfers: boolean,
): { names: WalletNames; shown: readonly SideGroup[]; kols: KolControl[]; drawn: readonly KolControl[] } {
  const holders = graph.nodes.flatMap((n) => (n.kind === "holder" && n.wallet ? [n.wallet] : []));
  const groups = sideGroups(holders, publicSides(side.sides));
  const kols = kolsOn(graph, groups, publicNames(allNames), transfers);
  return {
    names: publicNames(names),
    shown: side.showSides ? groups : NO_SIDES,
    kols,
    drawn: side.groups.length > 0 && !side.showSides ? NO_KOLS : kols,
  };
}

function kolsOn(
  graph: BubbleGraph | null,
  groups: readonly SideGroup[],
  names: WalletNames,
  transfers: boolean,
): KolControl[] {
  return graph
    ? kolControl(
        graph,
        groups,
        graph.nodes.flatMap((n) => {
          const named = n.kind === "holder" && n.wallet ? names[n.wallet] : undefined;
          // A wallet the reader labeled is one of the KOLs for them, KOL or User Tracked.
          return n.wallet && isKolLike(named)
            ? [
                {
                  wallet: n.wallet,
                  name: named!.name,
                  ...(named!.mine ? { tracked: named!.source === "tracked" } : {}),
                },
              ]
            : [];
        }),
        transfers ? graph.transferLinks : [],
        transfers ? graph.fundingClusters : undefined,
        (w) => names[w]?.service === true,
      )
    : [];
}

/**
 * KOL Bundled % for the share image: the scan's figure (what the filters and models read), else
 * the map's own groups, else unknown.
 */
const NO_KOLS: readonly KolControl[] = [];

/** The KOL bundles to draw: none while the KOL side wallets switch is there and off, else every one. */
function drawnKolsFor(side: SideToggle, kols: readonly KolControl[]): readonly KolControl[] {
  return side.groups.length > 0 && !side.showSides ? NO_KOLS : kols;
}

function kolBundledFor(snapshot: Snapshot | null | undefined, kols: readonly KolControl[]): number | null {
  return snapshot?.kolBundledPct ?? (kols.length > 0 ? kolBundledShare(kols) : null);
}

interface SideToggle {
  /** Each holder's possible-side matches, for its title and detail. */
  sides: PossibleSides;
  /** The KOLs with possible side wallets on the map, whether shown or not. */
  groups: SideGroup[];
  showSides: boolean;
  /** The groups to draw: `groups` while they show, else none. */
  shown: readonly SideGroup[];
  setSideOn: (on: boolean) => void;
}
const NO_SIDES: readonly SideGroup[] = [];

function MapView({
  graph,
  names,
  showCex,
  setCexOn,
  showTransfers,
  setTransfersOn,
  side,
  nameToggle,
  flags,
  scanKolBundled,
  column = false,
  spread,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  /** Whether the Pump.fun, FOMO and Helius names show (useNameToggle). */
  nameToggle: NameToggle;
  /** Whether the same-exchange ties show (useCexToggle). */
  showCex: boolean;
  setCexOn: (on: boolean) => void;
  /** Whether the holder-to-holder transfer arrows show (useTransferToggle). */
  showTransfers: boolean;
  setTransfersOn: (on: boolean) => void;
  /** KOLs' possible side wallets and whether they show (useSideToggle). */
  side: SideToggle;
  /** Whether the flagged wallets (the risky rings) have been read. */
  flags: FlagsRead;
  /** The scan's KOL Bundled % (TokenSnapshot.kolBundledPct); null while unknown. */
  scanKolBundled: number | null;
  /** Laid out to fit a fixed column (Scope's desktop page): the lists, figures and wallet types first, the map under them. */
  column?: boolean;
  /** How far sideways the map may spread (BubbleSvg). */
  spread?: number;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  // The cluster picked from the list, by its funder: its index can move when the map updates.
  const [focusFunder, setFocusFunder] = useState<string | null>(null);
  const focusIndex = focusFunder === null ? -1 : graph.clusters.findIndex((c) => c.funder === focusFunder);
  const focus = focusIndex < 0 ? null : focusIndex;
  // The group under the map whose wallets are listed open: "c:", "x:" or "t:" and its key.
  const [listed, setListed] = useState<string | null>(null);
  const node = graph.nodes.find((n) => n.id === picked) ?? null;
  // A picked bubble's cluster lights up; so does a cluster picked from the list.
  const lit = node ? node.cluster : focus;
  const risky = riskyShare(graph);
  const traits = new Map(traitShares(graph).map((t) => [t.trait, t]));
  const { sides, groups, showSides, setSideOn } = side;
  // Each KOL and the supply it may control: side wallets, KOL funded wallets and their linked holders.
  const kols = useKols(graph, groups, names, showTransfers);
  // KOL Bundled % in place of the old cluster count (user ask 2026-10-15): the scan's figure, else
  // the map's own KOL groups, as the share image reads it.
  const kolBundled = scanKolBundled ?? (kols.length > 0 ? kolBundledShare(kols) : null);
  // With the ties on, the bubbles rearrange so each exchange's holders sit together (user ask
  // 2026-10-13); off, the usual layout comes back as it was.
  // KOLs' side wallets gather round them the same way while their ties show.
  // Each KOL's bundle sits together too, its pill by the KOL (user ask 2026-10-15).
  // Holders that sent the coin to each other sit a little closer while their arrows show.
  // The KOL side wallets switch off: no KOL bundle is gathered, ringed or labelled on the map, its
  // list or its share image (user ask 2026-10-16); the KOL Bundled and Linked figures stay.
  const drawnKols = drawnKolsFor(side, kols);
  // A refresh with the same ties on settles from the last regrouped drawing (layoutGraph's prev).
  const lastRegrouped = useRef<{ key: string; at: MapPositions } | null>(null);
  const regrouped = useMemo(() => {
    const opts = { cex: showCex, sides: side.shown, kols: drawnKols, transfers: showTransfers };
    if (!needsRegroup(opts)) return null;
    const key = JSON.stringify([showCex, showTransfers, side.shown.length > 0, drawnKols.length > 0]);
    const last = lastRegrouped.current;
    const laid = regroupLayout(graph, { ...opts, prev: last?.key === key ? last.at : null });
    lastRegrouped.current = { key, at: positionsOf(laid) };
    return laid;
  }, [graph, showCex, side.shown, drawnKols, showTransfers]);
  const xfer = graph.transferPct;
  const cex = graph.cexCount;
  // Linked takes in KOLs' bundles and the wider map's links, out of every holder read (mapLinked).
  const linked = mapLinked(graph, kols);
  // Supply tied to the creator (user ask 2026-10-17): a tile of its own only when there is some.
  const devTied = graph.creatorPct !== null && graph.creatorPct > 0;

  const cols = 3 + (graph.sameTimeGroups.length > 0 ? 1 : 0) + (xfer !== null ? 1 : 0) + (devTied ? 1 : 0);
  // The headline tiles: Linked, KOL bundled, same minute, CEX-funded, tied to dev, transferred.
  const headline = (
    <>
      <div
        className={
          linked.count !== null &&
          linked.count.linked >= countCutFor(SAFETY_REJECT_LINKED_COUNT, linked.count.of)
            ? "risky"
            : undefined
        }
      >
        <dt>Linked</dt>
        <dd
          className="num"
          title={
            linked.pct === null
              ? undefined
              : `${linked.count ? `${linked.count.linked} of the top ${linked.count.of} holders, holding ` : ""}${pct(linked.pct, 1)} of supply, counting wallets in a funder's cluster or a KOL's bundle`
          }
        >
          {/* N/25 and, beside it, the share of supply those linked holders hold (user ask 2026-10-14). */}
          {linked.count && linked.pct !== null ? (
            <>
              {linkedCountText(linked.count)} <span className="bm-stat-sub">({pct(linked.pct, 1)})</span>
            </>
          ) : (
            (linkedCountText(linked.count) ?? pct(linked.pct, 1))
          )}
        </dd>
      </div>
      <div
        title={
          kolBundled === null
            ? "KOL bundled: not checked yet. It comes with the linked-wallet reading."
            : "KOL bundled: supply held by KOLs and the top holders tied to them (wallets a KOL funded, probable side wallets, and holders sharing a funder or funding minute with those)"
        }
      >
        <dt>KOL bundled</dt>
        <dd className={kolBundled === null ? "muted" : "num"}>
          {kolBundled === null ? "–" : pct(kolBundled, 1)}
        </dd>
      </div>
      {graph.sameTimeGroups.length > 0 && (
        <div
          className="bm-same-stat"
          title={`Top holders funded within a minute of each other, from any funders${
            graph.sameTimePct === null ? "" : `, holding ${pct(graph.sameTimePct, 1)} of supply`
          }`}
        >
          <dt>Same minute</dt>
          <dd className="num">{linkedCountText(graph.sameTimeCount) ?? pct(graph.sameTimePct, 1)}</dd>
        </div>
      )}
      <div
        className={
          cex !== null && cex.linked >= countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, cex.of)
            ? "risky"
            : undefined
        }
        title={
          cex === null
            ? "CEX-funded: not checked yet"
            : `CEX-funded: ${cex.linked} of the ${cex.of} largest holders were opened from an exchange (or a busy service like a bridge)`
        }
      >
        <dt>CEX-funded</dt>
        <dd className="num">
          {cex === null ? "-" : (cexCountText(cex.linked, cex.of) ?? pct(graph.cexPct, 0))}
        </dd>
      </div>
      {devTied && (
        <div
          className="risky"
          title={`Tied to dev: ${pct(graph.creatorPct, 1)} of supply is held by ${
            graph.creatorCount ? `${graph.creatorCount} ` : ""
          }top holders the creator or its funder paid for, or that got SOL or the coin from one that was. The creator's own holding is left out.`}
        >
          <dt>Tied to dev</dt>
          <dd className="num">{pct(graph.creatorPct, 1)}</dd>
        </div>
      )}
      {/* Transferred Supply % (user ask 2026-10-16): the coin moved holder to holder among the top
          25, a stat of its own beside Linked, never counted in it. */}
      {xfer !== null && (
        <div
          className={`bm-xfer-stat${xfer > 0 ? " has" : ""}`}
          title={
            xfer === 0
              ? `Transferred: none of the top ${graph.transferCount?.of ?? 25} holders sent the coin to another`
              : `Transferred Supply %: ${pct(xfer, 1)} of supply moved holder to holder${
                  graph.transferCount
                    ? `, between ${graph.transferCount.linked} of the top ${graph.transferCount.of} holders`
                    : ""
                }. The coin itself only: SOL and other coins are ignored. Not counted in Linked.`
          }
        >
          <dt>Transferred</dt>
          <dd className="num">
            {pct(xfer, 1)}
            {graph.transferCount && xfer > 0 && (
              <>
                {" "}
                <span className="bm-stat-sub">
                  ({graph.transferCount.linked}/{graph.transferCount.of})
                </span>
              </>
            )}
          </dd>
        </div>
      )}
    </>
  );
  // Fresh, sniper, empty and risky wallets on the map, each its count and supply: a row of its own
  // under the headline tiles (user asks 2026-10-15, 2026-10-16).
  const traitsStat = (
    <div className="bm-traits-stat">
      <dt>Wallet types</dt>
      <dd>
        <ul className="bm-wt-list">
          {TRAIT_ORDER.map((t) => {
            const s = traits.get(t);
            return (
              <WalletTypeItem
                key={t}
                tone={t}
                icon={<TraitIcon trait={t} size={17} />}
                label={TRAIT_LABEL[t]}
                count={s?.count ?? 0}
                share={pct(s?.pct ?? 0, 1)}
                title={`${TRAIT_WORDS[t]}. ${s?.count ?? 0} on the map, holding ${pct(s?.pct ?? 0, 1)} of supply`}
              />
            );
          })}
          <WalletTypeItem
            tone="risky"
            icon={<RiskyIcon />}
            label="Risky"
            count={flags === "ok" ? risky.count : null}
            share={flags === "ok" ? pct(risky.pct, 1) : flags === "failed" ? "not read" : "loading"}
            title={
              flags === "ok"
                ? `${RISKY_WORDS}. ${risky.count} on the map, holding ${pct(risky.pct, 1)} of supply`
                : flags === "failed"
                  ? "Risky: couldn't load the flagged wallets, so no risky ones are ringed. Not a clean reading."
                  : "Risky: loading the flagged wallets"
            }
          />
        </ul>
      </dd>
    </div>
  );
  const map = (
    <BubbleSvg
      spread={spread}
      graph={regrouped ?? graph}
      names={names}
      picked={picked}
      lit={lit}
      cexLinks={showCex}
      transfers={showTransfers}
      sideGroups={side.shown}
      kols={drawnKols}
      sides={sides}
      onPick={(id) => {
        setPicked(id);
        setFocusFunder(null);
        // A wallet's bubble (a holder, or the funder behind a cluster) opens that wallet's modal;
        // the "others" bubble has no one wallet, so it only lights up.
        const wallet = graph.nodes.find((n) => n.id === id)?.wallet;
        if (wallet) openWallet(wallet);
      }}
    />
  );
  // The map's switches sit under the legend (user ask 2026-10-16).
  const toggles = (graph.cexLinks.length > 0 ||
    groups.length > 0 ||
    graph.transferLinks.length > 0 ||
    nameToggle.hasSwitchable) && (
    <div className="bm-toggles">
      {graph.transferLinks.length > 0 && (
        <MapToggle on={showTransfers} onToggle={() => setTransfersOn(!showTransfers)} keyClass="bm-xfer-key">
          Holder transfers
        </MapToggle>
      )}
      {graph.cexLinks.length > 0 && (
        <MapToggle on={showCex} onToggle={() => setCexOn(!showCex)} keyClass="bm-cex-key">
          Same-exchange ties
        </MapToggle>
      )}
      {groups.length > 0 && (
        <MapToggle on={showSides} onToggle={() => setSideOn(!showSides)} keyClass="bm-cex-key bm-side-key">
          KOL side wallets
        </MapToggle>
      )}
      {nameToggle.hasSwitchable && (
        <MapToggle
          on={nameToggle.showNames}
          onToggle={() => nameToggle.setNamesOn(!nameToggle.showNames)}
          keyClass="bm-name-key"
        >
          Pump.fun / FOMO / Helius names
        </MapToggle>
      )}
    </div>
  );
  const groupPanel = (
    <GroupPanel
      column={column}
      graph={graph}
      names={names}
      kols={drawnKols}
      transfers={showTransfers}
      listed={listed}
      lit={lit}
      onSelect={(key, cluster) => {
        const open = listed !== key;
        setPicked(null);
        setFocusFunder(open && cluster !== undefined ? (graph.clusters[cluster]?.funder ?? null) : null);
        setListed(open ? key : null);
      }}
    />
  );

  if (column)
    return (
      <>
        {toggles && <MapLayers>{toggles}</MapLayers>}
        {groupPanel}
        {/* The figures sit under the Clusters / Exchanges / Transfers lists (user ask 2026-10-24). */}
        <dl className="bm-stats bm-col-figs" style={{ "--bm-cols": cols } as React.CSSProperties}>
          {headline}
        </dl>
        <dl className="bm-stats bm-col-traits">{traitsStat}</dl>
        {map}
      </>
    );
  return (
    <>
      <dl className="bm-stats" style={{ "--bm-cols": cols } as React.CSSProperties}>
        {headline}
        {traitsStat}
      </dl>
      {map}
      <NameLegend graph={graph} names={names} />
      {toggles}
      <NodeDetail node={node} graph={graph} names={names} sides={sides} />
      {groupPanel}
    </>
  );
}

/**
 * The map's switches folded behind one button in the section's heading, for a fixed column where a
 * row of them would squeeze the map. Closes on a tap outside it or Escape.
 */
function MapLayers({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        // Escape folds the switches away, not the whole window.
        e.preventDefault();
        el.open = false;
      } else if (!el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details className="bm-layers" ref={ref}>
      <summary title="What the map draws">
        <SlidersIcon size={13} /> Show
      </summary>
      <div className="bm-layers-pop">{children}</div>
    </details>
  );
}

/** How each tie to a KOL reads in its wallet list. */
const KOL_TIE_TEXT: Record<KolTie, string> = {
  kol: "KOL",
  known: "Known side",
  funded: "KOL funded",
  side: "Probable side",
  cluster: "Same funder",
  "same-minute": "Same minute",
  transfer: "Got a transfer",
};

/** "4 wallets · 1 KOL funded · 2 probable sides": what a KOL's row holds. */
function kolSummary(k: KolControl): string {
  const count = (t: KolTie) => k.wallets.filter((w) => w.tie === t).length;
  const known = count("known");
  const funded = count("funded");
  const side = count("side");
  const linked = count("cluster") + count("same-minute") + count("transfer");
  return [
    `${k.wallets.length} wallet${k.wallets.length === 1 ? "" : "s"}`,
    known > 0 ? `${known} known side${known === 1 ? "" : "s"}` : null,
    funded > 0 ? `${funded} KOL funded` : null,
    side > 0 ? `${side} probable side${side === 1 ? "" : "s"}` : null,
    linked > 0 ? `${linked} linked` : null,
    k.holds ? null : "KOL not holding",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The exchanges' section under the map: kept out of largestSourceOnly. */
const EXCHANGES = "Exchanges";
/** The holder-to-holder transfers' section: kept out of largestSourceOnly too (a pair, not a bundle). */
const TRANSFERS = "Transfers";

/** One group under the map: a funder's cluster, a KOL's holdings, an exchange's, a funding minute. */
interface PanelGroup {
  key: string;
  title: React.ReactNode;
  sub: string;
  pct: number;
  style: React.CSSProperties;
  dot: React.ReactNode;
  wallets: readonly { wallet: string; pct: number; tag?: string }[];
  /** The wallet that paid for them, listed last. */
  funder?: string;
  /** A funder cluster's index, lit on the map while picked. */
  cluster?: number;
}

/**
 * The groups under the map in two columns (user ask 2026-10-14): on the left every cluster, KOL,
 * exchange and funding minute with its share of supply; on the right the picked one's wallets,
 * largest first, each opening its wallet modal. Stacked on a phone.
 */
function GroupPanel({
  graph,
  names,
  kols,
  transfers,
  listed,
  lit,
  onSelect,
  column = false,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  kols: readonly KolControl[];
  /** Whether the transfer arrows show: their pairs are listed while they do. */
  transfers: boolean;
  listed: string | null;
  lit: number | null;
  onSelect: (key: string, cluster?: number) => void;
  /** In a fixed column: the lists scroll in their own box, the hint is left off and wallets show only once picked. */
  column?: boolean;
}) {
  const detail = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Each kind folds to its heading and only one opens at a time (user ask 2026-10-18).
  const [openSection, setOpenSection] = useState<string | null>(null);
  const all: { title: string; groups: PanelGroup[] }[] = [
    {
      title: "Clusters",
      groups: graph.clusters.map((c, i) => ({
        key: `c:${c.funder}`,
        // An unknown funder isn't named, its cluster numbered instead (user ask 2026-10-15).
        title: clusterNumberText(graph, i, names) ?? (
          <>
            Funder <WalletText wallet={c.funder} names={names} />
          </>
        ),
        sub: `${c.wallets.length} wallets${creatorTiedText(graph, c)}`,
        pct: c.pct,
        style: { "--bm": `var(--bm-${i % CLUSTER_COLOURS})` } as React.CSSProperties,
        dot: <i className="bm-dot" aria-hidden="true" />,
        wallets: c.wallets,
        funder: c.funder,
        cluster: i,
      })),
    },
    {
      title: "KOLs",
      groups: kols.map((k) => ({
        key: `k:${k.kolWallet}`,
        title: (
          <>
            {k.tracked ? "Tracked" : "KOL"} <WalletText wallet={k.kolWallet} names={names} />
            {!names[k.kolWallet] && k.kolName ? ` ${k.kolName}` : ""}
          </>
        ),
        sub: kolSummary(k),
        pct: k.pct,
        style: { "--bm": kolColour(kols.indexOf(k)) } as React.CSSProperties,
        dot: <i className="bm-dot" aria-hidden="true" />,
        wallets: k.wallets.map((w) => ({ wallet: w.wallet, pct: w.pct, tag: KOL_TIE_TEXT[w.tie] })),
      })),
    },
    // Funded-together groups list above the exchanges (user ask 2026-10-15).
    {
      title: "Funded together",
      groups: graph.sameTimeGroups.map((g, i) => ({
        key: `t:${g.atMs}`,
        title: <span className="num">{fundingTime(g.atMs)}</span>,
        sub: `${g.wallets.length} wallets within ${Math.max(1, Math.round(g.spanMs / 1000))}s${sameTimeFunders(g)}`,
        pct: g.pct,
        style: { "--bm": `var(--bm-${sameTimeSlot(graph, i)})` } as React.CSSProperties,
        dot: <i className="bm-same-dot" aria-hidden="true" />,
        wallets: g.wallets,
      })),
    },
    {
      title: EXCHANGES,
      groups: cexGroupsOf(graph).map((g, i) => ({
        key: `x:${g.funder}`,
        title: (
          <>
            Exchange <WalletText wallet={g.funder} names={names} />
          </>
        ),
        sub: `${g.nodes.length} wallets it funded`,
        pct: g.pct,
        style: {
          "--bm": "var(--bm-none)",
          "--bm-cex": `var(--bm-cex-${i % CEX_COLOURS})`,
        } as React.CSSProperties,
        dot: <i className="bm-cex-key bm-cex-dot" aria-hidden="true" />,
        wallets: g.nodes.flatMap((n) => (n.wallet ? [{ wallet: n.wallet, pct: n.pct }] : [])),
        funder: g.funder,
      })),
    },
    // Each sender and receiver among the top holders (user ask 2026-10-16), largest move first.
    {
      title: TRANSFERS,
      groups: (transfers ? graph.transferLinks : []).flatMap((l) => {
        const from = graph.nodes.find((n) => n.id === l.from);
        const to = graph.nodes.find((n) => n.id === l.to);
        if (!from?.wallet || !to?.wallet) return [];
        return [
          {
            key: `s:${l.from}>${l.to}`,
            title: (
              <span className="bm-xfer-pair">
                <WalletText wallet={from.wallet} names={names} />
                <TransferArrow />
                <WalletText wallet={to.wallet} names={names} />
              </span>
            ),
            sub: `${l.count} transfer${l.count === 1 ? "" : "s"}${l.lastAtMs !== null ? ` · last ${agoText(l.lastAtMs)}` : ""}`,
            pct: l.pct,
            style: { "--bm": "var(--bm-xfer)" } as React.CSSProperties,
            dot: <i className="bm-xfer-dot" aria-hidden="true" />,
            wallets: [
              { wallet: from.wallet, pct: from.pct, tag: `Sent ${xferPctText(l.pct)}` },
              { wallet: to.wallet, pct: to.pct, tag: `Got ${xferPctText(l.pct)}` },
            ],
          },
        ];
      }),
    },
  ];
  // A group that falls under two kinds (a funding minute inside a funder's cluster, a cluster a KOL's
  // bundle takes in) lists once, under the largest (user ask 2026-10-15). An exchange's holders
  // aren't a confirmed cluster, so they neither hide another group nor are hidden.
  const kept = new Set(
    largestSourceOnly(
      all
        .filter((sec) => sec.title !== EXCHANGES && sec.title !== TRANSFERS)
        .flatMap((sec) =>
          sec.groups.map((g) => ({
            kind: sec.title,
            pct: g.pct,
            wallets: g.wallets.map((w) => w.wallet),
            g,
          })),
        ),
    ).map((x) => x.g),
  );
  const sections = all
    .map((sec) => ({
      ...sec,
      groups:
        sec.title === EXCHANGES || sec.title === TRANSFERS
          ? sec.groups
          : sec.groups.filter((g) => kept.has(g)),
    }))
    .filter((sec) => sec.groups.length > 0);
  if (sections.length === 0) return null;
  const picked = sections.flatMap((sec) => sec.groups).find((g) => g.key === listed) ?? null;
  const pickedIn = picked ? sections.find((sec) => sec.groups.includes(picked))!.title : null;
  const pick = (g: PanelGroup) => {
    onSelect(g.key, g.cluster);
    // Stacked on a phone, the wallets sit under the list: bring them into view.
    if (listed !== g.key && (column || window.matchMedia("(max-width: 640px)").matches))
      window.setTimeout(() => detail.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };
  return (
    <div className={`bm-groups${column ? " bm-groups-col" : ""}`}>
      <div className="bm-group-list">
        {sections.map((sec, si) => {
          const open = openSection === sec.title;
          const total = sectionTotal(sec.title, sec.groups);
          return (
            <section key={sec.title} className={`bm-group-section${open ? " open" : ""}`}>
              <h4>
                <button
                  type="button"
                  className={`bm-section-btn${pickedIn === sec.title && !open ? " has-pick" : ""}`}
                  aria-expanded={open}
                  aria-controls={`${listId}-${si}`}
                  onClick={() => setOpenSection(open ? null : sec.title)}
                >
                  <span className="bm-section-title">{sec.title}</span>
                  <span className="bm-section-count num">{sec.groups.length}</span>
                  <span
                    className="num bm-section-pct"
                    title={
                      sec.title === TRANSFERS
                        ? "Supply moved holder to holder across these pairs"
                        : "Combined share of supply held by these wallets, each wallet counted once"
                    }
                  >
                    {pct(total, 1)}
                  </span>
                  <ChevronDownIcon size={15} className="bm-section-chev" />
                </button>
              </h4>
              {open && (
                <ul id={`${listId}-${si}`}>
                  {sec.groups.map((g) => {
                    const on = listed === g.key || (g.cluster !== undefined && lit === g.cluster);
                    return (
                      <li key={g.key}>
                        <button
                          type="button"
                          className={`bm-cluster${on ? " on" : ""}`}
                          style={g.style}
                          aria-pressed={listed === g.key}
                          onClick={() => pick(g)}
                        >
                          {g.dot}
                          <span className="bm-cluster-name">{g.title}</span>
                          <span className="muted small">{g.sub}</span>
                          <span className="num bm-cluster-pct">{pct(g.pct, 1)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <div className="bm-group-detail" ref={detail} aria-live="polite" hidden={column && !picked}>
        {picked ? (
          <GroupWallets group={picked} names={names} />
        ) : (
          <p className="muted small bm-group-hint">
            Open a list and pick a cluster or KOL to list its wallets and their share of supply. Each wallet
            opens its own view.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A kind's total beside its folded heading: the supply its wallets hold, each wallet counted once
 * (a KOL's bundle can share wallets with another's), or for transfers the supply moved.
 */
function sectionTotal(title: string, groups: readonly PanelGroup[]): number {
  if (title === TRANSFERS) return groups.reduce((t, g) => t + g.pct, 0);
  const held = new Map(groups.flatMap((g) => g.wallets.map((w) => [w.wallet, w.pct] as const)));
  return [...held.values()].reduce((t, p) => t + p, 0);
}

/** A picked group's wallets, largest first, each opening its wallet modal; the funder last. */
function GroupWallets({ group, names }: { group: PanelGroup; names: WalletNames }) {
  const rows = [...group.wallets].sort((a, b) => b.pct - a.pct);
  return (
    <>
      <header className="bm-detail-head" style={group.style}>
        {group.dot}
        <span className="bm-cluster-name">{group.title}</span>
        <span className="num bm-cluster-pct">{pct(group.pct, 1)}</span>
      </header>
      <ol className="bm-group-wallets">
        {rows.map((w, i) => (
          <li key={w.wallet}>
            <button type="button" onClick={() => openWallet(w.wallet)} title="Open this wallet">
              <span className="num faint bm-rank">{i + 1}</span>
              <WalletText wallet={w.wallet} names={names} />
              {w.tag && <span className="bm-tie">{w.tag}</span>}
              <span className="num bm-wallet-pct">{pctText(w.pct)}</span>
            </button>
          </li>
        ))}
        {group.funder && (
          <li className="bm-group-funder">
            <button type="button" onClick={() => openWallet(group.funder!)} title="Open the funder">
              <span className="bm-rank" />
              <span>
                <span className="muted">Funder</span> <WalletText wallet={group.funder} names={names} />
              </span>
              <span className="muted small bm-wallet-pct">paid for them</span>
            </button>
          </li>
        )}
      </ol>
    </>
  );
}

/** One of the map's tie switches: a pill with the app's switch, the tie's line sample and its name. */
function MapToggle({
  on,
  onToggle,
  keyClass,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  keyClass: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch bm-toggle${on ? " on" : ""}`}
      onClick={onToggle}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      <span className={keyClass} aria-hidden />
      {children}
    </button>
  );
}

/** What each colour of name on the bubbles means; only the kinds this map shows. */
function NameLegend({ graph, names }: { graph: BubbleGraph; names: WalletNames }) {
  const kinds = new Set(
    graph.nodes.flatMap((n) =>
      n.kind === "holder" && n.wallet && names[n.wallet] ? [names[n.wallet]!.source] : [],
    ),
  );
  // Each kind's own name, written the way its names are (user ask 2026-10-14): KOL, "Pump.fun", "FOMO".
  const items: { cls: string; text: string }[] = [];
  if (kinds.has("kol")) items.push({ cls: "kol", text: "KOL" });
  if (kinds.has("tracked")) items.push({ cls: "tracked", text: "User Tracked" });
  if (kinds.has("pumpfun")) items.push({ cls: "pumpfun", text: '"Pump.fun"' });
  if (kinds.has("fomo")) items.push({ cls: "fomo", text: '"FOMO"' });
  if (kinds.has("identity") || kinds.has("exchange")) items.push({ cls: "", text: "Helius / exchange" });
  // Each wallet trait on the map, its icon and the share of supply its holders hold (user ask 2026-10-15).
  const traits = traitShares(graph);
  // The same-minute clock, its holders' share beside it (user ask 2026-10-16).
  const same = sameTimeShare(graph);
  if (!items.length && !traits.length && !same.count) return null;
  return (
    <ul className="bm-legend" aria-label="Legend">
      <li className="bm-legend-title" aria-hidden>
        Legend
      </li>
      {items.map((it) => (
        <li key={it.text}>
          <span className={`bm-legend-chip ${it.cls}`}>{it.text}</span>
        </li>
      ))}
      {traits.map((t) => (
        <li
          key={t.trait}
          className="bm-legend-trait"
          title={`${TRAIT_WORDS[t.trait]}. ${t.count} holder${t.count === 1 ? "" : "s"} on the map, holding ${pctText(t.pct)} of supply`}
        >
          <TraitIcon trait={t.trait} />
          {TRAIT_LABEL[t.trait]} <span className="num">{pctText(t.pct)}</span>
        </li>
      ))}
      {same.count > 0 && (
        <li
          className="bm-legend-trait"
          title={`Funded the same minute: ${same.count} holder${same.count === 1 ? "" : "s"} on the map, holding ${pctText(same.pct)} of supply`}
        >
          <svg className="bm-trait-icon bm-clock-icon" viewBox="0 0 24 24" width={13} height={13} aria-hidden>
            {CLOCK_ICON.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
          Funded together <span className="num">{pctText(same.pct)}</span>
        </li>
      )}
    </ul>
  );
}

/** The stage's width over its height, as laid out now (and on each resize); null before it's measured. */
function useStageSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const { width, height } = el.getBoundingClientRect();
      // Whole pixels, so a fraction's change doesn't draw the map again.
      const w = Math.round(width);
      const h = Math.round(height);
      if (w > 0 && h > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * How much to enlarge the bubbles' text on a map drawn small (user ask 2026-10-19: far too small to
 * read in Scope's column): enough that it shows near its own size, up to TEXT_BOOST_MAX. A map drawn
 * at full size, or zoomed in to it, keeps its text as laid out.
 */
export function textBoost(stage: { w: number; h: number } | null, view: { w: number; h: number }): number {
  if (!stage || !(view.w > 0) || !(view.h > 0)) return 1;
  const scale = Math.min(stage.w / view.w, stage.h / view.h);
  return Math.min(TEXT_BOOST_MAX, Math.max(1, TEXT_TARGET_SCALE / scale));
}
/** The on-screen scale the bubbles' text is brought up to. */
const TEXT_TARGET_SCALE = 0.95;
const TEXT_BOOST_MAX = 1.5;
const PILL_BOOST_MAX = 1.25;

/**
 * Zoom and move around the map (user ask 2026-10-18), as the chart does: scroll or pinch to zoom
 * (never the page, even at the whole map or zoomed all the way in), drag or swipe sideways to move once
 * zoomed. A drag never opens the bubble it ends on.
 */
function useMapZoom(svg: React.RefObject<SVGSVGElement | null>, box: MapBox) {
  const [zoom, setZoomState] = useState<MapZoom | null>(null);
  // What the handlers read between renders: set on each render, and by the handlers themselves, so
  // events between renders build on each other.
  const live = useRef({ box, zoom });
  useEffect(() => {
    live.current = { box, zoom };
  });
  const setZoom = (z: MapZoom | null) => {
    live.current = { ...live.current, zoom: z };
    setZoomState(z);
  };
  const toMap = (clientX: number, clientY: number) => {
    const m = svg.current?.getScreenCTM();
    return m ? new DOMPoint(clientX, clientY).matrixTransform(m.inverse()) : null;
  };
  const zoomBy = (factor: number, at?: { x: number; y: number } | null) =>
    setZoom(zoomAround(live.current.box, live.current.zoom, factor, at));
  const panByPx = (dx: number, dy: number) => {
    const scale = svg.current?.getScreenCTM()?.a;
    if (!scale) return;
    setZoom(panZoom(live.current.box, live.current.zoom, -dx / scale, -dy / scale));
  };
  const handlers = useRef({ zoomBy, panByPx, toMap });
  useEffect(() => {
    handlers.current = { zoomBy, panByPx, toMap };
  });

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Scrolling over the map never scrolls the page (user ask 2026-10-19), even zoomed all the
      // way in or out: it does nothing there.
      e.preventDefault();
      const zoomed = live.current.zoom !== null;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // A sideways swipe on a trackpad moves a zoomed map.
        if (!zoomed) return;
        handlers.current.panByPx(-e.deltaX * unit, 0);
      } else {
        if (e.deltaY === 0 || (e.deltaY > 0 && !zoomed)) return;
        const factor = Math.exp(-Math.max(-1, Math.min(1, (e.deltaY * unit) / 400)));
        handlers.current.zoomBy(factor, handlers.current.toMap(e.clientX, e.clientY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svg]);

  // Pointers down on the map: one drags a zoomed map along, two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const moved = useRef(0);
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  };
  const gestures = {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) moved.current = 0;
      pinch.current = spread();
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const was = pointers.current.get(e.pointerId);
      if (!was) return;
      const now = { x: e.clientX, y: e.clientY };
      pointers.current.set(e.pointerId, now);
      const dx = now.x - was.x;
      const dy = now.y - was.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      if (pointers.current.size >= 2) {
        const d = spread();
        if (d && pinch.current) {
          const [a, b] = [...pointers.current.values()];
          zoomBy(d / pinch.current, toMap((a!.x + b!.x) / 2, (a!.y + b!.y) / 2));
        }
        pinch.current = d;
        return;
      }
      if (live.current.zoom === null || moved.current < 4) return;
      // Held from here, so the drag carries on off the map's edge.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
      panByPx(dx, dy);
    },
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => {
      pointers.current.delete(e.pointerId);
      pinch.current = spread();
    },
    onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => {
      pointers.current.delete(e.pointerId);
      pinch.current = spread();
    },
    // A drag or pinch that ends on a bubble doesn't open it.
    onClickCapture: (e: React.MouseEvent) => {
      if (moved.current < 4) return;
      moved.current = 0;
      e.stopPropagation();
      e.preventDefault();
    },
  };
  return { zoom, view: zoomedBox(box, zoom), setZoom, zoomBy, gestures };
}

function BubbleSvg({
  graph: laid,
  names,
  picked,
  lit,
  cexLinks,
  transfers,
  sideGroups: kolSides,
  kols,
  sides,
  onPick,
  spread,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  picked: string | null;
  lit: number | null;
  /** Draw the same-exchange ties. */
  cexLinks: boolean;
  /** Draw the holder-to-holder transfer arrows. */
  transfers: boolean;
  /** The KOLs whose possible side wallets to tie to them (empty when switched off). */
  sideGroups: readonly SideGroup[];
  /** Each KOL's bundle (kolControl): outlined, with the KOL's name and share on a pill. */
  kols: readonly KolControl[];
  /** Each holder's possible-side matches, for its title. */
  sides: PossibleSides;
  onPick: (id: string) => void;
  /** How far sideways the map may spread to fill a wide stage; stretchWide's own cap by default. */
  spread?: number;
}) {
  const uid = useId().replace(/:/g, "");
  // The map spread sideways to fill a wide stage (user ask 2026-10-16); a narrow one keeps its shape.
  const stage = useRef<HTMLDivElement>(null);
  const stageSize = useStageSize(stage);
  // Rounded, so a pixel's change doesn't lay the map out again.
  const aspect = stageSize ? Math.round((stageSize.w / stageSize.h) * 20) / 20 : null;
  const graph = useMemo(() => (aspect ? stretchWide(laid, aspect, spread) : laid), [laid, aspect, spread]);
  const { bubbleFunderLabels } = useAppearance();
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const cexSlot = useMemo(() => cexSlots(graph), [graph]);
  // Every line between two bubbles routed as one bundle per pair (user ask 2026-10-17): funding,
  // same-minute and side ties and the transfer arrows side by side, each bundle clear of other
  // bubbles where it can be; the pills keep off them all.
  const sideTies = useMemo(() => kolSideTies(graph, kols, kolSides), [graph, kols, kolSides]);
  const { lanes, same, routes } = useMemo(() => {
    const arrows = transfers && graph.transferLinks.length > 0;
    const { routes: lanes, same } = linkRoutes(graph, { transfers: arrows, sideTies });
    const routes = arrows
      ? new Map(
          graph.transferLinks.flatMap((l) => {
            const r = lanes.get(linkKey("xfer", l.from, l.to));
            return r ? [[`${l.from}>${l.to}`, r] as const] : [];
          }),
        )
      : null;
    return { lanes, same, routes };
  }, [graph, transfers, sideTies]);
  // Funders' names (when Settings shows them) and each exchange's name when its ties show, as pills
  // placed where they cover nothing (user ask 2026-10-14: they sat on bubbles, text and lines). An
  // exchange's pill is a hub, tied to each of its wallets by a line, as a funder is.
  const { labels, placed } = useMemo(() => {
    type Label = MapLabel & {
      text: string;
      kind: "funder" | "cex" | "side" | "kol";
      colour: string | null;
      /** A hub's wallets, each tied to the pill by a line. */
      members: MapNode[];
      /** A KOL's pill by its bubble: the KOL, and its side wallets tied to it by dotted lines. */
      anchor?: MapNode;
      tied?: MapNode[];
    };
    const list: Label[] = [];
    const pill = (text: string) => ({ w: text.length * 5.6 + 14, h: 16 });
    const hub = (id: string, members: MapNode[], text: string, kind: Label["kind"], colour: string) => {
      if (members.length === 0) return;
      list.push({ id, ...centreOf(members), r: 0, ...pill(text), text, kind, colour, members });
      // (placeLabels reads `members` too: it keeps the pill where its lines cross fewest bubbles.)
    };
    for (const n of graph.nodes) {
      // An unknown funder's diamond goes unlabeled (user ask 2026-10-15): its colour ties it to its
      // row. A named one's pill shows only when Settings says so (user ask 2026-10-16: off by default).
      if (!bubbleFunderLabels || n.kind !== "funder" || !n.wallet || !funderNamed(graph, n.wallet, names))
        continue;
      const text = clipName(walletText(n.wallet, names));
      const slot = nodeSlot(n, graph);
      list.push({
        id: n.id,
        x: n.x,
        y: n.y,
        r: n.r,
        ...pill(text),
        text,
        kind: "funder",
        colour: slot === null ? null : `var(--bm-${slot})`,
        members: [],
      });
    }
    // Each KOL's pill (placed ahead of the hubs, so it gets the spot by its KOL): its name and its bundle's share, by the KOL's own bubble when it holds (user
    // ask 2026-10-15); its possible side wallets tied to the KOL's bubble, else to the pill.
    const sideByKol = new Map(kolSides.map((g) => [g.kolWallet, g]));
    kols.forEach((k, i) => {
      const { kol, members } = kolBundleNodes(graph, k);
      if (members.length < 2) return;
      const g = sideByKol.get(k.kolWallet);
      const tied = g ? sideMembers(graph, g).filter((n) => n !== kol) : [];
      const text = `${clipName(names[k.kolWallet]?.name ?? k.kolName ?? walletText(k.kolWallet, names))} ${pctText(k.pct)}`;
      list.push({
        id: `kol:${k.kolWallet}`,
        ...(kol ? { x: kol.x, y: kol.y, r: kol.r } : { ...centreOf(members), r: 0 }),
        ...pill(text),
        text,
        kind: "kol",
        colour: kolColour(i),
        members: kol ? [] : tied,
        ...(kol ? { anchor: kol, tied } : {}),
      });
    });
    // A same-minute group has no pill (user ask 2026-10-16): a clock on each of its bubbles, and
    // ties between them, say they were funded together.
    if (cexLinks) {
      for (const g of cexGroupsOf(graph)) {
        // The exchange's name alone, in full ("Binance Hot Wallet 2" reads "Binance").
        const named = names[g.funder];
        const text = named ? exchangeName(named.name) : walletText(g.funder, names);
        hub(`cex:${g.funder}`, [...g.nodes], text, "cex", `var(--bm-cex-${cexSlot.get(g.funder) ?? 0})`);
      }
    }
    const lines = [...lanes].flatMap(([k, r]) => (k.startsWith("xfer:") ? [] : [r]));
    return { labels: new Map(list.map((l) => [l.id, l])), placed: placeLabels(graph, list, routes, lines) };
  }, [graph, names, cexLinks, cexSlot, kolSides, kols, routes, lanes, bubbleFunderLabels]);
  const box = graphBounds(graph, 18, placed);
  const svg = useRef<SVGSVGElement>(null);
  const { zoom, view, setZoom, zoomBy, gestures } = useMapZoom(svg, box);
  const boost = textBoost(stageSize, view);
  const pillBoost = Math.min(boost, PILL_BOOST_MAX);
  const dim = (n: MapNode) => lit !== null && n.cluster !== lit;
  // Bigger bubbles first so the small ones draw on top and stay tappable.
  const order = [...graph.nodes].sort((a, b) => b.r - a.r);
  const ids = Array.from({ length: CLUSTER_COLOURS }, (_, i) => i);

  return (
    <div className={`bm-stage compact${zoom ? " zoomed" : ""}`} ref={stage}>
      <svg
        ref={svg}
        className="bm-svg"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        {...gestures}
        role="group"
        aria-label={`Bubble map of ${graph.nodes.filter((n) => n.kind === "holder").length} top holders in ${graph.clusters.length} linked clusters`}
      >
        <defs>
          {ids.map((i) => (
            <radialGradient key={i} id={`${uid}-g${i}`} cx="35%" cy="30%" r="75%">
              <stop offset="0%" style={{ stopColor: `color-mix(in srgb, var(--bm-${i}) 55%, white)` }} />
              <stop offset="100%" style={{ stopColor: `var(--bm-${i})` }} />
            </radialGradient>
          ))}
          <radialGradient id={`${uid}-gn`} cx="35%" cy="30%" r="75%">
            <stop offset="0%" style={{ stopColor: "color-mix(in srgb, var(--bm-none) 55%, white)" }} />
            <stop offset="100%" style={{ stopColor: "var(--bm-none)" }} />
          </radialGradient>
        </defs>
        <g className="bm-halos">
          {clusterHalos(graph, lanes).map((h) => (
            // One flattened layer per cluster: overlapping parts don't darken.
            <g
              key={h.cluster}
              className={`bm-halo${lit !== null && h.cluster !== lit ? " dim" : ""}${lit === h.cluster ? " on" : ""}`}
              style={{ "--bm": `var(--bm-${h.cluster % CLUSTER_COLOURS})` } as React.CSSProperties}
            >
              {h.bands.map((b, j) => (
                <path key={j} d={bandD(b)} strokeWidth={HALO_PAD * 2.4} />
              ))}
              {h.circles.map((c, j) => (
                <circle key={j} cx={c.x} cy={c.y} r={c.r} />
              ))}
            </g>
          ))}
        </g>
        {/* Each KOL's bundle: an outline round its bubbles, joined along the shortest ties (user ask
            2026-10-15). The shape, masked by the same shape a stroke smaller, leaves the outline. */}
        <g className={`bm-kol-bundles${lit !== null ? " dim" : ""}`}>
          {kols.map((k, i) => {
            const o = bundleOutline(kolBundleNodes(graph, k).members);
            if (o.circles.length === 0) return null;
            const shape = (inset: number, colour: string) => (
              <>
                {o.bands.map((b, j) => (
                  <line
                    key={`b${j}`}
                    x1={b.x1}
                    y1={b.y1}
                    x2={b.x2}
                    y2={b.y2}
                    stroke={colour}
                    strokeWidth={BUNDLE_BAND * 2 - inset * 2}
                    strokeLinecap="round"
                  />
                ))}
                {o.circles.map((c, j) => (
                  <circle key={`c${j}`} cx={c.x} cy={c.y} r={c.r - inset} fill={colour} />
                ))}
              </>
            );
            const id = `${uid}-kol${i}`;
            return (
              <g key={k.kolWallet} style={{ "--kc": kolColour(i) } as React.CSSProperties}>
                <mask id={id} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
                  {shape(0, "white")}
                  {shape(1.4, "black")}
                </mask>
                <g className="bm-kol-fill">{shape(0, "currentColor")}</g>
                <rect
                  className="bm-kol-edge"
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  mask={`url(#${id})`}
                />
              </g>
            );
          })}
        </g>
        <g className="bm-links">
          {graph.links.map((l) => {
            const r = lanes.get(linkKey("fund", l.from, l.to));
            if (!r) return null;
            return (
              <path
                key={`${l.from}-${l.to}`}
                d={laneD(r)}
                className={`bm-link${lit !== null && l.cluster !== lit ? " dim" : ""}`}
                style={{ stroke: `var(--bm-${l.cluster % CLUSTER_COLOURS})` }}
              />
            );
          })}
          {/* Each same-minute group's ties, in the group's colour: only those its clusters don't
              already join, between the nearest holders (sameTimeTies). */}
          {same.map((l) => {
            const r = lanes.get(linkKey("same", l.from, l.to));
            if (!r) return null;
            return (
              <path
                key={`t-${l.from}-${l.to}`}
                d={laneD(r)}
                className={`bm-link bm-same-link${lit !== null ? " dim" : ""}`}
                style={{ stroke: `var(--bm-${sameTimeSlot(graph, l.group)})` }}
              />
            );
          })}
        </g>
        {/* Each hub pill's ties to its wallets: dashed in the exchange's colour, solid in a group's. */}
        <g className="bm-spokes">
          {placed.map((p) => {
            const l = labels.get(p.id)!;
            // A funder's pill that had to move off its bubble keeps a line back to it, drawn under the
            // bubbles; so does a KOL's, whose side wallets are tied to the KOL's bubble itself.
            if (l.kind === "funder" || l.anchor) {
              return (
                <g key={p.id} style={l.colour ? ({ "--lc": l.colour } as React.CSSProperties) : undefined}>
                  {p.far && <line className="bm-leader" x1={l.x} y1={l.y} x2={p.x} y2={p.y} />}
                  {l.anchor &&
                    (l.tied ?? []).map((m) => {
                      const r = lanes.get(linkKey("side", l.anchor!.id, m.id));
                      if (!r) return null;
                      return (
                        <path
                          key={m.id}
                          d={laneD(r)}
                          className={`bm-side-link${lit !== null ? " dim" : ""}`}
                          style={{ stroke: l.colour ?? undefined }}
                        />
                      );
                    })}
                </g>
              );
            }
            return l.members.map((m) => {
              // The same bend as the funding links, so the two read alike.
              const mx = (p.x + m.x) / 2 + (m.y - p.y) * 0.12;
              const my = (p.y + m.y) / 2 - (m.x - p.x) * 0.12;
              return (
                <path
                  key={`${p.id}-${m.id}`}
                  d={`M${p.x},${p.y} Q${mx},${my} ${m.x},${m.y}`}
                  className={`${l.kind === "cex" ? "bm-cex-link" : l.kind === "side" || l.kind === "kol" ? "bm-side-link" : "bm-link"}${lit !== null ? " dim" : ""}`}
                  style={{ stroke: l.colour ?? undefined }}
                />
              );
            });
          })}
        </g>
        {transfers && graph.transferLinks.length > 0 && (
          <TransferArrows
            graph={graph}
            index={index}
            routes={routes}
            names={names}
            picked={picked}
            lit={lit}
          />
        )}
        {order.map((n, i) => (
          <g
            key={n.id}
            className={`bm-node k-${n.kind}${dim(n) ? " dim" : ""}${picked === n.id ? " on" : ""}`}
            style={{ animationDelay: `${Math.min(i, 24) * 22}ms` }}
            role="button"
            tabIndex={0}
            aria-label={nodeLabel(n, graph, names, sides)}
            onClick={() => onPick(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(n.id);
              }
            }}
          >
            <title>{nodeLabel(n, graph, names, sides)}</title>
            <Bubble
              node={n}
              names={names}
              slot={nodeSlot(n, graph)}
              sameSlot={n.sameTime === null ? null : sameTimeSlot(graph, n.sameTime)}
              uid={uid}
              textScale={boost}
            />
          </g>
        ))}
        {/* Funder and exchange names, drawn last in spots placeLabels found clear of bubbles, text and lines. */}
        <g className="bm-labels">
          {placed.map((p) => {
            const l = labels.get(p.id)!;
            return (
              <g
                key={p.id}
                className={`bm-label ${l.kind}`}
                style={l.colour ? ({ "--lc": l.colour } as React.CSSProperties) : undefined}
                // Enlarged less than the bubbles' text: each pill was placed clear of what's around it.
                transform={
                  pillBoost > 1.01
                    ? `translate(${p.x} ${p.y}) scale(${pillBoost.toFixed(3)}) translate(${-p.x} ${-p.y})`
                    : undefined
                }
              >
                <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={p.h / 2} />
                <text x={p.x} y={p.y}>
                  {l.text}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="bm-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!zoom}
          onClick={() => zoomBy(1 / 1.6)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={(zoom?.k ?? 1) >= MAX_MAP_ZOOM}
          onClick={() => zoomBy(1.6)}
        >
          +
        </button>
        {zoom && (
          <button
            type="button"
            className="bm-zoom-reset"
            title="Show the whole map"
            onClick={() => setZoom(null)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/** How much moved in one transfer pair, in words fit for a tag: "<0.1%" for dust. */
export function xferPctText(v: number): string {
  return v > 0 && v < 0.1 ? "<0.1%" : pctText(v);
}

/** "3m ago", "2h ago", "4d ago": when the newest transfer of a pair was. */
function agoText(atMs: number, nowMs = Date.now()): string {
  const m = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** The small arrow between a transfer's sender and receiver in the list under the map. */
export function TransferArrow() {
  return (
    <svg className="bm-xfer-arrow" viewBox="0 0 16 10" width="16" height="10" aria-label="sent to">
      <path d="M1 5h11" />
      <path d="M9 1.5 13.5 5 9 8.5" />
    </svg>
  );
}

/**
 * Holder-to-holder transfers (user ask 2026-10-16): a glowing arrow from each sender to each
 * receiver, as thick as the supply it moved, with sparks flowing along it in the direction the
 * coin went (each pair's share is in its title and the list under the map). A pair that sent both ways draws two
 * arcs side by side. A picked bubble keeps its own arrows lit and dims the rest.
 */
function TransferArrows({
  graph,
  index,
  routes,
  names,
  picked,
  lit,
}: {
  graph: BubbleGraph;
  index: ReadonlyMap<string, MapNode>;
  routes: ReadonlyMap<string, TransferRoute> | null;
  names: WalletNames;
  picked: string | null;
  lit: number | null;
}) {
  const parts = graph.transferLinks.flatMap((l: TransferLink) => {
    const a = index.get(l.from);
    const b = index.get(l.to);
    if (!a || !b) return [];
    const w = transferWidth(l.pct);
    const head = 4 + w * 1.5;
    const half = 2.4 + w * 0.85;
    const c = routes?.get(`${l.from}>${l.to}`) ?? transferCurve(a, b, 1.2);
    // The line stops at the head's base, so the head's tip sits on the receiver's edge.
    const ux = Math.cos(c.angle);
    const uy = Math.sin(c.angle);
    const bx = c.x2 - ux * head * 0.8;
    const by = c.y2 - uy * head * 0.8;
    const d = `M${c.x1},${c.y1} Q${c.cx},${c.cy} ${bx},${by}`;
    const tipX = c.x2;
    const tipY = c.y2;
    const baseX = c.x2 - ux * head;
    const baseY = c.y2 - uy * head;
    const points = `${tipX},${tipY} ${baseX - uy * half},${baseY + ux * half} ${baseX + uy * half},${baseY - ux * half}`;
    const mine = picked !== null && (picked === l.from || picked === l.to);
    const dim = (picked !== null && !mine) || (picked === null && lit !== null);
    const title = `${walletText(a.wallet, names)} sent ${xferPctText(l.pct)} of supply to ${walletText(b.wallet, names)}${
      l.count > 1 ? ` in ${l.count} transfers` : ""
    }${l.lastAtMs !== null ? `, last ${agoText(l.lastAtMs)}` : ""}`;
    return [{ w, d, points, mine, dim, title, key: `${l.from}>${l.to}` }];
  });
  return (
    <g className={`bm-transfers${picked !== null ? " picking" : ""}`}>
      {parts.map((p) => (
        <g
          key={p.key}
          className={`bm-xfer${p.dim ? " dim" : ""}${p.mine ? " on" : ""}`}
          style={{ "--xw": p.w } as React.CSSProperties}
        >
          <title>{p.title}</title>
          <path d={p.d} className="bm-xfer-glow" style={{ strokeWidth: p.w * 3.4 }} />
          <path d={p.d} className="bm-xfer-line" style={{ strokeWidth: p.w }} />
          <path d={p.d} className="bm-xfer-flow" pathLength={100} style={{ strokeWidth: p.w * 0.9 }} />
          <polygon points={p.points} className="bm-xfer-head" />
        </g>
      ))}
    </g>
  );
}

function Bubble({
  node: n,
  names,
  slot,
  sameSlot,
  uid,
  textScale = 1,
}: {
  node: MapNode;
  names: WalletNames;
  /** Its colour slot (nodeSlot): a holder in no cluster takes its same-minute group's colour. */
  slot: number | null;
  sameSlot: number | null;
  /** The map's id prefix, for the bubble gradients. */
  uid: string;
  /** The % and name enlarged by this about the bubble's centre (textBoost), on a map drawn small. */
  textScale?: number;
}) {
  const colour = slot === null ? "var(--bm-none)" : `var(--bm-${slot})`;
  const fill = slot === null ? `url(#${uid}-gn)` : `url(#${uid}-g${slot})`;
  if (n.kind === "funder") {
    const s = n.r * 1.25;
    return (
      <>
        <rect
          x={n.x - s / 2}
          y={n.y - s / 2}
          width={s}
          height={s}
          rx={2.5}
          transform={`rotate(45 ${n.x} ${n.y})`}
          className="bm-funder"
          style={{ stroke: colour }}
        />
      </>
    );
  }
  if (n.kind === "rest") {
    return (
      <>
        <circle cx={n.x} cy={n.y} r={n.r} className="bm-rest" />
        <text x={n.x} y={n.y - 2} className="bm-rest-pct">
          {pctText(n.pct)}
        </text>
        <text x={n.x} y={n.y + 11} className="bm-rest-label">
          {n.count} other{n.count === 1 ? "" : "s"}
        </text>
      </>
    );
  }
  const flaggedRisk = n.flags.some((f) => f !== "creator");
  const dev = n.flags.includes("creator");
  // Every bubble down to 0.1% of supply carries its amount; under 1% in smaller type (user ask 2026-10-14).
  const showPct = showsPct(n.pct);
  const fontSize = n.pct < 1 ? Math.max(6, Math.min(7.5, n.r * 0.44)) : Math.max(8, Math.min(17, n.r * 0.46));
  const bx = n.x + n.r * 0.72;
  const by = n.y - n.r * 0.72;
  // A KOL's Known Side never carries its name on the bubble (user ask 2026-10-16).
  const named = bubbleName(n, names);
  const pumpfun = isPumpfunName(named);
  // A KOL's name always gets its gold backing, so it stands out (user ask 2026-10-14); so does a
  // Known Side's, one of the KOL's own wallets.
  const kol = named?.source === "kol" || named?.source === "kol-side" || named?.source === "tracked";
  const fomo = isFomoName(named);
  const fit = named ? bubbleNameLines(n.r, named.name, isUsername(named)) : null;
  // The % moves up to make room for the name under it.
  const lineH = fit ? fit.size * 1.15 : 0;
  const pctY = fit ? n.y - (fit.lines.length * lineH) / 2 - 1 : n.y;
  const nameY = pctY + fontSize * 0.62 + (fit ? fit.size * 0.62 : 0);
  // The wallet type's mark at the lower right and the same-minute clock at the lower left, each
  // moved round the rim off the % and the name (user ask 2026-10-16: never over them).
  const boxes: TextBox[] = [];
  if (showPct)
    boxes.push({ x: n.x, y: fit ? pctY : n.y, w: pctText(n.pct).length * fontSize * 0.62, h: fontSize });
  if (fit)
    boxes.push({
      x: n.x,
      y: (showPct ? nameY : n.y) - fit.size * 0.7 + (fit.lines.length * lineH + fit.size * 0.35) / 2,
      w: fit.w + 8,
      h: fit.lines.length * lineH + fit.size * 0.35,
    });
  const trait = n.trait ? { trait: n.trait, ...markerSpot(n.x, n.y, n.r, MARK_R, 1, boxes) } : null;
  if (trait) boxes.push({ x: trait.x, y: trait.y, w: MARK_R * 2, h: MARK_R * 2 });
  const clock = n.sameTime !== null ? markerSpot(n.x, n.y, n.r, MARK_R, -1, boxes) : null;
  return (
    <>
      {n.sameTime !== null && (
        <circle
          cx={n.x}
          cy={n.y}
          r={n.r + (flaggedRisk ? 9 : 4.5)}
          className="bm-same-ring"
          style={{ stroke: `var(--bm-${sameSlot})` }}
        />
      )}
      {flaggedRisk && <circle cx={n.x} cy={n.y} r={n.r + 4.5} className="bm-risk-ring" />}
      <circle cx={n.x} cy={n.y} r={n.r} fill={fill} className="bm-bubble" style={{ stroke: colour }} />
      {/* A glossy highlight, top left, as on a lit sphere. */}
      <ellipse
        cx={n.x - n.r * 0.32}
        cy={n.y - n.r * 0.42}
        rx={n.r * 0.42}
        ry={n.r * 0.26}
        transform={`rotate(-30 ${n.x - n.r * 0.32} ${n.y - n.r * 0.42})`}
        className="bm-gloss"
      />
      {n.hub && <circle cx={n.x} cy={n.y} r={n.r - 3.5} className="bm-hub-ring" />}
      <g
        transform={
          textScale > 1.01
            ? `translate(${n.x} ${n.y}) scale(${textScale.toFixed(3)}) translate(${-n.x} ${-n.y})`
            : undefined
        }
      >
        {showPct && (
          <text x={n.x} y={fit ? pctY : n.y} className="bm-pct" style={{ fontSize }}>
            {pctText(n.pct)}
          </text>
        )}
        {fit && (
          <g
            className={`bm-name${pumpfun ? " pumpfun" : ""}${fomo ? " fomo" : ""}${kol ? " kol" : ""}`}
            style={{ fontSize: fit.size }}
          >
            {/* A backing when the name runs past the bubble's edge, so it reads over whatever is behind. */}
            {(fit.wide || kol) && (
              <rect
                className="bm-name-bg"
                x={n.x - fit.w / 2 - 4}
                y={(showPct ? nameY : n.y) - fit.size * 0.7}
                width={fit.w + 8}
                height={fit.lines.length * lineH + fit.size * 0.35}
                rx={4}
              />
            )}
            <text x={n.x} y={showPct ? nameY : n.y}>
              {fit.lines.map((line, i) => (
                <tspan key={i} x={n.x} dy={i === 0 ? 0 : lineH}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        )}
      </g>
      {trait && <TraitBadge trait={trait.trait} x={trait.x} y={trait.y} />}
      {clock && (
        <g className="bm-trait bm-clock" style={{ color: `var(--bm-${sameSlot})` }}>
          <title>Funded the same minute as others on the map</title>
          <circle cx={clock.x} cy={clock.y} r={MARK_R} />
          <MarkIcon paths={CLOCK_ICON} x={clock.x} y={clock.y} />
        </g>
      )}
      {(flaggedRisk || dev) && (
        <g className={`bm-badge ${dev ? "dev" : "risk"}`}>
          <circle cx={bx} cy={by} r={dev ? 9 : 7} />
          <text x={bx} y={by}>
            {dev ? "DEV" : "!"}
          </text>
        </g>
      )}
    </>
  );
}

const pctText = (v: number) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;

/** A bubble's corner mark's radius, map units. */
const MARK_R = 6.5;

/** The name a holder's bubble carries: none for a KOL's Known Side (user ask 2026-10-16). */
function bubbleName(n: MapNode, names: WalletNames): WalletName | undefined {
  const named = n.wallet ? names[n.wallet] : undefined;
  return named?.source === "kol-side" ? undefined : named;
}

/** A corner mark's icon, centred on x, y. */
function MarkIcon({ paths, x, y }: { paths: readonly string[]; x: number; y: number }) {
  const k = (MARK_R * 1.25) / 24;
  return (
    <g transform={`translate(${x - 12 * k} ${y - 12 * k}) scale(${k})`}>
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

/** A bubble's wallet trait (user ask 2026-10-15): a small disc, bottom right, with its icon. */
function TraitBadge({ trait, x, y }: { trait: WalletTrait; x: number; y: number }) {
  return (
    <g className={`bm-trait trait-${trait}`}>
      <title>{TRAIT_WORDS[trait]}</title>
      <circle cx={x} cy={y} r={MARK_R} />
      <MarkIcon paths={TRAIT_ICON[trait]} x={x} y={y} />
    </g>
  );
}

/** A trait's icon on its own, for the legend. */
export function TraitIcon({ trait, size = 13 }: { trait: WalletTrait; size?: number }) {
  return (
    <svg
      className={`bm-trait-icon trait-${trait}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      {TRAIT_ICON[trait].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The order the stat tile lists the traits in (user ask 2026-10-15). */
const TRAIT_ORDER: readonly WalletTrait[] = ["fresh", "blockZero", "sniper", "empty"];

/** One wallet type in the Wallet types row: its icon on a tinted badge, count, name and supply. */
function WalletTypeItem({
  tone,
  icon,
  label,
  count,
  share,
  title,
}: {
  tone: WalletTrait | "risky";
  icon: React.ReactNode;
  label: string;
  /** null while unknown. */
  count: number | null;
  share: string;
  title: string;
}) {
  return (
    <li className={`bm-wt wt-${tone}${count === 0 ? " none" : ""}`} title={title}>
      <span className="bm-wt-badge">{icon}</span>
      <span className="bm-wt-text">
        <span className="bm-wt-top">
          <b className="num">{count ?? "–"}</b>
          <span className="bm-wt-label">{label}</span>
        </span>
        <span className="bm-wt-share num">{share}</span>
      </span>
    </li>
  );
}

/** The risky wallets' mark on its own, for the Wallet types row. */
function RiskyIcon() {
  return (
    <svg className="bm-trait-icon bm-risky-icon" viewBox="0 0 24 24" width={17} height={17} aria-hidden>
      {RISKY_ICON.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
const RISKY_WORDS = "Risky: flagged risky or a known dumper";

/** What each trait means, for its bubble's tooltip. */
export const TRAIT_WORDS: Record<WalletTrait, string> = {
  blockZero: "Block 0: bought in the launch's own block (a block-zero sniper)",
  sniper: "Sniper: among the launch's first 25 buyers",
  fresh: "Fresh wallet: first active within the last 24 hours",
  empty: "Empty wallet: under $25 in anything besides this coin",
};

/** When a same-minute group was funded: the date and the minute, in the reader's time zone. */
function fundingTime(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** " · from N funders", or " · one funder" when a single wallet paid for them all. */
function sameTimeFunders(g: SameTimeGroup): string {
  const funders = new Set(g.wallets.map((w) => w.funder ?? `?${w.wallet}`));
  return funders.size === 1 ? " · one funder" : ` · from ${funders.size} funders`;
}

/** A name short enough to sit under a bubble. */
/** Each KOL's colour, by its place among the map's KOLs (styles.css --bm-kol-0 to --bm-kol-2). */
function kolColour(i: number): string {
  return `var(--bm-kol-${Math.max(0, i) % 3})`;
}
/** Half the width of the bands joining a KOL's bundle outline, map units. */
const BUNDLE_BAND = 10;

function clipName(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nodeLabel(n: MapNode, graph: BubbleGraph, names: WalletNames, sides: PossibleSides = {}): string {
  if (n.kind === "rest") return `${n.count} other top holders, ${pctText(n.pct)} together`;
  const cluster = n.cluster === null ? null : graph.clusters[n.cluster];
  if (n.kind === "funder")
    return `Funder ${walletText(n.wallet, names)}, paid for ${cluster?.wallets.length ?? 0} top holders`;
  const what = [
    n.flags.includes("creator") ? "the creator" : null,
    n.flags.includes("risky") ? "risky" : null,
    n.flags.includes("dumper") ? "known dumper" : null,
    typeof n.kol === "string" ? (n.kol ? `KOL ${n.kol}` : "a KOL") : null,
    ...(n.wallet ? (sides[n.wallet] ?? []).map(possibleSideText) : []),
  ].filter(Boolean);
  const same = n.sameTime === null ? null : graph.sameTimeGroups[n.sameTime];
  const moved = transferWords(transfersOfNode(graph, n.id));
  return `Holder ${walletText(n.wallet, names)}${n.rank !== undefined ? ` (#${n.rank})` : ""}, ${pctText(n.pct)} of supply${
    cluster ? `, funded by ${walletText(cluster.funder, names)}` : ""
  }${same ? `, funded in the same minute as ${same.wallets.length - 1} other top holders` : ""}${
    moved.length ? `, ${moved.join(", ")}` : ""
  }${what.length ? `, ${what.join(", ")}` : ""}`;
}

/** " · 2 tied to the creator": how many of a cluster's holders are, for its row in the list. */
function creatorTiedText(graph: BubbleGraph, c: BubbleGraph["clusters"][number]): string {
  const ids = new Set(c.wallets.map((w) => `h:${w.wallet}`));
  const n = graph.nodes.filter((x) => x.creatorTied && ids.has(x.id)).length;
  if (n === 0) return "";
  return n === c.wallets.length ? " · all tied to the creator" : ` · ${n} tied to the creator`;
}

/** "sent 1.2% to 2 holders", "got 0.4% from 1 holder": a holder's transfers in words. */
export function transferWords(t: ReturnType<typeof transfersOfNode>): string[] {
  const holders = (n: number) => `${n} holder${n === 1 ? "" : "s"}`;
  return [
    t.sentTo > 0 ? `sent ${xferPctText(t.sent)} to ${holders(t.sentTo)}` : null,
    t.gotFrom > 0 ? `got ${xferPctText(t.got)} from ${holders(t.gotFrom)}` : null,
  ].filter((x): x is string => x !== null);
}

/** What a tapped bubble is, under the map. */
function NodeDetail({
  node: n,
  graph,
  names,
  sides,
}: {
  node: MapNode | null;
  graph: BubbleGraph;
  names: WalletNames;
  sides: PossibleSides;
}) {
  if (!n) {
    return (
      <p className="bm-detail muted small">
        {graph.clusters.length > 0
          ? "Tap a bubble to open that wallet, or a group below to list its wallets (a cluster lights up on the map)."
          : graph.linkedPct === 0
            ? "No two of these holders share a funder. Tap a bubble to open that wallet."
            : "Tap a bubble to open that wallet."}
      </p>
    );
  }
  if (n.kind === "rest") {
    return (
      <p className="bm-detail small">
        <strong>{n.count} other top holders</strong>{" "}
        <span className="muted">· {pctText(n.pct)} together, none linked</span>
      </p>
    );
  }
  const cluster = n.cluster === null ? null : graph.clusters[n.cluster];
  const tags: { text: string; tone: string }[] = [];
  if (n.flags.includes("creator")) tags.push({ text: "Dev", tone: "dev" });
  if (n.flags.includes("risky")) tags.push({ text: "Risky", tone: "risky" });
  if (n.flags.includes("dumper")) tags.push({ text: "Known dumper", tone: "risky" });
  if (typeof n.kol === "string")
    tags.push({
      // The KOL's name is already the wallet's name above: the tag just says what it is.
      text: n.kol && n.wallet && names[n.wallet]?.name !== n.kol ? `KOL: ${n.kol}` : "KOL",
      tone: "kol",
    });
  if (n.creatorTied && !n.flags.includes("creator")) tags.push({ text: "Tied to the creator", tone: "dev" });
  for (const s of n.wallet ? (sides[n.wallet] ?? []) : [])
    tags.push({ text: possibleSideText(s), tone: "side" });
  return (
    <div className="bm-detail small">
      <button
        type="button"
        className="tm-wallet-btn"
        onClick={() => n.wallet && openWallet(n.wallet)}
        title="Open this wallet's details"
      >
        {n.kind === "funder" ? "Funder " : ""}
        <WalletText wallet={n.wallet} names={names} />
      </button>
      {n.kind === "holder" && <span className="num">{pctText(n.pct)} of supply</span>}
      {n.kind === "holder" && n.rank !== undefined && (
        <span className="muted num" title="Past the top 25: on the map because we already know its funder">
          #{n.rank} holder
        </span>
      )}
      {n.kind === "funder" && cluster && (
        <span className="muted">
          paid for {cluster.wallets.length} top holders with {pctText(cluster.pct)}
        </span>
      )}
      {n.kind === "holder" && cluster && (
        <span className="muted">
          {n.hub ? "funded the others in its cluster" : `funded by ${walletText(cluster.funder, names)}`}
        </span>
      )}
      {n.kind === "holder" && n.sameTime !== null && graph.sameTimeGroups[n.sameTime] && (
        <span className="tm-tag k-same">
          Funded same minute as {graph.sameTimeGroups[n.sameTime]!.wallets.length - 1} other
          {graph.sameTimeGroups[n.sameTime]!.wallets.length === 2 ? "" : "s"}
        </span>
      )}
      {n.kind === "holder" &&
        transferWords(transfersOfNode(graph, n.id)).map((t) => (
          <span key={t} className="tm-tag k-xfer">
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </span>
        ))}
      {n.score !== null && <span className="muted num">risk {Math.round(n.score)}</span>}
      {tags.map((t) => (
        <span key={t.text} className={`tm-tag k-${t.tone}`}>
          {t.text}
        </span>
      ))}
    </div>
  );
}

/**
 * The bubble map inside the token modal, for the reading the card shows, with Share. Says so when
 * no scan has read the coin's holders.
 */
/** Faint bubbles where the map will draw, sized and placed by hand. */
const PLACEHOLDER_BUBBLES: [number, number, number][] = [
  [50, 48, 15],
  [27, 32, 9],
  [72, 30, 8],
  [76, 66, 10],
  [30, 70, 7],
  [14, 52, 4.5],
  [88, 46, 4],
  [58, 80, 5],
  [42, 18, 4],
  [62, 14, 3.5],
];

/**
 * The bubble map's place while its reading loads or is being taken (user ask 2026-10-16): the
 * card at the map's own size, with faint bubbles and what is being read.
 */
export function BubbleMapPlaceholder({ children }: { children: ReactNode }) {
  return (
    <section className="sage-card bm-section bm-loading" aria-busy="true">
      <h4>
        <BubblesIcon size={14} /> Bubble map
      </h4>
      {/* The map's own tiles and stage, so the reading fills in at the same size and place. */}
      <dl className="bm-stats" style={{ "--bm-cols": 3 } as React.CSSProperties} aria-hidden="true">
        {["Linked", "KOL Bundled", "CEX-funded"].map((l) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd>
              <SkelValue width="3.4em" />
            </dd>
          </div>
        ))}
        <div className="bm-traits-stat">
          <dt>Wallet types</dt>
          <dd>
            <ul className="bm-wt-list">
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i} className="bm-wt bm-wt-skel">
                  <span className="skeleton" />
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <div className="bm-stage compact bm-loading-stage">
        <svg className="bm-svg bm-loading-art" viewBox="0 0 100 100" aria-hidden="true">
          {PLACEHOLDER_BUBBLES.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} style={{ animationDelay: `${(i % 5) * 0.18}s` }} />
          ))}
        </svg>
        <LoadingNote
          className="bm-loading-note"
          slow="Still reading the holders: a coin with many holders takes longer."
        >
          {children}
        </LoadingNote>
      </div>
    </section>
  );
}

export function BubbleMapSection({
  token,
  snapshot: snapshotIn,
  moment,
  wide: chosenWide,
  pending = false,
  flagged,
  flags,
  column = false,
  spread,
  live = null,
  freshness,
  stamp = true,
}: {
  token: Token;
  /** The reading to draw; undefined while it loads. */
  snapshot: Snapshot | null | undefined;
  /**
   * Which moment the reading is from ("Now", "At the alert"), headed on the map; none leaves it off.
   * With `at` (the live reading's time), the heading is its age instead: "12s ago".
   */
  moment?: { label: string; title: string; at?: number };
  /**
   * The top-50 map to draw over the reading (the one kept at the call, for "At the alert"); null
   * for none. Absent: the coin's live one.
   */
  wide?: WideMap | null;
  /** A fresh scan is reading the holders now: an empty reading means "on its way", not "none". */
  pending?: boolean;
  /**
   * The flagged wallets in the coin's trades, from the chart read the modal keeps polling (so the
   * risky rings follow it), and whether that read has landed.
   */
  flagged: readonly FlaggedHolder[];
  flags: FlagsRead;
  /** Laid out to fit a fixed column (Scope's desktop page): see MapView. */
  column?: boolean;
  /** How far sideways the map may spread to fill a wide stage (Scope's tab, user ask 2026-10-19). */
  spread?: number;
  /**
   * The coin's live trades and supply: each trade since the reading's balances (and the top 50's)
   * moves a listed wallet's share on the map between reads (liveShares.ts). None for a kept moment.
   */
  live?: LiveTradeShares | null;
  /**
   * The same status as Top Holders: the age always, "Live" only while `live` and before
   * `liveUntil`, else the countdown to holderNextReadAt (mapBadgeFreshness).
   */
  freshness?: {
    last: number;
    next: number | null;
    late?: boolean;
    live?: boolean;
    liveUntil?: number | null;
  };
  /**
   * The time on the map's heading. Off where the holders bar above says it for the map and the
   * list together (user ask 2026-10-25: the time in one place only).
   */
  stamp?: boolean;
}) {
  const mint = token.mintAddress;
  const liveWide = liveWideFor(snapshotIn, useWideMap(mint));
  // The map redraws on the reader's interval (Customize, every 2 s by default, user ask
  // 2026-10-19): the reading, the top 50 and the trades since, held together until it is due.
  const { bubbleRefreshSeconds } = useAppearance();
  const inputs = useMemo(
    () => ({ reading: snapshotIn, wide: chosenWide !== undefined ? chosenWide : liveWide, live }),
    [snapshotIn, chosenWide, liveWide, live],
  );
  const redrawMs = bubbleRefreshSeconds * 1000;
  const { value: held, at: heldAt } = useEvery(inputs, redrawMs, hasReading, mint);
  const { reading: heldReading, wide: wideIn, live: heldLive } = held;
  // Trades move the listed wallets' shares from each list's own balance time: the scan's for its
  // lists and figures, the top 50's for its map. Only when the feed holds every trade since then
  // (liveShares.ts); otherwise that list is drawn as read.
  const snapshot = useMemo(
    () =>
      heldReading && heldLive
        ? withLiveShares(
            heldReading,
            listedShareDeltas(
              heldLive,
              new Set((heldReading.linkedHolders ?? []).map((h) => h.wallet)),
              holderListAt(heldReading),
            ),
          )
        : heldReading,
    [heldReading, heldLive],
  );
  const wideFrom = wideIn ? Date.parse(wideIn.balancesAt ?? wideIn.readAt) : NaN;
  const wide = useMemo(
    () =>
      wideIn && heldLive
        ? wideWithLiveShares(
            wideIn,
            listedShareDeltas(heldLive, new Set(wideIn.holders.map((h) => h.wallet)), wideFrom),
          )
        : wideIn,
    [wideIn, heldLive, wideFrom],
  );
  // The badge is when the holder set on screen was read (the top 50's enumeration, else the
  // scan's chain read). A later streamed balance or a live trade moves a share and stays in the
  // title; it does not make the badge read as just updated (user ask 2026-10-21).
  const drawn = useMemo(() => {
    if (!heldReading) return null;
    const listAt = holderListAt(heldReading);
    const at = holderBadgeAt(heldReading, wideIn?.readAt);
    let tradeAt: number | null = null;
    if (coversFrom(heldLive, listAt))
      for (const t of heldLive.trades)
        if (t.tokens > 0 && t.atMs > listAt && (tradeAt === null || t.atMs > tradeAt)) tradeAt = t.atMs;
    return { listAt, at, tradeAt };
  }, [heldReading, wideIn, heldLive]);
  // The badge describes the map on screen, which is held for the redraw interval: its read time
  // and the next update it will draw, not the newest reading behind it.
  // "Live" also needs the top 50 drawn to move with the trades: one the feed doesn't cover since
  // its balances is drawn as read, so the badge shows its age and countdown instead.
  const mapFresh =
    freshness?.live && wideIn && !coversFrom(heldLive, wideFrom)
      ? { ...freshness, live: false, liveUntil: null }
      : freshness;
  const badge = mapFresh
    ? mapBadgeFreshness(mapFresh, drawn?.at ?? mapFresh.last, { shownAt: heldAt, everyMs: redrawMs })
    : undefined;
  const { showTransfers, setTransfersOn } = useTransferToggle(snapshot);
  const { bubbleFunderLabels } = useAppearance();
  // Transfers hidden: Linked, its clusters and the bundles as they read without them (user ask
  // 2026-10-16), on the map and its share image alike.
  const shown = useMemo(
    () => (snapshot && !showTransfers ? withoutTransfers(snapshot) : snapshot),
    [snapshot, showTransfers],
  );
  // Each refresh settles from where the bubbles last stood, so the map moves gently (user ask
  // 2026-10-19); switching the transfers lays it out afresh.
  const lastDrawn = useRef<{ transfers: boolean; at: MapPositions } | null>(null);
  const graph = useMemo(() => {
    if (!shown) return null;
    const last = lastDrawn.current;
    const drawn = layoutGraph(
      buildGraph(withWideMap(shown, showTransfers ? wide : wideWithoutTransfers(wide)), flagged),
      undefined,
      { prev: last && last.transfers === showTransfers ? last.at : null },
    );
    lastDrawn.current = { transfers: showTransfers, at: positionsOf(drawn) };
    if (!showTransfers || !snapshot) return drawn;
    // The clusters funding alone forms, for each KOL's step out (user decision 2026-10-16: a send
    // into a KOL's bundle doesn't pull the sender in).
    const funding = withWideMap(withoutTransfers(snapshot), wideWithoutTransfers(wide)).linkedClusters;
    return funding ? { ...drawn, fundingClusters: funding } : drawn;
  }, [shown, snapshot, wide, showTransfers, flagged]);
  const graphNames = useGraphNames(graph);
  const nameToggle = useNameToggle(graph, graphNames);
  const names = nameToggle.mapNames;
  const { showCex, setCexOn } = useCexToggle(graph);
  const side = useSideToggle(graph);
  // Every name, hidden ones too: a KOL's always shows, and an exchange's says it is a service.
  const kols = useKols(graph, side.groups, graphNames, showTransfers);
  const label = tokenLabel(token);
  if (!graph || !graph.nodes.some((n) => n.kind === "holder")) {
    // Still on its way: the map's place is held at its size, so it fills in without a jump.
    if (snapshot === undefined || pending)
      return (
        <BubbleMapPlaceholder>
          {pending ? "Reading the top holders and how they're linked…" : "Loading the top holders…"}
        </BubbleMapPlaceholder>
      );
    // Every token view shows the map (user ask 2026-10-13); a coin no scan read holders for says so.
    return (
      <section className="sage-card bm-section bm-empty">
        <h4>
          <BubblesIcon size={14} /> Bubble map
        </h4>
        <p className="muted small">
          No holder list for this coin yet: no scan of it has read its top holders. The map and the top
          holders fill in once one does.
        </p>
      </section>
    );
  }
  return (
    <section className={`sage-card bm-section${column ? " bm-col" : ""}`}>
      <h4>
        <BubblesIcon size={14} /> Bubble map
        {stamp && (moment || freshness) && (
          <span
            className="sage-tag"
            title={
              moment
                ? (chosenWide === undefined && wide
                    ? `${moment.title} The holders past the scan's top 25 were read ${ago(wide.readAt)}.`
                    : moment.title) +
                  (drawn && moment.at !== undefined
                    ? ` Holders read at ${hms(drawn.at)}${drawn.tradeAt !== null && drawn.tradeAt > drawn.listAt ? `; shares moved by live trades since, the newest at ${hms(drawn.tradeAt)}` : ""}.`
                    : "")
                : undefined
            }
          >
            {badge ? (
              <LiveStamp
                last={badge.last}
                next={badge.next}
                late={badge.late}
                live={badge.live}
                liveUntil={badge.liveUntil}
              />
            ) : moment && moment.at !== undefined && Number.isFinite(moment.at) ? (
              <SecondsAgo at={drawn ? drawn.at : moment.at} />
            ) : (
              moment?.label
            )}
          </span>
        )}
        <span className="bm-section-actions">
          <ShareButton
            title={`${label} bubble map`}
            fileName={`trenchscanner-bubbles-${(token.symbol ?? mint.slice(0, 6)).toLowerCase()}`}
            caption={`${label} ${graph && graph.clusters.length > 0 ? "linked wallets" : "top holders"} on TrenchScanner`}
            iconOnly
            wide
            render={() => {
              // Shared outside the dashboard: none of the reader's private labels go with it.
              const pub = publicShare(graph, names, graphNames, side, showTransfers);
              return renderBubbleCard(graph, token, pub.names, {
                cex: showCex,
                transfers: showTransfers,
                sides: pub.shown,
                flags,
                kolBundled: kolBundledFor(shown, pub.kols),
                kols: pub.drawn,
                linkedKols: pub.kols,
                funderLabels: bubbleFunderLabels,
              });
            }}
          />
        </span>
      </h4>
      <MapView
        graph={graph}
        names={names}
        showCex={showCex}
        setCexOn={setCexOn}
        showTransfers={showTransfers}
        setTransfersOn={setTransfersOn}
        side={side}
        nameToggle={nameToggle}
        flags={flags}
        scanKolBundled={shown?.kolBundledPct ?? null}
        column={column}
        spread={spread}
      />
    </section>
  );
}
