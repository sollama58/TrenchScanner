import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Snapshot, Token } from "../api";
import { cachedGet } from "../cache";
import { pct, tokenLabel } from "../format";
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
  needsRegroup,
  bundleOutline,
  kolBundleNodes,
  sideMembers,
  type SideGroup,
  MAP_COLOURS,
  nodeSlot,
  sameTimeSlot,
  buildGraph,
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
  TRAIT_ICON,
  RISKY_ICON,
  riskyShare,
  TRAIT_LABEL,
  traitShares,
  type WalletTrait,
} from "../bubbleMap";
import { renderBubbleCard } from "../bubbleMapCard";
import { openWallet } from "../walletModal";
import {
  isFomoName,
  isPumpfunName,
  isUsername,
  useWalletNames,
  walletText,
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
import { possibleSideText, sideGroups, usePossibleSides, type PossibleSides } from "../possibleSides";
import { ShareButton } from "./ShareImageDialog";
import { BubblesIcon } from "./Icons";

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
  const [maps, setMaps] = useState<{ mint: string; maps: BubbleMaps } | null>(null);
  useEffect(() => {
    let live = true;
    cachedGet<BubbleMaps>(`/tokens/${encodeURIComponent(mint)}/bubble-holders`, 60_000)
      .then((r) => live && setMaps({ mint, maps: r }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mint]);
  return maps?.mint === mint ? maps.maps : null;
}

/** The names of every wallet on the map (holders and funders), in one read. */
function useGraphNames(graph: BubbleGraph | null): WalletNames {
  return useWalletNames(
    useMemo(
      () =>
        graph
          ? [
              ...graph.nodes.map((n) => n.wallet),
              ...graph.clusters.map((c) => c.funder),
              ...graph.cexLinks.map((l) => l.funder),
            ]
          : [],
      [graph],
    ),
  );
}

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
function useKols(graph: BubbleGraph | null, groups: readonly SideGroup[], names: WalletNames): KolControl[] {
  return useMemo(
    () =>
      graph
        ? kolControl(
            graph,
            groups,
            graph.nodes.flatMap((n) =>
              n.kind === "holder" && n.wallet && names[n.wallet]?.source === "kol"
                ? [{ wallet: n.wallet, name: names[n.wallet]!.name }]
                : [],
            ),
          )
        : [],
    [graph, groups, names],
  );
}

/**
 * KOL Bundled % for the share image: the scan's figure (what the filters and models read), else
 * the map's own groups, else unknown.
 */
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
  side,
  flags,
  scanKolBundled,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  /** Whether the same-exchange ties show (useCexToggle). */
  showCex: boolean;
  setCexOn: (on: boolean) => void;
  /** KOLs' possible side wallets and whether they show (useSideToggle). */
  side: SideToggle;
  /** Whether the flagged wallets (the risky rings) have been read. */
  flags: FlagsRead;
  /** The scan's KOL Bundled % (TokenSnapshot.kolBundledPct); null while unknown. */
  scanKolBundled: number | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  // The group under the map whose wallets are listed open: "c:", "x:" or "t:" and its key.
  const [listed, setListed] = useState<string | null>(null);
  const node = graph.nodes.find((n) => n.id === picked) ?? null;
  // A picked bubble's cluster lights up; so does a cluster picked from the list.
  const lit = node ? node.cluster : focus;
  const risky = riskyShare(graph);
  const traits = new Map(traitShares(graph).map((t) => [t.trait, t]));
  const { sides, groups, showSides, setSideOn } = side;
  // Each KOL and the supply it may control: side wallets, KOL funded wallets and their linked holders.
  const kols = useKols(graph, groups, names);
  // KOL Bundled % in place of the old cluster count (user ask 2026-10-15): the scan's figure, else
  // the map's own KOL groups, as the share image reads it.
  const kolBundled = scanKolBundled ?? (kols.length > 0 ? kolBundledShare(kols) : null);
  // With the ties on, the bubbles rearrange so each exchange's holders sit together (user ask
  // 2026-10-13); off, the usual layout comes back as it was.
  // KOLs' side wallets gather round them the same way while their ties show.
  // Each KOL's bundle sits together too, its pill by the KOL (user ask 2026-10-15).
  const regrouped = useMemo(() => {
    const opts = { cex: showCex, sides: side.shown, kols };
    return needsRegroup(opts) ? regroupLayout(graph, opts) : null;
  }, [graph, showCex, side.shown, kols]);
  const cex = graph.cexCount;
  // Linked takes in KOLs' bundles and the wider map's links, out of every holder read (mapLinked).
  const linked = mapLinked(graph, kols);

  return (
    <>
      <dl
        className="bm-stats"
        style={{ "--bm-cols": graph.sameTimeGroups.length > 0 ? 4 : 3 } as React.CSSProperties}
      >
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
              : "KOL bundled: supply held by KOLs and the top holders tied to them (wallets a KOL funded, possible side wallets, and holders sharing a funder or funding minute with those)"
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
        {/* Fresh, sniper, empty and risky wallets on the map, each its count and supply: a row of its
            own under the headline tiles (user asks 2026-10-15, 2026-10-16). */}
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
      </dl>
      {(graph.cexLinks.length > 0 || groups.length > 0) && (
        <div className="bm-toggles">
          {graph.cexLinks.length > 0 && (
            <MapToggle on={showCex} onToggle={() => setCexOn(!showCex)} keyClass="bm-cex-key">
              Same-exchange ties
            </MapToggle>
          )}
          {groups.length > 0 && (
            <MapToggle
              on={showSides}
              onToggle={() => setSideOn(!showSides)}
              keyClass="bm-cex-key bm-side-key"
            >
              KOL side wallets
            </MapToggle>
          )}
        </div>
      )}
      <BubbleSvg
        graph={regrouped ?? graph}
        names={names}
        picked={picked}
        lit={lit}
        cexLinks={showCex}
        sideGroups={side.shown}
        kols={kols}
        sides={sides}
        onPick={(id) => {
          setPicked(id);
          setFocus(null);
          // A wallet's bubble (a holder, or the funder behind a cluster) opens that wallet's modal;
          // the "others" bubble has no one wallet, so it only lights up.
          const wallet = graph.nodes.find((n) => n.id === id)?.wallet;
          if (wallet) openWallet(wallet);
        }}
      />
      <NameLegend graph={graph} names={names} />
      <NodeDetail node={node} graph={graph} names={names} sides={sides} />
      <GroupPanel
        graph={graph}
        names={names}
        kols={kols}
        listed={listed}
        lit={lit}
        onSelect={(key, cluster) => {
          const open = listed !== key;
          setPicked(null);
          setFocus(open && cluster !== undefined ? cluster : null);
          setListed(open ? key : null);
        }}
      />
    </>
  );
}

/** How each tie to a KOL reads in its wallet list. */
const KOL_TIE_TEXT: Record<KolTie, string> = {
  kol: "KOL",
  known: "Known side",
  funded: "KOL funded",
  side: "Possible side",
  cluster: "Same funder",
  "same-minute": "Same minute",
};

/** "4 wallets · 1 KOL funded · 2 possible sides": what a KOL's row holds. */
function kolSummary(k: KolControl): string {
  const count = (t: KolTie) => k.wallets.filter((w) => w.tie === t).length;
  const known = count("known");
  const funded = count("funded");
  const side = count("side");
  const linked = count("cluster") + count("same-minute");
  return [
    `${k.wallets.length} wallet${k.wallets.length === 1 ? "" : "s"}`,
    known > 0 ? `${known} known side${known === 1 ? "" : "s"}` : null,
    funded > 0 ? `${funded} KOL funded` : null,
    side > 0 ? `${side} possible side${side === 1 ? "" : "s"}` : null,
    linked > 0 ? `${linked} linked` : null,
    k.holds ? null : "KOL not holding",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The exchanges' section under the map: kept out of largestSourceOnly. */
const EXCHANGES = "Exchanges";

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
  listed,
  lit,
  onSelect,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  kols: readonly KolControl[];
  listed: string | null;
  lit: number | null;
  onSelect: (key: string, cluster?: number) => void;
}) {
  const detail = useRef<HTMLDivElement>(null);
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
        sub: `${c.wallets.length} wallets${c.creatorLinked ? " · tied to the creator" : ""}`,
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
            KOL <WalletText wallet={k.kolWallet} names={names} />
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
  ];
  // A group that falls under two kinds (a funding minute inside a funder's cluster, a cluster a KOL's
  // bundle takes in) lists once, under the largest (user ask 2026-10-15). An exchange's holders
  // aren't a confirmed cluster, so they neither hide another group nor are hidden.
  const kept = new Set(
    largestSourceOnly(
      all
        .filter((sec) => sec.title !== EXCHANGES)
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
      groups: sec.title === EXCHANGES ? sec.groups : sec.groups.filter((g) => kept.has(g)),
    }))
    .filter((sec) => sec.groups.length > 0);
  if (sections.length === 0) return null;
  const picked = sections.flatMap((sec) => sec.groups).find((g) => g.key === listed) ?? null;
  const pick = (g: PanelGroup) => {
    onSelect(g.key, g.cluster);
    // Stacked on a phone, the wallets sit under the list: bring them into view.
    if (listed !== g.key && window.matchMedia("(max-width: 640px)").matches)
      window.setTimeout(() => detail.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };
  return (
    <div className="bm-groups">
      <div className="bm-group-list">
        {sections.map((sec) => (
          <section key={sec.title} className="bm-group-section">
            <h4>{sec.title}</h4>
            <ul>
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
          </section>
        ))}
      </div>
      <div className="bm-group-detail" ref={detail} aria-live="polite">
        {picked ? (
          <GroupWallets group={picked} names={names} />
        ) : (
          <p className="muted small bm-group-hint">
            Pick a cluster or KOL to list its wallets and their share of supply. Each wallet opens its own
            view.
          </p>
        )}
      </div>
    </div>
  );
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
  if (kinds.has("kol-side")) items.push({ cls: "kol", text: "KOL Known Side" });
  if (kinds.has("pumpfun")) items.push({ cls: "pumpfun", text: '"Pump.fun"' });
  if (kinds.has("fomo")) items.push({ cls: "fomo", text: '"FOMO"' });
  if (kinds.has("identity") || kinds.has("exchange")) items.push({ cls: "", text: "Helius / exchange" });
  // Each wallet trait on the map, its icon and the share of supply its holders hold (user ask 2026-10-15).
  const traits = traitShares(graph);
  if (!items.length && !traits.length) return null;
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
    </ul>
  );
}

