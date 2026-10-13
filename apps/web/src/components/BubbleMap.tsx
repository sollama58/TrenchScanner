import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, type Snapshot, type Token } from "../api";
import { cachedGet } from "../cache";
import { ago, pct, shortAddress, tokenLabel } from "../format";
import {
  bubbleSeed,
  bubblesLink,
  buildGraph,
  closeBubbleMap,
  clusterHalos,
  HALO_PAD,
  openBubbleMap,
  graphBounds,
  layoutGraph,
  pickReading,
  type BubbleGraph,
  type SameTimeGroup,
  type FlaggedHolder,
  type MapNode,
} from "../bubbleMap";
import { renderBubbleCard } from "../bubbleMapCard";
import { openWallet } from "../walletModal";
import { LINKED_WARN_PCT } from "./AlertCard";
import { ShareButton } from "./ShareImageDialog";
import { BubblesIcon, CheckIcon, CloseIcon, LinkIcon, LockIcon } from "./Icons";

/** GET /tokens/:mint: the token and its newest snapshots. */
type TokenDetail = Token & { snapshots: Snapshot[] };

/** How many cluster colours there are (styles.css .bm-modal --bm-0..4); more clusters reuse them. */
export const CLUSTER_COLOURS = 5;

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
    // The flagged wallets ring the risky bubbles; the map stands without them.
    cachedGet<{ wallets?: FlaggedHolder[] }>(`${path}/chart`, 60_000)
      .then((c) => live && setFlagged(c.wallets ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mint]);

  const label = loaded ? tokenLabel(loaded.token) : shortAddress(mint);
  const snapshot = loaded?.snapshot ?? null;
  const graph = useMemo(
    () => (snapshot ? layoutGraph(buildGraph(snapshot, flagged)) : null),
    [snapshot, flagged],
  );

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
          caption={`${label} linked wallets on TrenchScanner`}
          disabled={!hasMap}
          render={() => renderBubbleCard(graph, loaded.token)}
        />
      )}
      <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
        <CloseIcon size={16} />
      </button>
    </>
  );

  const sub = snapshot ? `${label} · read ${ago(snapshot.takenAt)}` : label;
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
      {graph && hasMap && <MapView graph={graph} />}
    </div>
  );
}

