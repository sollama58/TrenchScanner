import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, type Snapshot, type Token } from "../api";
import { cachedGet } from "../cache";
import { ago, pct, shortAddress, tokenLabel } from "../format";
import {
  bubbleNameLines,
  showsPct,
  cexSlots,
  CEX_COLOURS,
  cexGroupsOf,
  centreOf,
  exchangeName,
  regroupLayout,
  sideMembers,
  sideWord,
  type SideGroup,
  MAP_COLOURS,
  nodeSlot,
  sameTimeSlot,
  bubbleSeed,
  bubblesLink,
  buildGraph,
  closeBubbleMap,
  clusterHalos,
  HALO_PAD,
  openBubbleMap,
  graphBounds,
  placeLabels,
  type MapLabel,
  layoutGraph,
  linkedCountText,
  pickReading,
  type BubbleGraph,
  type SameTimeGroup,
  type FlaggedHolder,
  type FlagsRead,
  type MapNode,
  type WideMap,
  withWideMap,
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
import { BubblesIcon, CheckIcon, CloseIcon, LinkIcon, LockIcon } from "./Icons";

/** GET /tokens/:mint: the token and its newest snapshots. */
type TokenDetail = Token & { snapshots: Snapshot[] };

/** How many cluster colours there are (styles.css .bm-modal --bm-0..4); more clusters reuse them. */
export const CLUSTER_COLOURS = MAP_COLOURS;

/**
 * A model-alerted coin's map over its top 50 (withWideMap), when it has one: null for any other
 * coin, or while it loads. The map stands without it.
 */
function useWideMap(mint: string): WideMap | null {
  const [wide, setWide] = useState<WideMap | null>(null);
  useEffect(() => {
    let live = true;
    setWide(null);
    cachedGet<{ map?: WideMap | null }>(`/tokens/${encodeURIComponent(mint)}/bubble-holders`, 60_000)
      .then((r) => live && setWide(r.map ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mint]);
  return wide;
}

/** "· +12 known from top 50", for the map's subtitle; empty without the wider map. */
function wideText(wide: WideMap | null): string {
  return wide ? ` · +${wide.knownExtra} known from top ${wide.holdersRead}` : "";
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
 * The linked-wallets bubble map in a dialog, opened from a card's or the token modal's Linked tile,
 * or from a `?bubbles=<mint>` link. A guest sees what it is and how to get it; the data behind it
 * (the token's snapshots and its flagged wallets) comes with access.
 */
export function BubbleMapHost({
  mint,
  guest,
  onConnect,
}: {
  mint: string;
  guest: boolean;
  onConnect: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal bm-modal"
      aria-labelledby="bm-title"
      onClose={closeBubbleMap}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
    >
      {guest ? (
        <Locked mint={mint} onClose={close} onConnect={onConnect} />
      ) : (
        <Body mint={mint} onClose={close} />
      )}
    </dialog>
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

function Head({ title, sub, actions }: { title: string; sub?: string; actions: React.ReactNode }) {
  return (
    <header className="about-head bm-head">
      <div className="bm-head-text">
        <h2 id="bm-title" tabIndex={-1} autoFocus>
          <BubblesIcon size={18} /> {title}
        </h2>
        {sub && <p className="muted small">{sub}</p>}
      </div>
      <div className="bm-actions">{actions}</div>
    </header>
  );
}

function Locked({ mint, onClose, onConnect }: { mint: string; onClose: () => void; onConnect: () => void }) {
  return (
    <div className="about-body bm-body">
      <Head
        title="Linked wallets"
        sub={shortAddress(mint)}
        actions={
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        }
      />
      <p className="tm-locked muted">
        <LockIcon size={14} /> The bubble map comes with access: each top holder as a bubble sized by its
        share, the wallets one funder paid for drawn together, and the risky ones ringed.
      </p>
      <button type="button" onClick={onConnect}>
        Connect a wallet
      </button>
    </div>
  );
}

interface Loaded {
  token: Token;
  snapshot: Snapshot | null;
}

function Body({ mint, onClose }: { mint: string; onClose: () => void }) {
  const seed = bubbleSeed(mint);
  const [loaded, setLoaded] = useState<Loaded | null>(() =>
    seed ? { token: seed.token, snapshot: seed.snapshot } : null,
  );
  const [error, setError] = useState<Error | null>(null);
  const [flagged, setFlagged] = useState<FlaggedHolder[]>([]);
  const [flagsFor, setFlagsFor] = useState<{ mint: string; read: FlagsRead } | null>(null);
  const flags: FlagsRead = flagsFor?.mint === mint ? flagsFor.read : "loading";
  const path = `/tokens/${encodeURIComponent(mint)}`;

  useEffect(() => {
    let live = true;
    if (!seed) {
      cachedGet<TokenDetail>(path, 60_000)
        .then((d) => {
          if (!live) return;
          const { snapshots, ...token } = d;
          setLoaded({ token, snapshot: pickReading(snapshots ?? []) });
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))));
    }
    // The flagged wallets ring the risky bubbles; the map stands without them, but says so.
    cachedGet<{ wallets?: FlaggedHolder[] }>(`${path}/chart`, 60_000)
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

  const label = loaded ? tokenLabel(loaded.token) : shortAddress(mint);
  const snapshot = loaded?.snapshot ?? null;
  const wide = useWideMap(mint);
  const graph = useMemo(
    () => (snapshot ? layoutGraph(buildGraph(withWideMap(snapshot, wide), flagged)) : null),
    [snapshot, wide, flagged],
  );
  const names = useGraphNames(graph);
  const { showCex, setCexOn } = useCexToggle(graph);
  const side = useSideToggle(graph);

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    void navigator.clipboard?.writeText(bubblesLink(mint)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const hasMap = !!graph && graph.nodes.some((n) => n.kind === "holder");
  const actions = (
    <>
      <button type="button" className="ghost share-btn" onClick={copyLink} title="Copy a link to this map">
        {copied ? <CheckIcon size={14} /> : <LinkIcon size={14} />}
        {copied ? " Copied" : " Link"}
      </button>
      {graph && loaded && (
        <ShareButton
          title={`${label} bubble map`}
          fileName={`trenchscanner-bubbles-${(loaded.token.symbol ?? mint.slice(0, 6)).toLowerCase()}`}
          caption={`${label} ${graph && graph.clusters.length > 0 ? "linked wallets" : "top holders"} on TrenchScanner`}
          disabled={!hasMap}
          render={() =>
            renderBubbleCard(graph, loaded.token, names, { cex: showCex, sides: side.shown, flags })
          }
        />
      )}
      <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
        <CloseIcon size={16} />
      </button>
    </>
  );

  const sub = snapshot ? `${label} · read ${ago(wide?.readAt ?? snapshot.takenAt)}${wideText(wide)}` : label;
  if (error) {
    const locked = error instanceof ApiError && (error.status === 401 || error.status === 402);
    return (
      <div className="about-body bm-body">
        <Head title="Linked wallets" sub={label} actions={actions} />
        <p className={locked ? "tm-locked muted" : "error small"}>
          {locked ? (
            <>
              <LockIcon size={14} /> The bubble map comes with access.
            </>
          ) : error instanceof ApiError && error.status === 404 ? (
            "TrenchScanner hasn't seen this coin."
          ) : (
            `Couldn't load the map: ${error.message}`
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="about-body bm-body">
      <Head title="Linked wallets" sub={sub} actions={actions} />
      {!loaded && <div className="bm-skeleton" />}
      {loaded && !hasMap && (
        <p className="muted bm-empty">
          {snapshot?.linkedWalletPct == null
            ? "Who paid for this coin's top holders hasn't been read yet."
            : "No two top holders share a funder: nothing linked to map."}
        </p>
      )}
      {graph && hasMap && (
        <MapView
          graph={graph}
          names={names}
          showCex={showCex}
          setCexOn={setCexOn}
          side={side}
          flags={flags}
        />
      )}
    </div>
  );
}

function MapView({
  graph,
  names,
  compact = false,
  showCex,
  setCexOn,
  side,
  flags,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  compact?: boolean;
  /** Whether the same-exchange ties show (useCexToggle). */
  showCex: boolean;
  setCexOn: (on: boolean) => void;
  /** KOLs' possible side wallets and whether they show (useSideToggle). */
  side: SideToggle;
  /** Whether the flagged wallets (the risky rings) have been read. */
  flags: FlagsRead;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  // The group under the map whose wallets are listed open: "c:", "x:" or "t:" and its key.
  const [listed, setListed] = useState<string | null>(null);
  const toggleList = (key: string) => setListed((k) => (k === key ? null : key));
  const node = graph.nodes.find((n) => n.id === picked) ?? null;
  // A picked bubble's cluster lights up; so does a cluster picked from the list.
  const lit = node ? node.cluster : focus;
  const risky = graph.nodes.filter((n) => n.kind === "holder" && n.flags.some((f) => f !== "creator"));
  const largest = graph.clusters[0]?.pct ?? null;
  const { sides, groups, showSides, setSideOn } = side;
  // With the ties on, the bubbles rearrange so each exchange's holders sit together (user ask
  // 2026-10-13); off, the usual layout comes back as it was.
  // KOLs' side wallets gather round them the same way while their ties show.
  const regrouped = useMemo(
    () =>
      showCex || side.shown.length > 0 ? regroupLayout(graph, { cex: showCex, sides: side.shown }) : null,
    [graph, showCex, side.shown],
  );
  const cex = graph.cexCount;

  return (
    <>
      <dl className="bm-stats">
        <div
          className={
            graph.linkedCount !== null &&
            graph.linkedCount.linked >= countCutFor(SAFETY_REJECT_LINKED_COUNT, graph.linkedCount.of)
              ? "risky"
              : undefined
          }
        >
          <dt>Linked</dt>
          <dd
            className="num"
            title={
              graph.linkedPct === null
                ? undefined
                : `${graph.linkedCount ? `${graph.linkedCount.linked} of the top ${graph.linkedCount.of} holders, holding ` : ""}${pct(graph.linkedPct, 1)} of supply`
            }
          >
            {/* N/25 and, beside it, the share of supply those linked holders hold (user ask 2026-10-14). */}
            {graph.linkedCount && graph.linkedPct !== null
              ? `${linkedCountText(graph.linkedCount)} (${pct(graph.linkedPct, 1)})`
              : (linkedCountText(graph.linkedCount) ?? pct(graph.linkedPct, 1))}
          </dd>
        </div>
        <div>
          <dt>Clusters</dt>
          <dd className="num">{graph.clusters.length}</dd>
        </div>
        <div title="Largest cluster: the share of supply held by the biggest group of wallets one funder paid for (not one wallet; the card's Largest is the largest single holder)">
          <dt>Largest cluster</dt>
          <dd className="num">{pct(largest, 1)}</dd>
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
          className={flags === "ok" && risky.length > 0 ? "risky" : undefined}
          title={
            flags === "ok"
              ? undefined
              : flags === "failed"
                ? "Risky holders: couldn't load the flagged wallets, so no risky ones are ringed. Not a clean reading."
                : "Risky holders: loading the flagged wallets"
          }
        >
          <dt>Risky holders</dt>
          <dd className={flags === "ok" ? "num" : "muted"}>{flags === "ok" ? risky.length : "–"}</dd>
        </div>
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
        compact={compact}
        picked={picked}
        lit={lit}
        cexLinks={showCex}
        sideGroups={side.shown}
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
      <ul className="bm-clusters">
        {graph.clusters.map((c, i) => (
          <li key={c.funder} className={listed === `c:${c.funder}` ? "bm-open" : undefined}>
            <button
              type="button"
              className={`bm-cluster${lit === i ? " on" : ""}`}
              style={{ "--bm": `var(--bm-${i % CLUSTER_COLOURS})` } as React.CSSProperties}
              aria-pressed={lit === i}
              aria-expanded={listed === `c:${c.funder}`}
              onClick={() => {
                const open = listed !== `c:${c.funder}`;
                setPicked(null);
                setFocus(open ? i : null);
                setListed(open ? `c:${c.funder}` : null);
              }}
            >
              <i className="bm-dot" aria-hidden="true" />
              <span className="bm-cluster-name">
                Funder <WalletText wallet={c.funder} names={names} />
              </span>
              <span className="muted small">
                {c.wallets.length} wallets{c.creatorLinked ? " · tied to the creator" : ""}
              </span>
              <span className="num bm-cluster-pct">{pct(c.pct, 1)}</span>
            </button>
            {listed === `c:${c.funder}` && (
              <GroupWallets wallets={c.wallets} names={names} funder={c.funder} />
            )}
          </li>
        ))}
      </ul>
      {showCex && (
        <ul className="bm-clusters bm-cex-groups">
          {cexGroupsOf(graph).map((g, i) => (
            <li key={g.funder} className={listed === `x:${g.funder}` ? "bm-open" : undefined}>
              <button
                type="button"
                className={`bm-cluster bm-same${listed === `x:${g.funder}` ? " on" : ""}`}
                aria-expanded={listed === `x:${g.funder}`}
                onClick={() => toggleList(`x:${g.funder}`)}
                style={
                  {
                    "--bm": "var(--bm-none)",
                    "--bm-cex": `var(--bm-cex-${i % CEX_COLOURS})`,
                  } as React.CSSProperties
                }
              >
                <i className="bm-cex-key bm-cex-dot" aria-hidden="true" />
                <span className="bm-cluster-name">
                  Exchange <WalletText wallet={g.funder} names={names} />
                </span>
                <span className="muted small">{g.nodes.length} wallets it funded</span>
                <span className="num bm-cluster-pct">{pct(g.pct, 1)}</span>
              </button>
              {listed === `x:${g.funder}` && (
                <GroupWallets
                  wallets={g.nodes.flatMap((n) => (n.wallet ? [{ wallet: n.wallet, pct: n.pct }] : []))}
                  names={names}
                  funder={g.funder}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {showSides && (
        <ul className="bm-clusters bm-cex-groups bm-side-groups">
          {groups.map((g) => (
            <li key={g.kolWallet}>
              <div className="bm-cluster bm-same" style={{ "--bm": "var(--bm-none)" } as React.CSSProperties}>
                <i className="bm-cex-key bm-side-key bm-cex-dot" aria-hidden="true" />
                <span className="bm-cluster-name">
                  KOL <WalletText wallet={g.kolWallet} names={names} />
                  {!names[g.kolWallet] && g.kolName ? ` ${g.kolName}` : ""}
                </span>
                <span className="muted small">{sideSummary(g.wallets)}</span>
                <span className="num bm-cluster-pct">
                  {g.wallets[0]!.funded ? "Funded" : `${Math.round(g.wallets[0]!.pct)}%`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {graph.sameTimeGroups.length > 0 && (
        <ul className="bm-clusters bm-same-groups">
          {graph.sameTimeGroups.map((g, i) => (
            <li key={g.atMs} className={listed === `t:${g.atMs}` ? "bm-open" : undefined}>
              <button
                type="button"
                className={`bm-cluster bm-same${listed === `t:${g.atMs}` ? " on" : ""}`}
                style={{ "--bm": `var(--bm-${sameTimeSlot(graph, i)})` } as React.CSSProperties}
                aria-expanded={listed === `t:${g.atMs}`}
                onClick={() => toggleList(`t:${g.atMs}`)}
              >
                <i className="bm-same-dot" aria-hidden="true" />
                <span className="bm-cluster-name">
                  Funded together <span className="num">{fundingTime(g.atMs)}</span>
                </span>
                <span className="muted small">
                  {g.wallets.length} wallets within {Math.max(1, Math.round(g.spanMs / 1000))}s
                  {sameTimeFunders(g)}
                </span>
                <span className="num bm-cluster-pct">{pct(g.pct, 1)}</span>
              </button>
              {listed === `t:${g.atMs}` && <GroupWallets wallets={g.wallets} names={names} />}
            </li>
          ))}
        </ul>
      )}
      {!compact && (
        <p className="faint small bm-note">
          Each bubble is a top holder, sized by its share of supply. Wallets one funder paid for share a
          colour and a line to that funder; grey ones are linked to no other. A red ring marks a risky wallet
          or known dumper.
          {flags === "failed" && " The flagged wallets couldn't be loaded, so no wallet is ringed."}
          {graph.sameTimeGroups.length > 0 &&
            " Holders whose wallets were funded within the same minute, whoever paid, share a dotted ring and line in their group's colour."}
          {showSides &&
            " A dotted gold line ties a holder to a KOL it bought alongside on every one of the KOL's coins over the last 24 hours (10 or more), 90% over 48 hours (25 or more) or 80% over 72 hours (50 or more): a possible side wallet, not confirmed. A wallet the KOL funded is tied the same way as a KOL funded wallet, with no question mark."}
          {graph.nodes.some((n) => n.kind === "rest") &&
            " The dashed bubble is the rest of the top 10 together."}
          {graph.nodes.some((n) => n.rank !== undefined) &&
            " A model called this coin, so the map also takes in every wallet in its top 50 whose funder we already know. Linked, Same minute and CEX-funded above stay on the top holders the scan read (the /25 or /10); Clusters, Largest cluster and the lists below take in the top 50."}
        </p>
      )}
    </>
  );
}

/**
 * The wallets in a group under the map, largest first, each with its share of supply and opening
 * its own wallet modal; the funder that paid for them last (user ask 2026-10-14).
 */
function GroupWallets({
  wallets,
  names,
  funder,
}: {
  wallets: readonly { wallet: string; pct: number }[];
  names: WalletNames;
  funder?: string;
}) {
  const rows = [...wallets].sort((a, b) => b.pct - a.pct);
  return (
    <ol className="bm-group-wallets">
      {rows.map((w) => (
        <li key={w.wallet}>
          <button type="button" onClick={() => openWallet(w.wallet)} title="Open this wallet">
            <WalletText wallet={w.wallet} names={names} />
            <span className="num">{pctText(w.pct)}</span>
          </button>
        </li>
      ))}
      {funder && (
        <li className="bm-group-funder">
          <button type="button" onClick={() => openWallet(funder)} title="Open the funder">
            <span>
              <span className="muted">Funder</span> <WalletText wallet={funder} names={names} />
            </span>
            <span className="muted small">paid for them</span>
          </button>
        </li>
      )}
    </ol>
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
  if (kinds.has("pumpfun")) items.push({ cls: "pumpfun", text: '"Pump.fun"' });
  if (kinds.has("fomo")) items.push({ cls: "fomo", text: '"FOMO"' });
  if (kinds.has("identity") || kinds.has("exchange")) items.push({ cls: "", text: "Helius / exchange" });
  if (!items.length) return null;
  return (
    <ul className="bm-legend" aria-label="Name colours">
      <li className="bm-legend-title" aria-hidden>
        Legend
      </li>
      {items.map((it) => (
        <li key={it.text}>
          <span className={`bm-legend-chip ${it.cls}`}>{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

function BubbleSvg({
  graph,
  names,
  compact,
  picked,
  lit,
  cexLinks,
  sideGroups: kolSides,
  sides,
  onPick,
}: {
  graph: BubbleGraph;
  names: WalletNames;
  compact: boolean;
  picked: string | null;
  lit: number | null;
  /** Draw the same-exchange ties. */
  cexLinks: boolean;
  /** The KOLs whose possible side wallets to tie to them (empty when switched off). */
  sideGroups: readonly SideGroup[];
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
      kind: "funder" | "cex" | "same" | "side";
      colour: string | null;
      /** A hub's wallets, each tied to the pill by a line. */
      members: MapNode[];
    };
    const list: Label[] = [];
    const pill = (text: string) => ({ w: text.length * 5.6 + 14, h: 16 });
    const hub = (id: string, members: MapNode[], text: string, kind: Label["kind"], colour: string) => {
      if (members.length === 0) return;
      list.push({ id, ...centreOf(members), r: 0, ...pill(text), text, kind, colour, members });
      // (placeLabels reads `members` too: it keeps the pill where its lines cross fewest bubbles.)
    };
    for (const n of graph.nodes) {
      if (n.kind !== "funder") continue;
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
    for (const g of kolSides) {
      // The KOL's own bubble, when it holds, joins its possible side wallets on the pill.
      const members = sideMembers(graph, g);
      const kolName = names[g.kolWallet]?.name ?? g.kolName;
      hub(
        `side:${g.kolWallet}`,
        members,
        `${clipName(kolName ?? walletText(g.kolWallet, names))} ${sideWord(members, g)}`,
        "side",
        "var(--bm-side)",
      );
    }
    return { labels: new Map(list.map((l) => [l.id, l])), placed: placeLabels(graph, list) };
  }, [graph, names, cexLinks, cexSlot, kolSides]);
  const box = graphBounds(graph, 18, placed);
  const dim = (n: MapNode) => lit !== null && n.cluster !== lit;
  // Bigger bubbles first so the small ones draw on top and stay tappable.
  const order = [...graph.nodes].sort((a, b) => b.r - a.r);
  const ids = Array.from({ length: CLUSTER_COLOURS }, (_, i) => i);

  return (
    <div className={`bm-stage${compact ? " compact" : ""}`}>
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
            // A funder's pill that had to move off its bubble keeps a line back to it, drawn under the bubbles.
            if (l.kind === "funder") {
              if (!p.far) return null;
              return (
                <g key={p.id} style={l.colour ? ({ "--lc": l.colour } as React.CSSProperties) : undefined}>
                  <line className="bm-leader" x1={l.x} y1={l.y} x2={p.x} y2={p.y} />
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
                  className={`${l.kind === "cex" ? "bm-cex-link" : l.kind === "side" ? "bm-side-link" : "bm-link"}${lit !== null ? " dim" : ""}`}
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
  // A KOL's name always gets its gold backing, so it stands out (user ask 2026-10-14).
  const kol = named?.source === "kol";
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
function clipName(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "2 KOL funded wallets · 1 possible side, not confirmed": a KOL's ties in the legend. */
function sideSummary(wallets: readonly { funded?: boolean }[]): string {
  const funded = wallets.filter((w) => w.funded).length;
  const possible = wallets.length - funded;
  return [
    funded > 0 ? `${funded} KOL funded wallet${funded === 1 ? "" : "s"}` : null,
    possible > 0 ? `${possible} possible side wallet${possible === 1 ? "" : "s"} · not confirmed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
          ? "Tap a bubble to open that wallet, or a cluster below to light it up and list its wallets."
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
 * The bubble map inside the token modal: the same map, a little shorter, for the reading the
 * card shows, with Share and a button that opens it full size (with its link) in its own dialog.
 * Nothing when the coin has no linked cluster.
 */
export function BubbleMapSection({
  token,
  snapshot,
  moment,
}: {
  token: Token;
  /** The reading to draw; undefined while it loads. */
  snapshot: Snapshot | null | undefined;
  /** Which moment the reading is from ("Now", "At the alert"), headed on the map; none leaves it off. */
  moment?: { label: string; title: string };
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
  const wide = useWideMap(mint);
  const graph = useMemo(
    () => (snapshot ? layoutGraph(buildGraph(withWideMap(snapshot, wide), flagged)) : null),
    [snapshot, wide, flagged],
  );
  const names = useGraphNames(graph);
  const { showCex, setCexOn } = useCexToggle(graph);
  const side = useSideToggle(graph);
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
            render={() => renderBubbleCard(graph, token, names, { cex: showCex, sides: side.shown, flags })}
          />
          <button
            type="button"
            className="tm-link"
            onClick={() => (snapshot ? openBubbleMap(mint, { token, snapshot }) : openBubbleMap(mint))}
            title="Open the bubble map full size, with a link to share"
          >
            Expand
          </button>
        </span>
      </h4>
      <MapView
        graph={graph}
        names={names}
        compact
        showCex={showCex}
        setCexOn={setCexOn}
        side={side}
        flags={flags}
      />
    </section>
  );
}
