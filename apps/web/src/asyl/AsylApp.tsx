import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SESSION_ENDED_EVENT, post, type User } from "../api";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { asylApi, type AsylMe, type ChainRead, type Label, type MapDoc, type MapSummary } from "./asylApi";
import { renderMapCard } from "./asylCard";
import { AsylSignIn } from "./AsylSignIn";
import { EDGE_COLOUR, GraphView, type GraphViewHandle } from "./GraphView";
import {
  EDGE_KINDS,
  EDGE_LABEL,
  addressIn,
  graphCsv,
  mergeGraph,
  nodeName,
  removeNodes,
  shortAddr,
  visibleGraph,
  type AsylEdgeKind,
  type AsylGraph,
  type AsylNode,
} from "./graph";
import { Inspector, type InspectorActions } from "./Inspector";
import { newLayout } from "./layout";
import { basePath, parseRoute, routePath, sharedLink, type AsylRoute } from "./route";

/**
 * Asyl (asyl.trenchscanner.app, user ask 2026-10-24): an on-chain map of who funds, pays and
 * trades with whom. Search a wallet or coin, open what it is tied to, and keep, share or export the
 * map. Every signed-in reader maps from TrenchScanner's stored reads; Pro Mode adds the chain's
 * own reads (metered, apps/api/src/asyl/credits.ts) and the reader's own wallet labels.
 */

const EMPTY: AsylGraph = { nodes: [], edges: [] };
const BASE = typeof location === "undefined" ? "" : basePath(location.pathname);

type Session = "loading" | "out" | AsylMe;