function MapView({ graph, compact = false }: { graph: BubbleGraph; compact?: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const node = graph.nodes.find((n) => n.id === picked) ?? null;
  // A picked bubble's cluster lights up; so does a cluster picked from the list.
  const lit = node ? node.cluster : focus;
  const risky = graph.nodes.filter((n) => n.kind === "holder" && n.flags.some((f) => f !== "creator"));
  const largest = graph.clusters[0]?.pct ?? null;

  return (
    <>
      <dl className="bm-stats">
        <div className={graph.linkedPct !== null && graph.linkedPct >= LINKED_WARN_PCT ? "risky" : undefined}>
          <dt>Linked</dt>
          <dd className="num">{pct(graph.linkedPct, 1)}</dd>
        </div>
        <div>
          <dt>Clusters</dt>
          <dd className="num">{graph.clusters.length}</dd>
        </div>
        <div>
          <dt>Largest</dt>
          <dd className="num">{pct(largest, 1)}</dd>
        </div>
        {graph.sameTimeGroups.length > 0 && (
          <div
            className="bm-same-stat"
            title="Top holders funded within a minute of each other, from any funders"
          >
            <dt>Same minute</dt>
            <dd className="num">{pct(graph.sameTimePct, 1)}</dd>
          </div>
        )}
        <div className={risky.length > 0 ? "risky" : undefined}>
          <dt>Risky holders</dt>
          <dd className="num">{risky.length}</dd>
        </div>
      </dl>
      <BubbleSvg
        graph={graph}
        compact={compact}
        picked={picked}
        lit={lit}
        onPick={(id) => {
          setPicked(id);
          setFocus(null);
          // A wallet's bubble (a holder, or the funder behind a cluster) opens that wallet's modal;
          // the "others" bubble has no one wallet, so it only lights up.
          const wallet = graph.nodes.find((n) => n.id === id)?.wallet;
          if (wallet) openWallet(wallet);
        }}
      />
      <NodeDetail node={node} graph={graph} />
      <ul className="bm-clusters">
        {graph.clusters.map((c, i) => (
          <li key={c.funder}>
            <button
              type="button"
              className={`bm-cluster${lit === i ? " on" : ""}`}
              style={{ "--bm": `var(--bm-${i % CLUSTER_COLOURS})` } as React.CSSProperties}
              aria-pressed={lit === i}
              onClick={() => {
                setPicked(null);
                setFocus((f) => (f === i ? null : i));
              }}
            >
              <i className="bm-dot" aria-hidden="true" />
              <span className="bm-cluster-name">
                Funder <span className="num">{shortAddress(c.funder)}</span>
              </span>
              <span className="muted small">
                {c.wallets.length} wallets{c.creatorLinked ? " · tied to the creator" : ""}
              </span>
              <span className="num bm-cluster-pct">{pct(c.pct, 1)}</span>
            </button>
          </li>
        ))}
      </ul>
      {graph.sameTimeGroups.length > 0 && (
        <ul className="bm-clusters bm-same-groups">
          {graph.sameTimeGroups.map((g) => (
            <li key={g.atMs}>
              <div className="bm-cluster bm-same">
                <i className="bm-same-dot" aria-hidden="true" />
                <span className="bm-cluster-name">
                  Funded together <span className="num">{fundingTime(g.atMs)}</span>
                </span>
                <span className="muted small">
                  {g.wallets.length} wallets within {Math.max(1, Math.round(g.spanMs / 1000))}s
                  {sameTimeFunders(g)}
                </span>
                <span className="num bm-cluster-pct">{pct(g.pct, 1)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!compact && (
        <p className="faint small bm-note">
          Each bubble is a top holder, sized by its share of supply. Wallets one funder paid for share a
          colour and a line to that funder; grey ones are linked to no other. A red ring marks a risky wallet
          or known dumper.
          {graph.sameTimeGroups.length > 0 &&
            " A dotted ring and line join holders whose wallets were funded within the same minute, whoever paid."}
          {graph.nodes.some((n) => n.kind === "rest") &&
            " The dashed bubble is the rest of the top 10 together."}
        </p>
      )}
    </>
  );
}

function BubbleSvg({
  graph,
  compact,
  picked,
  lit,
  onPick,
}: {
  graph: BubbleGraph;
  compact: boolean;
  picked: string | null;
  lit: number | null;
  onPick: (id: string) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const box = graphBounds(graph);
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const dim = (n: MapNode) => lit !== null && n.cluster !== lit;
  // Bigger bubbles first so the small ones draw on top and stay tappable.
  const order = [...graph.nodes].sort((a, b) => b.r - a.r);
  const ids = Array.from({ length: CLUSTER_COLOURS }, (_, i) => i);

  return (
    <div className={`bm-stage${compact ? " compact" : ""}`}>
      <svg
        className="bm-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        role="img"
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
        <g className="bm-same-links">
          {graph.sameTimeLinks.map((l) => {
            const a = index.get(l.from);
            const b = index.get(l.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${l.from}-${l.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`bm-same-link${lit !== null ? " dim" : ""}`}
              />
            );
          })}
        </g>
        {order.map((n, i) => (
          <g
            key={n.id}
            className={`bm-node k-${n.kind}${dim(n) ? " dim" : ""}${picked === n.id ? " on" : ""}`}
            style={{ animationDelay: `${Math.min(i, 24) * 22}ms` }}
            role="button"
            tabIndex={0}
            aria-label={nodeLabel(n, graph)}
            onClick={() => onPick(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(n.id);
              }
            }}
          >
            <title>{nodeLabel(n, graph)}</title>
            <Bubble
              node={n}
              fill={n.cluster === null ? `url(#${uid}-gn)` : `url(#${uid}-g${n.cluster % CLUSTER_COLOURS})`}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

function Bubble({ node: n, fill }: { node: MapNode; fill: string }) {
  const colour = n.cluster === null ? "var(--bm-none)" : `var(--bm-${n.cluster % CLUSTER_COLOURS})`;
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
        <text x={n.x} y={n.y + n.r + 12} className="bm-funder-label">
          {shortAddress(n.wallet ?? "")}
        </text>
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
  const fontSize = Math.max(8, Math.min(17, n.r * 0.46));
  const bx = n.x + n.r * 0.72;
  const by = n.y - n.r * 0.72;
  return (
    <>
      {n.sameTime !== null && (
        <circle cx={n.x} cy={n.y} r={n.r + (flaggedRisk ? 9 : 4.5)} className="bm-same-ring" />
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
      {n.r >= 17 && (
        <text x={n.x} y={n.y} className="bm-pct" style={{ fontSize }}>
          {pctText(n.pct)}
        </text>
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

function nodeLabel(n: MapNode, graph: BubbleGraph): string {
  if (n.kind === "rest") return `${n.count} other top holders, ${pctText(n.pct)} together`;
  const cluster = n.cluster === null ? null : graph.clusters[n.cluster];
  if (n.kind === "funder")
    return `Funder ${shortAddress(n.wallet ?? "")}, paid for ${cluster?.wallets.length ?? 0} top holders`;
  const what = [
    n.flags.includes("creator") ? "the creator" : null,
    n.flags.includes("risky") ? "risky" : null,
    n.flags.includes("dumper") ? "known dumper" : null,
    typeof n.kol === "string" ? (n.kol ? `KOL ${n.kol}` : "a KOL") : null,
  ].filter(Boolean);
  const same = n.sameTime === null ? null : graph.sameTimeGroups[n.sameTime];
  return `Holder ${shortAddress(n.wallet ?? "")}, ${pctText(n.pct)} of supply${
    cluster ? `, funded by ${shortAddress(cluster.funder)}` : ""
  }${same ? `, funded in the same minute as ${same.wallets.length - 1} other top holders` : ""}${
    what.length ? `, ${what.join(", ")}` : ""
  }`;
}

/** What a tapped bubble is, under the map. */
function NodeDetail({ node: n, graph }: { node: MapNode | null; graph: BubbleGraph }) {
  if (!n) {
    return (
      <p className="bm-detail muted small">
        Tap a bubble to open that wallet, or a cluster below to light it up.
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
  if (typeof n.kol === "string") tags.push({ text: n.kol ? `KOL: ${n.kol}` : "KOL", tone: "kol" });
  if (cluster?.creatorLinked) tags.push({ text: "Tied to the creator", tone: "dev" });
  return (
    <div className="bm-detail small">
      <button
        type="button"
        className="num tm-wallet-btn"
        onClick={() => n.wallet && openWallet(n.wallet)}
        title="Open this wallet's details"
      >
        {n.kind === "funder" ? "Funder " : ""}
        {shortAddress(n.wallet ?? "")}
      </button>
      {n.kind === "holder" && <span className="num">{pctText(n.pct)} of supply</span>}
      {n.kind === "funder" && cluster && (
        <span className="muted">
          paid for {cluster.wallets.length} top holders with {pctText(cluster.pct)}
        </span>
      )}
      {n.kind === "holder" && cluster && (
        <span className="muted">
          {n.hub ? "funded the others in its cluster" : `funded by ${shortAddress(cluster.funder)}`}
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
export function BubbleMapSection({ token, snapshot }: { token: Token; snapshot: Snapshot | null }) {
  const [flagged, setFlagged] = useState<FlaggedHolder[]>([]);
  const mint = token.mintAddress;
  useEffect(() => {
    let live = true;
    // The chart card asks for the same path; the cache hands both the one answer.
    cachedGet<{ wallets?: FlaggedHolder[] }>(`/tokens/${encodeURIComponent(mint)}/chart`, 60_000)
      .then((c) => live && setFlagged(c.wallets ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mint]);
  const graph = useMemo(
    () => (snapshot ? layoutGraph(buildGraph(snapshot, flagged)) : null),
    [snapshot, flagged],
  );
  if (!graph || !graph.nodes.some((n) => n.kind === "holder") || graph.clusters.length === 0) return null;
  const label = tokenLabel(token);
  return (
    <section className="sage-card bm-section">
      <h4>
        <BubblesIcon size={14} /> Bubble map
        <span className="bm-section-actions">
          <ShareButton
            title={`${label} bubble map`}
            fileName={`trenchscanner-bubbles-${(token.symbol ?? mint.slice(0, 6)).toLowerCase()}`}
            caption={`${label} linked wallets on TrenchScanner`}
            iconOnly
            render={() => renderBubbleCard(graph, token)}
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
      <MapView graph={graph} compact />
    </section>
  );
}
