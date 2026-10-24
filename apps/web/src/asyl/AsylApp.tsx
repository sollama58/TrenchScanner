import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SESSION_ENDED_EVENT, post } from "../api";
import { dashboardUrl } from "../returnTo";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { asylApi, type AsylMe, type ChainRead, type Label, type MapDoc, type MapSummary } from "./asylApi";
import { renderMapCard } from "./asylCard";
import { AsylSignIn } from "./AsylSignIn";
import { GraphView, MapLegend, type GraphViewHandle } from "./GraphView";
import {
  EDGE_KINDS,
  EDGE_LABEL,
  NO_CUTOFFS,
  addressIn,
  clearsCutoffs,
  edgeKey,
  graphCsv,
  mergeGraph,
  nodeName,
  removeNodes,
  shortAddr,
  visibleGraph,
  withDeployLines,
  type AsylEdgeKind,
  type AsylGraph,
  type AsylNode,
  type Cutoffs,
} from "./graph";
import { Inspector, type InspectorActions } from "./Inspector";
import { LinkFilters } from "./LinkFilters";
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

type Session = "loading" | "out" | "down" | AsylMe;

function go(r: AsylRoute) {
  const path = routePath(r, BASE);
  if (location.pathname !== path) history.replaceState(null, "", path);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the links read takes from the map: as many wallets and coins as the API allows. */
const LINKS_WALLETS = 400;
const LINKS_TOKENS = 200;

/** Keyboard shortcuts (user ask 2026-10-24), as the help card lists them. */
const KEYS: [string, string][] = [
  ["Del", "Take the selected wallet or coin off the map"],
  ["Z", "Bring back the last one taken off"],
  ["H", "List what is taken off, to bring back"],
  ["N / Shift+N", "Select the next / previous one on the map"],
  ["Enter", "Expand the selected one's links"],
  ["S", "Wallets that trade like the selected one"],
  ["L", "Links between everything shown"],
  ["D", "Deployers of the coins shown"],
  ["F", "Fit the map to the screen"],
  ["/", "Search"],
  ["Ctrl+S", "Save the map"],
  ["Esc", "Clear the selection"],
  ["?", "Show or hide these keys"],
];

/** The amount sliders are the reader's own: kept in this browser between maps. */
const CUTOFFS_KEY = "asyl:cutoffs";

function storedCutoffs(): Cutoffs {
  try {
    const raw = JSON.parse(localStorage.getItem(CUTOFFS_KEY) ?? "null") as Partial<Cutoffs> | null;
    if (!raw || typeof raw !== "object") return NO_CUTOFFS;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    return { sol: n(raw.sol), usd: n(raw.usd), tokens: n(raw.tokens), pct: n(raw.pct) };
  } catch {
    return NO_CUTOFFS;
  }
}

type RailTab = "map" | "links" | "maps" | "labels";
const RAIL_TABS: { id: RailTab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "links", label: "Links" },
  { id: "maps", label: "Saved" },
  { id: "labels", label: "Labels" },
];

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function AsylApp() {
  const [session, setSession] = useState<Session>("loading");
  const [graph, setGraph] = useState<AsylGraph>(EMPTY);
  const layout = useRef(newLayout());
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<AsylEdgeKind>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [cut, setCut] = useState<Set<string>>(new Set());
  const [cutoffs, setCutoffsState] = useState<Cutoffs>(storedCutoffs);
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
  const [rail, setRail] = useState<RailTab>("map");
  const [railOpen, setRailOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [unhidePick, setUnhidePick] = useState<Set<string>>(new Set());
  const view = useRef<GraphViewHandle>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const me = typeof session === "object" ? session : null;
  const solUsd = me?.solUsd ?? null;

  const setCutoffs = useCallback((c: Cutoffs) => {
    setCutoffsState(c);
    try {
      localStorage.setItem(CUTOFFS_KEY, JSON.stringify(c));
    } catch {
      // Storage blocked: the sliders hold for this visit.
    }
  }, []);

  const loadMe = useCallback(() => {
    asylApi
      .me()
      .then(setSession)
      .catch((e) => {
        // Only a real "not signed in" sends the visitor to sign in; an API that isn't answering
        // (a deploy, a network blip) says so and offers a retry.
        setSession(e instanceof ApiError && e.status === 401 ? "out" : "down");
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

  /**
   * Adds an answer to the map. What the reader took off stays in it, out of view (`removed`), so
   * it can be brought back.
   */
  const add = useCallback((next: AsylGraph) => {
    setGraph((g) => withDeployLines(mergeGraph(g, next)));
    setDirty(true);
  }, []);

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
        setGraph(withDeployLines({ nodes: m.doc.nodes, edges: m.doc.edges }));
        setNotes(m.doc.notes);
        setMapNote(m.doc.note);
        setRemoved(new Set(m.doc.removed ?? []));
        setCut(new Set(m.doc.cut ?? []));
        if (m.doc.cutoffs) setCutoffs(m.doc.cutoffs);
        setHiddenKinds(new Set(EDGE_KINDS.filter((k) => m.doc.hidden.includes(k))));
        setFocus(m.doc.focus);
        setSelected(null);
        setTitle(m.title);
        setCurrent(m);
        setDirty(false);
        go({ kind: "map", id });
      }),
    [run, setCutoffs],
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
    setCut(new Set());
    setFocus(null);
    setSelected(null);
    setCurrent(null);
    setTitle("Untitled map");
    setDirty(false);
    setStatus(null);
    go({ kind: "home" });
  };

  const kept = useMemo(() => removeNodes(graph, removed), [graph, removed]);

  /**
   * Every stored link between the wallets and coins shown (user ask 2026-10-24: "show transfers
   * between visible wallets/tokens"), free of credits; with `deployers`, each shown coin's
   * deployer too. `wallets` and `tokens` default to what is shown.
   */
  function linksAmong(wallets?: string[], tokens?: string[], deployers = false) {
    const ws = wallets ?? shown.nodes.filter((n) => n.kind === "wallet").map((n) => n.id);
    const ts = tokens ?? shown.nodes.filter((n) => n.kind === "token").map((n) => n.id);
    if (deployers ? ts.length === 0 : ws.length === 0) return Promise.resolve();
    return run(deployers ? "Finding the deployers…" : "Finding links between what's shown…", async () => {
      const r = await asylApi.links(ws.slice(0, LINKS_WALLETS), ts.slice(0, LINKS_TOKENS), deployers);
      const known = new Set(graph.edges.map(edgeKey));
      const fresh = r.graph.edges.filter((e) => !known.has(edgeKey(e)));
      add(r.graph);
      const off = [...new Set(fresh.map((e) => e.kind))].filter((k) => hiddenKinds.has(k));
      const small = fresh.filter(
        (e) => !hiddenKinds.has(e.kind) && !clearsCutoffs(e, cutoffs, solUsd),
      ).length;
      const offNote =
        (off.length ? ` Some are ${off.map((k) => EDGE_LABEL[k]).join(", ")}, switched off in Links.` : "") +
        (small ? ` ${small} under your amount cutoffs ${small === 1 ? "is" : "are"} hidden.` : "");
      if (deployers) {
        const devs = new Set(fresh.filter((e) => e.kind === "created").map((e) => e.a));
        return devs.size
          ? `${devs.size} deployer${devs.size === 1 ? "" : "s"} added, with their lines.${offNote}`
          : "TrenchScanner doesn't know a deployer for these coins that isn't already shown.";
      }
      return fresh.length
        ? `${fresh.length} new link${fresh.length === 1 ? "" : "s"} between what's shown.${offNote}`
        : "No more links between what's shown in TrenchScanner's reads.";
    });
  }

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
      hidden: [...hiddenKinds],
      removed: [...removed].filter((id) => graph.nodes.some((n) => n.id === id)),
      cut: [...cut].filter((k) => graph.edges.some((e) => edgeKey(e) === k)),
      cutoffs,
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
      const ownLabels = graph.nodes.some((n) => n.tags.includes("mine"));
      return `Link copied: ${link}. It shows the map as it is now${ownLabels ? ", your labels on it included" : ""}; share again after changes to update it.`;
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
    const blob = new Blob([graphCsv(kept)], { type: "text/csv" });
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
      setRemoved((s) => {
        const n = new Set(s);
        n.delete(id);
        return n.add(id);
      });
      setSelected(null);
      setDirty(true);
    },
    showDeployer: (mint) =>
      void run("Finding who deployed it…", async () => {
        const r = await asylApi.deployer(mint);
        add(r.graph);
        if (r.allowance) {
          const allowance = r.allowance;
          setSession((s) => (typeof s === "object" ? { ...s, chain: allowance } : s));
        }
        if (!r.deployer) return "Neither TrenchScanner nor the chain names a wallet that deployed it.";
        setSelected(r.deployer.wallet);
        const spent = r.credits ? ` Read from the chain: ${r.credits} credits.` : "";
        return r.deployer.verified
          ? `Deployed by ${shortAddr(r.deployer.wallet)}, the wallet that signed its create transaction.${spent}`
          : `${shortAddr(r.deployer.wallet)} is the creator TrenchScanner was told, unconfirmed: a community takeover can move it.${session !== "loading" && typeof session === "object" && session.pro ? "" : " Pro Mode confirms it from the chain."}`;
      }),
    cutLink: (key) => {
      setCut((s) => new Set(s).add(key));
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
  const shown = useMemo(
    () => visibleGraph(kept, hiddenKinds, keep, { cut, cutoffs, solUsd }),
    [kept, hiddenKinds, keep, cut, cutoffs, solUsd],
  );
  // The inspector lists the links drawn, so one hidden by a slider or by hand isn't listed.
  const inspected = useMemo(() => ({ nodes: kept.nodes, edges: shown.edges }), [kept, shown]);
  const layoutKey = `${shown.nodes.length}:${shown.edges.length}:${shown.nodes.at(-1)?.id ?? ""}`;
  const selectedNode = selected ? (kept.nodes.find((n) => n.id === selected) ?? null) : null;
  // Taken off the map, newest first, with what the map knows of each.
  const hiddenNodes = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return [...removed]
      .reverse()
      .map((id) => byId.get(id))
      .filter((n): n is AsylNode => !!n);
  }, [graph, removed]);

  const unhide = (ids: Iterable<string>) => {
    const back = new Set(ids);
    if (back.size === 0) return;
    setRemoved((s) => new Set([...s].filter((id) => !back.has(id))));
    setUnhidePick((s) => new Set([...s].filter((id) => !back.has(id))));
    setDirty(true);
  };

  // The latest state, for the one key listener.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (kept.nodes.length > 0 && !busy) void run("Saving…", async () => (await save(), "Saved."));
      return;
    }
    if (typing(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      const last = [...removed].at(-1);
      if (last) unhide([last]);
      return;
    }
    if (mod || e.altKey) return;
    const sel = selectedNode;
    switch (e.key) {
      case "Delete":
      case "Backspace":
        if (!sel) return;
        e.preventDefault();
        actions.hide(sel.id);
        return;
      case "Escape":
        if (keysOpen) setKeysOpen(false);
        else setSelected(null);
        return;
      case "Enter":
        if (sel && !busy) actions.expand(sel);
        return;
      case "?":
        setKeysOpen((o) => !o);
        return;
      case "/":
        e.preventDefault();
        searchBox.current?.focus();
        return;
    }
    switch (e.key.toLowerCase()) {
      case "z": {
        const last = [...removed].at(-1);
        if (last) unhide([last]);
        return;
      }
      case "h":
        setRail("map");
        setRailOpen(true);
        return;
      case "n": {
        const ids = shown.nodes.map((n) => n.id);
        if (ids.length === 0) return;
        const at = sel ? ids.indexOf(sel.id) : -1;
        const next = e.shiftKey ? (at <= 0 ? ids.length - 1 : at - 1) : (at + 1) % ids.length;
        setSelected(ids[next]!);
        return;
      }
      case "f":
        view.current?.fit();
        return;
      case "s":
        if (sel?.kind === "wallet" && !busy) actions.similar(sel.id);
        return;
      case "l":
        if (!busy) void linksAmong();
        return;
      case "d":
        if (!busy) void linksAmong(undefined, undefined, true);
        return;
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (parseRoute(location.pathname).kind === "shared") return null;
  if (session === "loading") return <div className="asyl-loading">ASYL</div>;
  if (session === "down")
    return (
      <div className="asyl-gate">
        <div className="asyl-gate-card">
          <h1 className="asyl-wordmark">ASYL</h1>
          <p>TrenchScanner isn&apos;t answering right now. It&apos;s usually back within a minute.</p>
          <button
            className="asyl-btn asyl-wallet-btn"
            onClick={() => {
              setSession("loading");
              loadMe();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  if (session === "out")
    return (
      <AsylSignIn
        onSignedIn={() => {
          setSession("loading");
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
            ref={searchBox}
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
          <a className="asyl-btn ghost asyl-back" href={dashboardUrl()} title="Back to TrenchScanner">
            ← TrenchScanner
          </a>
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
            {RAIL_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={rail === t.id}
                className={rail === t.id ? "on" : ""}
                onClick={() => setRail(t.id)}
              >
                {t.label}
                {t.id === "links" && (cut.size > 0 || Object.values(cutoffs).some((v) => v > 0)) && (
                  <span className="asyl-tab-dot" aria-label="filters on" />
                )}
              </button>
            ))}
          </div>
          {rail === "links" && (
            <div className="asyl-rail-body">
              <LinkFilters
                graph={kept}
                hiddenKinds={hiddenKinds}
                onToggleKind={(k) =>
                  setHiddenKinds((s) => {
                    const n = new Set(s);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
                cutoffs={cutoffs}
                onCutoffs={setCutoffs}
                solUsd={solUsd}
                cut={cut}
                onRestore={(keys) => {
                  setCut((s) => new Set([...s].filter((k) => !keys.includes(k))));
                  setDirty(true);
                }}
              />
            </div>
          )}
          {rail === "map" && (
            <div className="asyl-rail-body">
              <section className="asyl-rail-card">
                <h3>This map</h3>
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
                <div className="asyl-stats">
                  <span>
                    <b>{shown.nodes.filter((n) => n.kind === "wallet").length}</b> wallets
                  </span>
                  <span>
                    <b>{shown.nodes.filter((n) => n.kind === "token").length}</b> coins
                  </span>
                  <span>
                    <b>{shown.edges.length}</b> links
                  </span>
                </div>
                {kept.edges.length > shown.edges.length && (
                  <button className="asyl-link asyl-small" onClick={() => setRail("links")}>
                    {kept.edges.length - shown.edges.length} links filtered out · Links
                  </button>
                )}
              </section>
              <section className="asyl-rail-card">
                <h3>Reading the map</h3>
                <p className="asyl-muted asyl-small">
                  Lines with a ringed dot come from the chain; the rest from TrenchScanner&apos;s reads of the
                  last 30 days. Colours group wallets tied by funding or transfers. Rings: white your label,
                  gold KOL, red risky, green winner. A gold D marks a deployer. Drag a bubble and the wallets
                  hanging off it come along; hold Shift to move it alone.
                </p>
              </section>
              {hiddenNodes.length > 0 && (
                <section className="asyl-rail-card">
                  <h3>Taken off ({hiddenNodes.length})</h3>
                  <ul className="asyl-hidden-list">
                    {hiddenNodes.map((n) => (
                      <li key={n.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={unhidePick.has(n.id)}
                            onChange={() =>
                              setUnhidePick((s) => {
                                const next = new Set(s);
                                if (next.has(n.id)) next.delete(n.id);
                                else next.add(n.id);
                                return next;
                              })
                            }
                          />
                          {nodeName(n)}
                          <span className="asyl-muted">{n.kind === "token" ? "coin" : "wallet"}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="asyl-actions">
                    <button
                      className="asyl-btn"
                      disabled={unhidePick.size === 0}
                      onClick={() => unhide(unhidePick)}
                    >
                      Bring back {unhidePick.size || ""}
                    </button>
                    <button className="asyl-link" onClick={() => unhide(removed)}>
                      Bring back all
                    </button>
                  </div>
                </section>
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
            <button className="asyl-btn ghost" disabled={kept.edges.length === 0} onClick={exportCsv}>
              CSV
            </button>
            <button
              className="asyl-btn ghost"
              disabled={!!busy || !shown.nodes.some((n) => n.kind === "wallet")}
              title="Funding, transfers, deploys and trades between the wallets and coins shown, from TrenchScanner's reads (no credits). Key: L"
              onClick={() => void linksAmong()}
            >
              Links between shown
            </button>
            <button
              className="asyl-btn ghost"
              disabled={!!busy || !shown.nodes.some((n) => n.kind === "token")}
              title="Adds the wallet that deployed each coin shown, with its Deployed line (no credits). Key: D"
              onClick={() => void linksAmong(undefined, undefined, true)}
            >
              Deployers
            </button>
            <button
              className="asyl-btn ghost"
              aria-expanded={keysOpen}
              title="Keyboard shortcuts (?)"
              onClick={() => setKeysOpen((o) => !o)}
            >
              ⌨
            </button>
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
          {shown.edges.length > 0 && <MapLegend graph={shown} />}

          {keysOpen && (
            <div className="asyl-keys" role="dialog" aria-label="Keyboard shortcuts">
              <h3>
                Keys
                <button className="asyl-icon-btn" onClick={() => setKeysOpen(false)} aria-label="Close">
                  ×
                </button>
              </h3>
              <dl>
                {KEYS.map(([k, what]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
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
            graph={inspected}
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