function go(r: AsylRoute) {
  const path = routePath(r, BASE);
  if (location.pathname !== path) history.replaceState(null, "", path);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AsylApp() {
  const [session, setSession] = useState<Session>("loading");
  const [graph, setGraph] = useState<AsylGraph>(EMPTY);
  const layout = useRef(newLayout());
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<AsylEdgeKind>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [mapNote, setMapNote] = useState("");
  const [current, setCurrent] = useState<MapSummary | null>(null);
  const [title, setTitle] = useState("Untitled map");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<Label[]>([]);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [rail, setRail] = useState<"maps" | "labels" | "legend">("legend");
  const [railOpen, setRailOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const view = useRef<GraphViewHandle>(null);
  const started = useRef(false);

  const me = typeof session === "object" ? session : null;

  const loadMe = useCallback(() => {
    asylApi
      .me()
      .then(setSession)
      .catch((e) => {
        // Signed out, or the API not answering: either way the sign-in screen, which says so on a retry.
        if (!(e instanceof ApiError) || e.status !== 401) console.warn("asyl: /me", e);
        setSession("out");
      });
  }, []);

  useEffect(() => {
    loadMe();
    const onEnded = () => setSession("out");
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [loadMe]);

  const refreshLists = useCallback(() => {
    asylApi.labels().then(
      (r) => setLabels(r.wallets),
      () => undefined,
    );
    asylApi.maps().then(
      (r) => setMaps(r.maps),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (me) refreshLists();
  }, [me?.wallet, refreshLists]);

  /** Adds an answer to the map, leaving out what the reader took off it. */
  const add = useCallback(
    (next: AsylGraph) => {
      setGraph((g) => removeNodes(mergeGraph(g, next), removed));
      setDirty(true);
    },
    [removed],
  );

  const run = useCallback(async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setStatus(null);
    try {
      const text = await fn();
      if (text) setStatus({ text, tone: "info" });
    } catch (e) {
      setStatus({ text: errorText(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  }, []);

  const afterChain = (r: ChainRead, what: string) => {
    add(r.graph);
    setSession((s) => (typeof s === "object" ? { ...s, chain: r.allowance } : s));
    return r.cached
      ? `${what}: read earlier today, no credits used.`
      : `${what}: ${r.credits} credit${r.credits === 1 ? "" : "s"} used.`;
  };

  const openWallet = useCallback(
    (wallet: string) =>
      run("Mapping the wallet…", async () => {
        const r = await asylApi.wallet(wallet);
        add(r.graph);
        setFocus(wallet);
        setSelected(wallet);
        if (!current) go({ kind: "wallet", address: wallet });
        return r.coverage?.note;
      }),
    [add, run, current],
  );

  const openToken = useCallback(
    (mint: string) =>
      run("Mapping the holders…", async () => {
        const r = await asylApi.token(mint);
        add(r.graph);
        setFocus(mint);
        setSelected(mint);
        if (!current) go({ kind: "token", address: mint });
        return r.coverage?.note;
      }),
    [add, run, current],
  );

  const search = (text: string) => {
    const a = addressIn(text);
    if (!a) {
      setStatus({
        text: "Paste a Solana wallet or coin address, or a Solscan, DexScreener or pump.fun link.",
        tone: "error",
      });
      return;
    }
    setQuery("");
    void run("Looking it up…", async () => {
      const r = await asylApi.resolve(a);
      if (r.kind === "token") await openToken(a);
      else await openWallet(a);
    });
  };

  const loadMap = useCallback(
    (id: string) =>
      run("Opening the map…", async () => {
        const m = await asylApi.map(id);
        layout.current = newLayout();
        for (const [nid, [x, y]] of Object.entries(m.doc.positions)) {
          layout.current.pos.set(nid, { x, y });
          layout.current.vel.set(nid, { x: 0, y: 0 });
        }
        setGraph({ nodes: m.doc.nodes, edges: m.doc.edges });
        setNotes(m.doc.notes);
        setMapNote(m.doc.note);
        setRemoved(new Set(m.doc.hidden));
        setFocus(m.doc.focus);
        setSelected(null);
        setTitle(m.title);
        setCurrent(m);
        setDirty(false);
        go({ kind: "map", id });
      }),
    [run],
  );

  // The address the page was opened on, once signed in.
  useEffect(() => {
    if (!me || started.current) return;
    started.current = true;
    const r = parseRoute(location.pathname);
    if (r.kind === "wallet") void openWallet(r.address);
    else if (r.kind === "token") void openToken(r.address);
    else if (r.kind === "map") void loadMap(r.id);
  }, [me, openWallet, openToken, loadMap]);

  const newMap = () => {
    if (
      dirty &&
      graph.nodes.length > 0 &&
      !confirm("Start a new map? This one has changes that aren't saved.")
    )
      return;
    layout.current = newLayout();
    setGraph(EMPTY);
    setNotes({});
    setMapNote("");
    setRemoved(new Set());
    setFocus(null);
    setSelected(null);
    setCurrent(null);
    setTitle("Untitled map");
    setDirty(false);
    setStatus(null);
    go({ kind: "home" });
  };

  const docOf = (): MapDoc => {
    const positions: Record<string, [number, number]> = {};
    for (const n of graph.nodes) {
      const p = layout.current.pos.get(n.id);
      if (p) positions[n.id] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
    }
    const kept = Object.fromEntries(
      Object.entries(notes).filter(([id, t]) => t.trim() && graph.nodes.some((n) => n.id === id)),
    );
    return {
      v: 1,
      nodes: graph.nodes,
      edges: graph.edges,
      positions,
      notes: kept,
      note: mapNote,
      hidden: [...removed],
      focus,
    };
  };

  const save = async (): Promise<MapSummary | null> => {
    const t = title.trim() || "Untitled map";
    if (current) {
      await asylApi.updateMap(current.id, t, docOf());
      setDirty(false);
      refreshLists();
      return current;
    }
    const { map } = await asylApi.createMap(t, docOf());
    setCurrent(map);
    setDirty(false);
    go({ kind: "map", id: map.id });
    refreshLists();
    return map;
  };

  const shareLink = () =>
    run("Sharing…", async () => {
      const map = await save();
      if (!map) return;
      const { slug } = await asylApi.share(map.id);
      setCurrent({ ...map, shareSlug: slug, sharedAt: new Date().toISOString() });
      const link = sharedLink(slug);
      await navigator.clipboard?.writeText(link).catch(() => undefined);
      refreshLists();
      return `Link copied: ${link}. It shows the map as it is now; share again after changes to update it.`;
    });

  const unshare = () =>
    run("Unsharing…", async () => {
      if (!current) return;
      await asylApi.unshare(current.id);
      setCurrent({ ...current, shareSlug: null, sharedAt: null });
      refreshLists();
      return "The link no longer opens the map.";
    });

  const exportCsv = () => {
    const blob = new Blob([graphCsv(graph)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asyl-${(title.trim() || "map").replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const signOut = async () => {
    await post("/auth/logout").catch(() => undefined);
    setSession("out");
  };

  const actions: InspectorActions = {
    expand: (n: AsylNode) => void (n.kind === "token" ? openToken(n.id) : openWallet(n.id)),
    similar: (wallet) =>
      void run("Finding wallets that trade like it…", async () => {
        const r = await asylApi.similar(wallet);
        add(r.graph);
        return r.coTraders.length
          ? `${r.coTraders.length} wallet${r.coTraders.length === 1 ? "" : "s"} bought the same coins within minutes of it.`
          : "No wallet bought its coins alongside it often enough to link.";
      }),
    flows: (wallet) =>
      void run("Reading its transfers from the chain…", async () => {
        const r = await asylApi.flows(wallet);
        return afterChain(r, `${r.flows?.txs ?? 0} transactions read`);
      }),
    funders: (wallets) =>
      void run("Finding funders on the chain…", async () => {
        const r = await asylApi.funders(wallets);
        return afterChain(
          r,
          `${r.found} of ${wallets.length} funder${wallets.length === 1 ? "" : "s"} found`,
        );
      }),
    chainToken: (mint) =>
      void run("Reading holders from the chain…", async () => {
        const r = await asylApi.chainToken(mint);
        return afterChain(r, "Live holders read");
      }),
    hide: (id) => {
      setRemoved((s) => new Set(s).add(id));
      setGraph((g) => removeNodes(g, new Set([id])));
      setSelected(null);
      setDirty(true);
    },
    select: (id) => setSelected(id),
    saveLabel: async (wallet, name, kol) => {
      const r = await asylApi.saveLabel(wallet, name, kol);
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === wallet
            ? { ...n, name: r.wallet.name, tags: [...new Set([...n.tags, "mine" as const])] }
            : n,
        ),
      }));
      setDirty(true);
      refreshLists();
    },
    removeLabel: async (wallet) => {
      await asylApi.removeLabel(wallet);
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === wallet ? { ...n, name: null, tags: n.tags.filter((t) => t !== "mine") } : n,
        ),
      }));
      setDirty(true);
      refreshLists();
    },
    setNote: (id, text) => {
      setNotes((m) => ({ ...m, [id]: text }));
      setDirty(true);
    },
  };

  const keep = useMemo(() => new Set([focus, selected].filter((x): x is string => !!x)), [focus, selected]);
  const shown = useMemo(() => visibleGraph(graph, hiddenKinds, keep), [graph, hiddenKinds, keep]);
  const layoutKey = `${shown.nodes.length}:${shown.edges.length}:${shown.nodes.at(-1)?.id ?? ""}`;
  const selectedNode = selected ? (graph.nodes.find((n) => n.id === selected) ?? null) : null;
  const unfunded = useMemo(() => {
    const funded = new Set(graph.edges.filter((e) => e.kind === "funded").map((e) => e.b));
    return graph.nodes
      .filter((n) => n.kind === "wallet" && !funded.has(n.id) && !n.tags.includes("exchange"))
      .map((n) => n.id)
      .slice(0, 20);
  }, [graph]);

  if (parseRoute(location.pathname).kind === "shared") return null;
  if (session === "loading") return <div className="asyl-loading">ASYL</div>;
  if (session === "out")
    return (
      <AsylSignIn
        onSignedIn={(_u: User) => {
          started.current = false;
          loadMe();
        }}
      />
    );

  const chain = session.chain;

  return (
    <div className="asyl-app">
      <header className="asyl-top">
        <a className="asyl-wordmark small" href={`${BASE}/`} onClick={(e) => (e.preventDefault(), newMap())}>
          ASYL
        </a>
        <form
          className="asyl-search"
          onSubmit={(e) => {
            e.preventDefault();
            search(query);
          }}
        >
          <input
            className="asyl-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (addressIn(text)) {
                e.preventDefault();
                search(text);
              }
            }}
            placeholder="Paste a wallet, coin or link"
            aria-label="Wallet or coin address"
            spellCheck={false}
          />
          <button className="asyl-btn primary" disabled={!!busy}>
            Map it
          </button>
        </form>
        <div className="asyl-me">
          {session.pro ? (
            <span className="asyl-pro-chip" title="Pro Mode: chain reads and your own labels">
              Pro
            </span>
          ) : (
            <a
              className="asyl-muted asyl-small"
              href="https://trenchscanner.app/#settings"
              target="_blank"
              rel="noreferrer"
            >
              Get Pro Mode
            </a>
          )}
          {chain && (
            <div
              className="asyl-meter"
              title={`Chain reads today: ${chain.used} of ${chain.cap} credits. Resets at 00:00 UTC.`}
            >
              <div
                className="asyl-meter-bar"
                style={{ width: `${Math.min(100, (chain.used / Math.max(1, chain.cap)) * 100)}%` }}
              />
              <span>{Math.max(0, chain.left)} credits left</span>
            </div>
          )}
          <button className="asyl-link" onClick={() => void signOut()} title={session.wallet}>
            {shortAddr(session.wallet)} · Sign out
          </button>
        </div>
      </header>

      <div className="asyl-body">
        <nav className={`asyl-rail${railOpen ? " open" : ""}`} aria-label="Maps, labels and legend">
          <div className="asyl-rail-tabs" role="tablist">
            {(["legend", "maps", "labels"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={rail === t}
                className={rail === t ? "on" : ""}
                onClick={() => setRail(t)}
              >
                {t === "legend" ? "Map" : t === "maps" ? "Saved" : "Labels"}
              </button>
            ))}
          </div>
          {rail === "legend" && (
            <div className="asyl-rail-body">
              <input
                className="asyl-input asyl-title-input"
                value={title}
                maxLength={80}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
                aria-label="Map title"
              />
              <textarea
                className="asyl-input asyl-note"
                rows={3}
                maxLength={2000}
                value={mapNote}
                placeholder="Notes on this map"
                onChange={(e) => {
                  setMapNote(e.target.value);
                  setDirty(true);
                }}
              />
              <h3>Links</h3>
              <ul className="asyl-legend">
                {EDGE_KINDS.map((k) => {
                  const count = graph.edges.filter((e) => e.kind === k).length;
                  return (
                    <li key={k}>
                      <label className={hiddenKinds.has(k) ? "off" : ""}>
                        <input
                          type="checkbox"
                          checked={!hiddenKinds.has(k)}
                          onChange={() =>
                            setHiddenKinds((s) => {
                              const n = new Set(s);
                              if (n.has(k)) n.delete(k);
                              else n.add(k);
                              return n;
                            })
                          }
                        />
                        <i style={{ background: EDGE_COLOUR[k] }} />
                        {EDGE_LABEL[k]} <span className="asyl-muted">{count || ""}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="asyl-muted asyl-small">
                Dashed lines come from the chain; the rest from TrenchScanner&apos;s reads of the last 30
                days. Colours group wallets tied by funding or transfers. Rings: white your label, gold KOL,
                red risky, green winner.
              </p>
              {removed.size > 0 && (
                <button
                  className="asyl-link"
                  onClick={() => {
                    setRemoved(new Set());
                    setDirty(true);
                  }}
                >
                  Let {removed.size} wallet{removed.size === 1 ? "" : "s"} you took off come back
                </button>
              )}
            </div>
          )}
          {rail === "maps" && (
            <div className="asyl-rail-body">
              {maps.length === 0 && <p className="asyl-muted">Maps you save show here.</p>}
              <ul className="asyl-list">
                {maps.map((m) => (
                  <li key={m.id} className={current?.id === m.id ? "on" : ""}>
                    <button className="asyl-link" onClick={() => void loadMap(m.id)}>
                      {m.title}
                    </button>
                    <span className="asyl-muted asyl-small">
                      {m.nodes} on it{m.shareSlug ? " · shared" : ""}
                    </span>
                    <button
                      className="asyl-icon-btn"
                      aria-label={`Delete ${m.title}`}
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete "${m.title}"?${m.shareSlug ? " Its shared link stops working." : ""}`,
                          )
                        )
                          return;
                        void run("Deleting…", async () => {
                          await asylApi.deleteMap(m.id);
                          if (current?.id === m.id) setCurrent(null);
                          refreshLists();
                        });
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rail === "labels" && (
            <div className="asyl-rail-body">
              {!session.pro && labels.length === 0 && (
                <p className="asyl-muted">
                  With Pro Mode, wallets you name show here and on every map, as they do in TrenchScanner.
                </p>
              )}
              {labels.length > 0 && (
                <button
                  className="asyl-btn"
                  disabled={!!busy || !session.pro}
                  onClick={() =>
                    void run("Mapping your labels…", async () => {
                      const r = await asylApi.labelsMap();
                      add(r.graph);
                      return `${r.graph.nodes.filter((n) => n.tags.includes("mine")).length} labeled wallets on the map.`;
                    })
                  }
                >
                  Map all my labels
                </button>
              )}
              <ul className="asyl-list">
                {labels.map((l) => (
                  <li key={l.wallet}>
                    <button className="asyl-link" onClick={() => void openWallet(l.wallet)}>
                      {l.name}
                    </button>
                    <span className="asyl-muted asyl-small">
                      {shortAddr(l.wallet)}
                      {l.category === "kol" ? " · KOL" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        <main className="asyl-stage">
          <div className="asyl-toolbar">
            <button
              className="asyl-btn ghost asyl-rail-toggle"
              onClick={() => setRailOpen((o) => !o)}
              aria-expanded={railOpen}
            >
              ☰
            </button>
            <button className="asyl-btn ghost" onClick={newMap}>
              New
            </button>
            <button
              className="asyl-btn ghost"
              disabled={graph.nodes.length === 0}
              onClick={() => view.current?.fit()}
            >
              Fit
            </button>
            <button
              className="asyl-btn ghost"
              disabled={graph.nodes.length === 0 || !!busy}
              onClick={() => void run("Saving…", async () => (await save(), "Saved."))}
            >
              {current ? (dirty ? "Save*" : "Saved") : "Save"}
            </button>
            <button
              className="asyl-btn ghost"
              disabled={graph.nodes.length === 0 || !!busy}
              onClick={() => void shareLink()}
            >
              {current?.shareSlug ? "Update link" : "Share link"}
            </button>
            {current?.shareSlug && (
              <button className="asyl-btn ghost" disabled={!!busy} onClick={() => void unshare()}>
                Unshare
              </button>
            )}
            <button
              className="asyl-btn ghost"
              disabled={graph.nodes.length === 0}
              onClick={() => setSharing(true)}
            >
              Image
            </button>
            <button className="asyl-btn ghost" disabled={graph.edges.length === 0} onClick={exportCsv}>
              CSV
            </button>
            {session.pro && unfunded.length > 0 && (
              <button
                className="asyl-btn ghost chain"
                disabled={!!busy || (chain?.left ?? 0) <= 0}
                title={`Looks up who funded up to ${unfunded.length} wallets on the map with no funder yet (up to ${unfunded.length * 11} credits).`}
                onClick={() => actions.funders(unfunded)}
              >
                Find funders ({unfunded.length})
              </button>
            )}
          </div>

          {graph.nodes.length === 0 ? (
            <div className="asyl-empty">
              <h2>Who&apos;s behind it?</h2>
              <p>
                Paste a wallet to see who funded it, who it pays, which wallets buy the same coins with it,
                and its side wallets. Paste a coin to see how its top holders tie together.
              </p>
              {labels.length > 0 && (
                <p className="asyl-muted">Or open one of your labeled wallets from Labels.</p>
              )}
            </div>
          ) : (
            <GraphView
              graph={shown}
              layout={layout.current}
              selected={selected}
              focus={focus}
              onSelect={setSelected}
              onOpen={(id) => {
                const n = graph.nodes.find((x) => x.id === id);
                if (n) actions.expand(n);
              }}
              onMoved={() => setDirty(true)}
              layoutKey={layoutKey}
              handle={view}
            />
          )}

          {(busy || status) && (
            <div className={`asyl-status ${status?.tone ?? "info"}`} role="status">
              {busy ?? status?.text}
              {!busy && (
                <button className="asyl-icon-btn" onClick={() => setStatus(null)} aria-label="Dismiss">
                  ×
                </button>
              )}
            </div>
          )}
        </main>

        {selectedNode && (
          <Inspector
            node={selectedNode}
            graph={graph}
            me={session}
            busy={busy}
            note={notes[selectedNode.id] ?? ""}
            actions={actions}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {sharing && (
        <ShareImageDialog
          title={title}
          fileName={`asyl-${(title.trim() || "map").replace(/[^\w-]+/g, "-").toLowerCase()}`}
          caption={`${title} · Asyl`}
          link={current?.shareSlug ? sharedLink(current.shareSlug) : "asyl.trenchscanner.app"}
          wide
          render={() =>
            renderMapCard({
              title:
                title.trim() ||
                (focus
                  ? `Around ${nodeName(graph.nodes.find((n) => n.id === focus) ?? ({ id: focus, name: null } as AsylNode))}`
                  : "Asyl map"),
              graph: shown,
              layout: layout.current,
              focus,
            })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}