function BubbleSvg({
  graph,
  names,
  picked,
  lit,
  cexLinks,
  sideGroups: kolSides,
  kols,
  sides,
  onPick,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  picked: string | null;
  lit: number | null;
  /** Draw the same-exchange ties. */
  cexLinks: boolean;
  /** The KOLs whose possible side wallets to tie to them (empty when switched off). */
  sideGroups: readonly SideGroup[];
  /** Each KOL's bundle (kolControl): outlined, with the KOL's name and share on a pill. */
  kols: readonly KolControl[];
  /** Each holder's possible-side matches, for its title. */
  sides: PossibleSides;
  onPick: (id: string) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const cexSlot = useMemo(() => cexSlots(graph), [graph]);
  // Funders' names, each exchange's name when its ties show, and each same-minute group's, as pills
  // placed where they cover nothing (user ask 2026-10-14: they sat on bubbles, text and lines). An
  // exchange's and a group's pill is a hub, tied to each of its wallets by a line, as a funder is.
  const { labels, placed } = useMemo(() => {
    type Label = MapLabel & {
      text: string;
      kind: "funder" | "cex" | "same" | "side" | "kol";
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
      // An unknown funder's diamond goes unlabeled (user ask 2026-10-15): its colour ties it to its row.
      if (n.kind !== "funder" || !n.wallet || !funderNamed(graph, n.wallet, names)) continue;
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
    graph.sameTimeGroups.forEach((g, i) => {
      const members = graph.nodes.filter((n) => n.kind === "holder" && n.sameTime === i);
      hub(
        `same:${i}`,
        members,
        `Funded together ${clockTime(g.atMs)}`,
        "same",
        `var(--bm-${sameTimeSlot(graph, i)})`,
      );
    });
    if (cexLinks) {
      for (const g of cexGroupsOf(graph)) {
        // The exchange's name alone, in full ("Binance Hot Wallet 2" reads "Binance").
        const named = names[g.funder];
        const text = named ? exchangeName(named.name) : walletText(g.funder, names);
        hub(`cex:${g.funder}`, [...g.nodes], text, "cex", `var(--bm-cex-${cexSlot.get(g.funder) ?? 0})`);
      }
    }
    return { labels: new Map(list.map((l) => [l.id, l])), placed: placeLabels(graph, list) };
  }, [graph, names, cexLinks, cexSlot, kolSides, kols]);
  const box = graphBounds(graph, 18, placed);
  const dim = (n: MapNode) => lit !== null && n.cluster !== lit;
  // Bigger bubbles first so the small ones draw on top and stay tappable.
  const order = [...graph.nodes].sort((a, b) => b.r - a.r);
  const ids = Array.from({ length: CLUSTER_COLOURS }, (_, i) => i);

  return (
    <div className="bm-stage compact">
      <svg
        className="bm-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
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
          {clusterHalos(graph).map((h) => (
            // One flattened layer per cluster: overlapping parts don't darken.
            <g
              key={h.cluster}
              className={`bm-halo${lit !== null && h.cluster !== lit ? " dim" : ""}${lit === h.cluster ? " on" : ""}`}
              style={{ "--bm": `var(--bm-${h.cluster % CLUSTER_COLOURS})` } as React.CSSProperties}
            >
              {h.bands.map((b, j) => (
                <line key={j} x1={b.x1} y1={b.y1} x2={b.x2} y2={b.y2} strokeWidth={HALO_PAD * 2.4} />
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
            const a = index.get(l.from);
            const b = index.get(l.to);
            if (!a || !b) return null;
            // A slight bend, always to the same side, so crossing lines stay apart.
            const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
            const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
            return (
              <path
                key={`${l.from}-${l.to}`}
                d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                className={`bm-link${lit !== null && l.cluster !== lit ? " dim" : ""}`}
                style={{ stroke: `var(--bm-${l.cluster % CLUSTER_COLOURS})` }}
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
                      const a = l.anchor!;
                      const mx = (a.x + m.x) / 2 + (m.y - a.y) * 0.12;
                      const my = (a.y + m.y) / 2 - (m.x - a.x) * 0.12;
                      return (
                        <path
                          key={m.id}
                          d={`M${a.x},${a.y} Q${mx},${my} ${m.x},${m.y}`}
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
    </div>
  );
}

function Bubble({
  node: n,
  names,
  slot,
  sameSlot,
  uid,
}: {
  node: MapNode;
  names: WalletNames;
  /** Its colour slot (nodeSlot): a holder in no cluster takes its same-minute group's colour. */
  slot: number | null;
  sameSlot: number | null;
  /** The map's id prefix, for the bubble gradients. */
  uid: string;
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
  const named = n.wallet ? names[n.wallet] : undefined;
  const pumpfun = isPumpfunName(named);
  // A KOL's name always gets its gold backing, so it stands out (user ask 2026-10-14); so does a
  // Known Side's, one of the KOL's own wallets.
  const kol = named?.source === "kol" || named?.source === "kol-side";
  const fomo = isFomoName(named);
  const fit = named ? bubbleNameLines(n.r, named.name, isUsername(named)) : null;
  // The % moves up to make room for the name under it.
  const lineH = fit ? fit.size * 1.15 : 0;
  const pctY = fit ? n.y - (fit.lines.length * lineH) / 2 - 1 : n.y;
  const nameY = pctY + fontSize * 0.62 + (fit ? fit.size * 0.62 : 0);
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
      {n.trait && <TraitBadge trait={n.trait} x={n.x + n.r * 0.72} y={n.y + n.r * 0.72} />}
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

/** A bubble's wallet trait (user ask 2026-10-15): a small disc, bottom right, with its icon. */
function TraitBadge({ trait, x, y }: { trait: WalletTrait; x: number; y: number }) {
  const r = 6.5;
  const k = (r * 1.25) / 24;
  return (
    <g className={`bm-trait trait-${trait}`}>
      <title>{TRAIT_WORDS[trait]}</title>
      <circle cx={x} cy={y} r={r} />
      <g transform={`translate(${x - 12 * k} ${y - 12 * k}) scale(${k})`}>
        {TRAIT_ICON[trait].map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </g>
  );
}

/** A trait's icon on its own, for the legend. */
function TraitIcon({ trait, size = 13 }: { trait: WalletTrait; size?: number }) {
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
const TRAIT_ORDER: readonly WalletTrait[] = ["fresh", "sniper", "empty"];

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
const TRAIT_WORDS: Record<WalletTrait, string> = {
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

/** A funding minute's clock time, for a same-minute group's pill. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  return `Holder ${walletText(n.wallet, names)}${n.rank !== undefined ? ` (#${n.rank})` : ""}, ${pctText(n.pct)} of supply${
    cluster ? `, funded by ${walletText(cluster.funder, names)}` : ""
  }${same ? `, funded in the same minute as ${same.wallets.length - 1} other top holders` : ""}${
    what.length ? `, ${what.join(", ")}` : ""
  }`;
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
  if (cluster?.creatorLinked) tags.push({ text: "Tied to the creator", tone: "dev" });
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
export function BubbleMapSection({
  token,
  snapshot,
  moment,
  wide: chosenWide,
}: {
  token: Token;
  /** The reading to draw; undefined while it loads. */
  snapshot: Snapshot | null | undefined;
  /** Which moment the reading is from ("Now", "At the alert"), headed on the map; none leaves it off. */
  moment?: { label: string; title: string };
  /**
   * The top-50 map to draw over the reading (the one kept at the call, for "At the alert"); null
   * for none. Absent: the coin's live one.
   */
  wide?: WideMap | null;
}) {
  const [flagged, setFlagged] = useState<FlaggedHolder[]>([]);
  const [flagsFor, setFlagsFor] = useState<{ mint: string; read: FlagsRead } | null>(null);
  const mint = token.mintAddress;
  const flags: FlagsRead = flagsFor?.mint === mint ? flagsFor.read : "loading";
  useEffect(() => {
    let live = true;
    // The chart card asks for the same path; the cache hands both the one answer.
    cachedGet<{ wallets?: FlaggedHolder[] }>(`/tokens/${encodeURIComponent(mint)}/chart`, 60_000)
      .then((c) => {
        if (!live) return;
        setFlagged(c.wallets ?? []);
        setFlagsFor({ mint, read: "ok" });
      })
      .catch(() => live && setFlagsFor({ mint, read: "failed" }));
    return () => {
      live = false;
    };
  }, [mint]);
  const liveWide = useWideMap(mint);
  const wide = chosenWide !== undefined ? chosenWide : liveWide;
  const graph = useMemo(
    () => (snapshot ? layoutGraph(buildGraph(withWideMap(snapshot, wide), flagged)) : null),
    [snapshot, wide, flagged],
  );
  const names = useGraphNames(graph);
  const { showCex, setCexOn } = useCexToggle(graph);
  const side = useSideToggle(graph);
  const kols = useKols(graph, side.groups, names);
  const label = tokenLabel(token);
  if (!graph || !graph.nodes.some((n) => n.kind === "holder")) {
    // Every token view shows the map (user ask 2026-10-13); a coin no scan read holders for says so.
    return (
      <section className="sage-card bm-section bm-empty">
        <h4>
          <BubblesIcon size={14} /> Bubble map
        </h4>
        <p className="muted small">
          {snapshot === undefined
            ? "Loading the top holders…"
            : "No holder list for this coin yet: no scan of it has read its top holders. The map and the top holders fill in once one does."}
        </p>
      </section>
    );
  }
  return (
    <section className="sage-card bm-section">
      <h4>
        <BubblesIcon size={14} /> Bubble map
        {moment && (
          <span className="sage-tag" title={moment.title}>
            {moment.label}
          </span>
        )}
        <span className="bm-section-actions">
          <ShareButton
            title={`${label} bubble map`}
            fileName={`trenchscanner-bubbles-${(token.symbol ?? mint.slice(0, 6)).toLowerCase()}`}
            caption={`${label} ${graph && graph.clusters.length > 0 ? "linked wallets" : "top holders"} on TrenchScanner`}
            iconOnly
            render={() =>
              renderBubbleCard(graph, token, names, {
                cex: showCex,
                sides: side.shown,
                flags,
                kolBundled: kolBundledFor(snapshot, kols),
                kols,
              })
            }
          />
        </span>
      </h4>
      <MapView
        graph={graph}
        names={names}
        showCex={showCex}
        setCexOn={setCexOn}
        side={side}
        flags={flags}
        scanKolBundled={snapshot?.kolBundledPct ?? null}
      />
    </section>
  );
}
