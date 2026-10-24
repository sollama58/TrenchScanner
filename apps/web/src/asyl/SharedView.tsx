import { useEffect, useMemo, useRef, useState } from "react";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { asylApi, type MapDoc } from "./asylApi";
import { renderMapCard } from "./asylCard";
import { EDGE_COLOUR, GraphView, type GraphViewHandle } from "./GraphView";
import { EDGE_KINDS, EDGE_LABEL, TAG_LABEL, nodeName, shortAddr } from "./graph";
import { newLayout } from "./layout";
import { basePath, sharedLink } from "./route";

/**
 * A shared map (/s/<slug>): read-only, open to anyone with the link, signed in or not. It shows the
 * map as its owner froze it when they shared it (apps/api/src/asyl/maps.ts shareMap).
 */
export function SharedView({ slug }: { slug: string }) {
  const [map, setMap] = useState<{ title: string; sharedAt: string | null; doc: MapDoc } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
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
        setMap(m);
        document.title = `${m.title} · Asyl`;
      })
      .catch((e: Error) => setError(e.message));
  }, [slug]);

  const graph = useMemo(
    () => (map ? { nodes: map.doc.nodes, edges: map.doc.edges } : { nodes: [], edges: [] }),
    [map],
  );
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
            Shared map{map.sharedAt ? ` · ${new Date(map.sharedAt).toLocaleDateString()}` : ""} · read-only
          </span>
        </div>
        <div className="asyl-me">
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
          />
          <div className="asyl-shared-legend">
            {EDGE_KINDS.filter((k) => graph.edges.some((e) => e.kind === k)).map((k) => (
              <span key={k}>
                <i style={{ background: EDGE_COLOUR[k] }} />
                {EDGE_LABEL[k]}
              </span>
            ))}
          </div>
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
              <div className="asyl-tags">
                {node.tags.map((t) => (
                  <span key={t} className={`asyl-tag tag-${t}`}>
                    {TAG_LABEL[t]}
                  </span>
                ))}
              </div>
            )}
            {map.doc.notes[node.id] && <p className="asyl-shared-note">{map.doc.notes[node.id]}</p>}
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
            renderMapCard({ title: map.title, graph, layout: layout.current, focus: map.doc.focus })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}
