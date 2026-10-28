import { useEffect, useMemo, useRef, useState } from "react";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { asylApi, type MapDoc } from "./asylApi";
import { renderMapCard } from "./asylCard";
import { renderAnalystCard } from "./analystCard";
import { AnalystLegend } from "./AnalystLayer";
import { GraphView, MapLegend, type GraphViewHandle } from "./GraphView";
import {
  DEFAULT_TIME_LABELS,
  EDGE_KINDS,
  TAG_LABEL,
  cleanCutoffs,
  cleanDrawings,
  mergeGraph,
  nodeName,
  shortAddr,
  perWalletOf,
  visibleGraph,
} from "./graph";
import { newLayout } from "./layout";
import { basePath, sharedLink } from "./route";

/**
 * A shared map (/s/<slug>): read-only, open to anyone with the link, signed in or not. It shows the
 * map as its owner froze it when they shared it (apps/api/src/asyl/maps.ts shareMap). Its names,
 * tags and notes are the owner's, and the page says so (user decision 2026-10-27, full audit TR-2):
 * they are not TrenchScanner's findings. An admin can take the link down from here.
 */
export function SharedView({ slug }: { slug: string }) {
  const [map, setMap] = useState<{ title: string; sharedAt: string | null; doc: MapDoc } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [takenDown, setTakenDown] = useState(false);
  const layout = useRef(newLayout());
  const view = useRef<GraphViewHandle>(null);

  useEffect(() => {
    asylApi
      .shared(slug)
      .then((m) => {
        for (const [id, [x, y]] of Object.entries(m.doc.positions)) {
          layout.current.pos.set(id, { x, y });
          layout.current.vel.set(id, { x: 0, y: 0 });
        }
        layout.current.pinned = new Set((m.doc.pinned ?? []).filter((id) => id in m.doc.positions));
        setMap(m);
        document.title = `${m.title} · Asyl`;
      })
      .catch((e: Error) => setError(e.message));
  }, [slug]);

  // Only to offer an admin the takedown: a viewer who isn't signed in just doesn't see it.
  useEffect(() => {
    asylApi
      .me()
      .then((me) => setAdmin(me.admin === true))
      .catch(() => undefined);
  }, []);

  const takeDown = () => {
    if (!confirm("Take this map's link down? It stops answering, and its owner can't share it again."))
      return;
    asylApi
      .takeDown(slug)
      .then(() => setTakenDown(true))
      .catch((e: Error) => alert(e.message));
  };

  // As its owner saw it: the kinds of link they switched off and their amount cutoffs hold here too
  // (the dollar one needs SOL's price, which a public page doesn't read, so it cuts nothing).
  const graph = useMemo(() => {
    if (!map) return { nodes: [], edges: [] };
    const hidden = new Set(EDGE_KINDS.filter((k) => map.doc.hidden.includes(k)));
    const keep = new Set(map.doc.focus ? [map.doc.focus] : []);
    // Merged into nothing: a doc holding one link twice draws it once.
    const doc = mergeGraph({ nodes: [], edges: [] }, { nodes: map.doc.nodes, edges: map.doc.edges });
    return visibleGraph(doc, hidden, keep, {
      cutoffs: map.doc.cutoffs ? cleanCutoffs(map.doc.cutoffs) : undefined,
      solUsd: null,
      perWallet: perWalletOf(map.doc.walletHidden),
      hideLoose: map.doc.hideLoose ?? false,
    });
  }, [map]);
  const node = selected ? graph.nodes.find((n) => n.id === selected) : undefined;
  const base = basePath(location.pathname);

  if (error)
    return (
      <div className="asyl-gate">
        <div className="asyl-gate-card">
          <h1 className="asyl-wordmark">ASYL</h1>
          <p>{error}</p>
          <a className="asyl-btn primary" href={`${base}/`}>
            Open Asyl
          </a>
        </div>
      </div>
    );
  if (!map) return <div className="asyl-loading">ASYL</div>;

  return (
    <div className="asyl-app shared">
      <header className="asyl-top">
        <a className="asyl-wordmark small" href={`${base}/`}>
          ASYL
        </a>
        <div className="asyl-shared-title">
          <h1>{map.title}</h1>
          <span className="asyl-muted asyl-small">
            Shared map
            {map.sharedAt
              ? ` · ${new Date(map.sharedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
              : ""}{" "}
            · read-only
          </span>
          <span className="asyl-muted asyl-small asyl-shared-author">
            Made by an Asyl user. The names, tags and notes on it are theirs, not TrenchScanner&apos;s.
          </span>
        </div>
        <div className="asyl-me">
          {admin && (
            <button className="asyl-btn ghost" onClick={takeDown} disabled={takenDown}>
              {takenDown ? "Taken down" : "Take down"}
            </button>
          )}
          <button className="asyl-btn ghost" onClick={() => setSharing(true)}>
            Image
          </button>
          <a className="asyl-btn primary" href={`${base}/`}>
            Make your own
          </a>
        </div>
      </header>
      <div className="asyl-body">
        <main className="asyl-stage">
          <GraphView
            graph={graph}
            layout={layout.current}
            selected={selected}
            focus={map.doc.focus}
            onSelect={setSelected}
            layoutKey={`${graph.nodes.length}`}
            handle={view}
            readOnly
            drawings={cleanDrawings(map.doc.drawings)}
            grid={map.doc.grid ?? false}
            analyst={map.doc.analyst ?? false}
            timeLabels={map.doc.times ? { ...DEFAULT_TIME_LABELS, ...map.doc.times } : undefined}
          />
          {map.doc.analyst ? (
            <AnalystLegend graph={graph} focus={map.doc.focus} />
          ) : (
            <MapLegend graph={graph} />
          )}
          {map.doc.note && <p className="asyl-shared-note">{map.doc.note}</p>}
        </main>
        {node && (
          <aside className="asyl-inspector">
            <header className="asyl-insp-head">
              <div className="asyl-insp-title">
                <h2>{nodeName(node)}</h2>
                <span className="asyl-muted">{shortAddr(node.id)}</span>
              </div>
              <button className="asyl-icon-btn" onClick={() => setSelected(null)} aria-label="Close">
                ×
              </button>
            </header>
            {node.tags.length > 0 && (
              <div className="asyl-tags" title="Tags as the map's author saved them">
                {node.tags.map((t) => (
                  <span key={t} className={`asyl-tag tag-${t}`}>
                    {TAG_LABEL[t]}
                  </span>
                ))}
              </div>
            )}
            {map.doc.notes[node.id] && (
              <p className="asyl-shared-note" title="The map's author's note">
                {map.doc.notes[node.id]}
              </p>
            )}
            <footer className="asyl-insp-foot">
              <a
                href={`https://solscan.io/${node.kind === "token" ? "token" : "account"}/${node.id}`}
                target="_blank"
                rel="noreferrer"
              >
                Solscan
              </a>
              <a href={`${base}/${node.kind === "token" ? "t" : "w"}/${node.id}`}>Map it in Asyl</a>
            </footer>
          </aside>
        )}
      </div>
      {sharing && (
        <ShareImageDialog
          title={map.title}
          fileName="asyl-map"
          caption={`${map.title} · Asyl`}
          link={sharedLink(slug)}
          wide
          render={() =>
            (map.doc.analyst ? renderAnalystCard : renderMapCard)({
              title: map.title,
              graph,
              layout: layout.current,
              focus: map.doc.focus,
              drawings: cleanDrawings(map.doc.drawings),
              timeLabels: map.doc.times ? { ...DEFAULT_TIME_LABELS, ...map.doc.times } : undefined,
            })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}
