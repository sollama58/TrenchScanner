import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SESSION_ENDED_EVENT, post } from "../api";
import { dashboardUrl } from "../returnTo";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { asylApi, type AsylMe, type ChainRead, type Label, type MapDoc, type MapSummary } from "./asylApi";
import { renderMapCard } from "./asylCard";
import { renderAnalystCard } from "./analystCard";
import { AnalystLegend } from "./AnalystLayer";
import { AsylSignIn } from "./AsylSignIn";
import { DrawEditor, PenBar } from "./DrawEditor";
import { PairPanel } from "./PairPanel";
import { PickBar, type PickSwitch, type Share } from "./PickBar";
import { SearchBox } from "./SearchBox";
import {
  GraphView,
  MapLegend,
  type DrawHandlers,
  type DrawTool,
  type GraphViewHandle,
  type Pen,
  type PickMode,
} from "./GraphView";
import {
  EDGE_KINDS,
  EDGE_LABEL,
  DEFAULT_TIME_LABELS,
  DRAW_COLOURS,
  NO_CUTOFFS,
  NO_DRAWINGS,
  PEN_WIDTHS,
  STROKES_MAX,
  TIMED_KINDS,
  addressIn,
  clearsCutoffs,
  cleanCutoffs,
  cleanDrawings,
  edgeKey,
  perWalletOf,
  graphCsv,
  mergeGraph,
  nodeName,
  removeNodes,
  shortAddr,
  visibleGraph,
  withDeployLines,
  type AsylEdgeKind,
  type WalletSwitch,
  type AsylGraph,
  type AsylNode,
  type Cutoffs,
  type Drawings,
  type TimeLabels,
  newDrawingId,
  thinStroke,
} from "./graph";
import { History, HISTORY_MAX } from "./history";
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

/** The most coins the pick bar reads at once (two reads each, inside the API's 60 a minute)... */
const PICK_COINS_MAX = 25;
/** ...and the most it reads live from the chain (12 chain reads a minute, ~130 credits each). */
const PICK_LIVE_MAX = 10;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the links read takes from the map: as many wallets and coins as the API allows. */
const LINKS_WALLETS = 400;
const LINKS_TOKENS = 200;

/** Keyboard shortcuts (user ask 2026-10-24), as the help card lists them. */
const KEYS: [string, string][] = [
  ["Del", "Take the selected or picked bubbles off the map"],
  ["B", "Pick bubbles with a box"],
  ["O", "Pick bubbles with a lasso"],
  ["Shift+drag", "Box-pick from the background; Shift adds to the pick"],
  ["Ctrl+click", "Add a bubble to the pick, or take it out"],
  ["Ctrl+A", "Pick everything shown"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
  ["Z", "Bring back the last one taken off"],
  ["H", "List what is taken off, to bring back"],
  ["N / Shift+N", "Select the next / previous one on the map"],
  ["Enter", "Expand the selected one's links"],
  ["S", "Wallets that trade like the selected one"],
  ["L", "Links between everything shown"],
  ["D", "Deployers of the coins shown"],
  ["F", "Fit the map to the screen"],
  ["A", "Analyst Mode: the map as a flowchart of boxes, amounts and right-angled lines"],
  ["P", "Draw freehand with the pen"],
  ["T", "Trades of the selected wallet and its closest co-trader"],
  ["/", "Search"],
  ["Ctrl+S", "Save the map"],
  ["Esc", "Let the pick go, then clear the selection"],
  ["?", "Show or hide these keys"],
];

const ANALYST_KEY = "asyl:analyst";

/** The amount sliders are the reader's own: kept in this browser between maps. */
const CUTOFFS_KEY = "asyl:cutoffs";

function storedCutoffs(): Cutoffs {
  try {
    return cleanCutoffs(JSON.parse(localStorage.getItem(CUTOFFS_KEY) ?? "null"));
  } catch {
    return NO_CUTOFFS;
  }
}

/** The map as one undo step keeps it: what is on it, what is hidden, and where each bubble sits. */
interface MapSnapshot {
  graph: AsylGraph;
  removed: ReadonlySet<string>;
  cut: ReadonlySet<string>;
  hiddenKinds: ReadonlySet<AsylEdgeKind>;
  drawings: Drawings;
  grid: boolean;
  pos: Map<string, { x: number; y: number }>;
  pinned: Set<string>;
}

/** Times along lines: also the reader's own, kept in this browser. */
const TIMES_KEY = "asyl:line-times";

function storedTimeLabels(): TimeLabels {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMES_KEY) ?? "null") as Partial<TimeLabels> | null;
    const out = { ...DEFAULT_TIME_LABELS };
    if (raw && typeof raw === "object")
      for (const k of TIMED_KINDS) if (typeof raw[k] === "boolean") out[k] = raw[k];
    return out;
  } catch {
    return DEFAULT_TIME_LABELS;
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
  // Kinds of link off for one wallet only, and whether bubbles no link reaches leave the map
  // (user asks 2026-10-25: off by default, so a bubble leaves only when the reader takes it off).
  const [walletHidden, setWalletHidden] = useState<Record<string, WalletSwitch[]>>({});
  const [hideLoose, setHideLoose] = useState(false);
  const perWallet = useMemo(() => perWalletOf(walletHidden), [walletHidden]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [cut, setCut] = useState<Set<string>>(new Set());
  const [cutoffs, setCutoffsState] = useState<Cutoffs>(storedCutoffs);
  const [timeLabels, setTimeLabelsState] = useState<TimeLabels>(storedTimeLabels);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [mapNote, setMapNote] = useState("");
  const [current, setCurrent] = useState<MapSummary | null>(null);
  const [title, setTitle] = useState("Untitled map");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  // A question before a big read (user ask 2026-10-25: more than 20 co-traders loads on a yes).
  const [ask, setAsk] = useState<{
    text: string;
    choices: { label: string; primary?: boolean; run: () => void }[];
  } | null>(null);
  // How many co-traders each wallet has in all, for the panel's "Load all".
  const [coTraderTotals, setCoTraderTotals] = useState<Record<string, number>>({});
  // The bought-together pair whose trades are open (user ask 2026-10-25).
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<Label[]>([]);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [rail, setRail] = useState<RailTab>("map");
  const [railOpen, setRailOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [unhidePick, setUnhidePick] = useState<Set<string>>(new Set());
  // Bubbles picked together by a box, a lasso or Ctrl-click (user ask 2026-10-25).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The reader's own lines and text boxes (user ask 2026-10-24), the tool in hand, and the one picked.
  const [drawings, setDrawings] = useState<Drawings>(NO_DRAWINGS);
  const [tool, setTool] = useState<DrawTool>(null);
  // Grid mode (user ask 2026-10-24): off for every new map (user ask 2026-10-25); a saved map keeps its own choice.
  const [grid, setGrid] = useState(false);
  // Analyst Mode (user ask 2026-10-26): the map as an investigator's flowchart. The reader's own
  // choice, kept in this browser; a saved map opens the way it was saved.
  const [analyst, setAnalystState] = useState(() => {
    try {
      return localStorage.getItem(ANALYST_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setAnalyst = (on: boolean) => {
    setAnalystState(on);
    try {
      localStorage.setItem(ANALYST_KEY, on ? "1" : "0");
    } catch {
      // Storage blocked: it holds for this visit.
    }
  };
  // Bumped when a map is opened or started, so the view lays it out from scratch.
  const [epoch, setEpoch] = useState(0);
  // Counts maps opened, so a slow refresh of one doesn't land on the next.
  const openSeq = useRef(0);
  const [drawingSel, setDrawingSel] = useState<string | null>(null);
  const [cardNote, setCardNote] = useState<string | null>(null);
  const view = useRef<GraphViewHandle>(null);
  // Undo and redo (user ask 2026-10-24). Notes and the title keep their own text-box undo.
  const history = useRef(new History<MapSnapshot>(HISTORY_MAX));
  const [, setHistoryTick] = useState(0);
  const latest = useRef({ graph, removed, cut, hiddenKinds, drawings, grid });
  latest.current = { graph, removed, cut, hiddenKinds, drawings, grid };
  const searchBox = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const me = typeof session === "object" ? session : null;
  const solUsd = me?.solUsd ?? null;
  // What Show holders keeps (user ask 2026-10-25): the reader's own cutoffs from Links, the least
  // share held for holders now, the least SOL (or its USD) for past ones, 0.1 SOL when none is set.
  const holderRule = useMemo(() => {
    const fromUsd = cutoffs.usd > 0 && solUsd ? cutoffs.usd / solUsd : 0;
    const minSol = Math.max(cutoffs.sol, fromUsd);
    return { minPct: cutoffs.pct, minSol: minSol > 0 ? Number(minSol.toPrecision(3)) : 0.1 };
  }, [cutoffs, solUsd]);

  const setTimeLabels = (t: TimeLabels) => {
    setTimeLabelsState(t);
    try {
      localStorage.setItem(TIMES_KEY, JSON.stringify(t));
    } catch {
      // Storage blocked: the switches hold for this visit.
    }
  };

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

  const snapshot = useCallback((): MapSnapshot => {
    const l = latest.current;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [id, p] of layout.current.pos) pos.set(id, { x: p.x, y: p.y });
    return { ...l, pos, pinned: new Set(layout.current.pinned) };
  }, []);

  /** Keeps the map as it is now, as the step an undo goes back to. Call just before a change. */
  const record = useCallback(() => {
    history.current.record(snapshot());
    setHistoryTick((t) => t + 1);
  }, [snapshot]);

  const restore = (s: MapSnapshot) => {
    setGraph(s.graph);
    setRemoved(new Set(s.removed));
    setCut(new Set(s.cut));
    setHiddenKinds(new Set(s.hiddenKinds));
    setDrawings(s.drawings);
    setGrid(s.grid);
    if (
      drawingSel &&
      !s.drawings.lines.some((l) => l.id === drawingSel) &&
      !s.drawings.texts.some((t) => t.id === drawingSel) &&
      !s.drawings.strokes.some((t) => t.id === drawingSel)
    )
      setDrawingSel(null);
    const lay = layout.current;
    for (const [id, p] of s.pos) {
      lay.pos.set(id, { x: p.x, y: p.y });
      lay.vel.set(id, { x: 0, y: 0 });
    }
    lay.pinned = new Set(s.pinned);
    if (selected && !s.graph.nodes.some((n) => n.id === selected)) setSelected(null);
    setDirty(true);
    setHistoryTick((t) => t + 1);
    view.current?.redraw();
  };

  const undo = () => {
    const s = history.current.undo(snapshot());
    if (s) restore(s);
  };
  const redo = () => {
    const s = history.current.redo(snapshot());
    if (s) restore(s);
  };

  /**
   * Adds an answer to the map. What the reader took off stays in it, out of view (`removed`), so
   * it can be brought back.
   */
  const add = useCallback(
    (next: AsylGraph) => {
      record();
      setGraph((g) => withDeployLines(mergeGraph(g, next)));
      setDirty(true);
    },
    [record],
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
      ? `${what}: already read recently, no credits used.`
      : `${what}: ${r.credits} credit${r.credits === 1 ? "" : "s"} used.`;
  };

  /**
   * After a read joins the map: the first read makes the map's focus and its address; later ones are
   * added to the map as it is (user ask 2026-10-25: adding must not look like opening a new map),
   * picked, and brought into view, with what they added said.
   */
  const placed = useCallback(
    (id: string, kind: "wallet" | "token", read: AsylGraph, before: AsylGraph): string | null => {
      setSelected(id);
      if (before.nodes.length === 0) {
        setFocus(id);
        if (!current) go({ kind, address: id });
        return null;
      }
      const had = new Set(before.nodes.map((n) => n.id));
      const known = new Set(before.edges.map(edgeKey));
      const bubbles = read.nodes.filter((n) => !had.has(n.id)).length;
      const links = read.edges.filter((e) => !known.has(edgeKey(e))).length;
      // Once the layout has placed it, bring it into view.
      setTimeout(() => view.current?.centre(id), had.has(id) ? 50 : 900);
      const name = nodeName(read.nodes.find((n) => n.id === id) ?? ({ id, name: null } as AsylNode));
      return bubbles || links
        ? `Added to this map: ${name}, with ${bubbles} new bubble${bubbles === 1 ? "" : "s"} and ${links} new link${links === 1 ? "" : "s"}.`
        : `${name} is on this map already, with every link it has here.`;
    },
    [current],
  );

  const openWallet = useCallback(
    (wallet: string) =>
      run("Mapping the wallet…", async () => {
        const before = latest.current.graph;
        const r = await asylApi.wallet(wallet);
        add(r.graph);
        if (r.coTradersTotal !== undefined) setCoTraderTotals((t) => ({ ...t, [wallet]: r.coTradersTotal! }));
        const addedNote = placed(wallet, "wallet", r.graph, before);
        const note = [addedNote, r.coverage?.note].filter(Boolean).join(" ");
        // A wallet TrenchScanner never saw has nothing stored to draw: read it from the chain
        // instead, its transfers and its funder (user ask 2026-10-25), when Pro Mode allows.
        if (!r.coverage || r.coverage.seen > 0 || !r.coverage.chainAvailable) return note;
        try {
          const flows = await asylApi.flows(wallet);
          add(flows.graph);
          const funders = await asylApi.funders([wallet]).catch(() => null);
          if (funders) add(funders.graph);
          const last = funders ?? flows;
          setSession((s) => (typeof s === "object" ? { ...s, chain: last.allowance } : s));
          const credits = flows.credits + (funders?.credits ?? 0);
          return `${note} ${flows.flows?.txs ?? 0} transactions read${
            funders ? (funders.found ? ", funder found" : ", no funder found") : ""
          }; ${credits ? `${credits} credit${credits === 1 ? "" : "s"} used` : "no credits used"}.`;
        } catch (e) {
          return `${note} The chain read didn't work: ${errorText(e)}`;
        }
      }),
    [add, run, placed],
  );

  const openToken = useCallback(
    (mint: string) =>
      run("Mapping the holders…", async () => {
        const before = latest.current.graph;
        const r = await asylApi.token(mint);
        add(r.graph);
        return [placed(mint, "token", r.graph, before), r.coverage?.note].filter(Boolean).join(" ");
      }),
    [add, run, placed],
  );

  const search = (text: string) => {
    const a = addressIn(text);
    if (!a) {
      setStatus({
        text: "Pick a coin or wallet from the list, or paste a Solana address, or a Solscan, DexScreener or pump.fun link.",
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
        layout.current.pinned = new Set((m.doc.pinned ?? []).filter((nid) => nid in m.doc.positions));
        // Maps saved before grid mode keep the layout they were saved with.
        setGrid(m.doc.grid ?? false);
        if (m.doc.analyst !== undefined) setAnalyst(m.doc.analyst);
        if (m.doc.times) setTimeLabelsState({ ...DEFAULT_TIME_LABELS, ...m.doc.times });
        setEpoch((n) => n + 1);
        setGraph(withDeployLines(mergeGraph(EMPTY, { nodes: m.doc.nodes, edges: m.doc.edges })));
        setNotes(m.doc.notes);
        setMapNote(m.doc.note);
        setRemoved(new Set(m.doc.removed ?? []));
        setPicked(new Set());
        setCut(new Set(m.doc.cut ?? []));
        setDrawings(cleanDrawings(m.doc.drawings));
        setDrawingSel(null);
        if (m.doc.cutoffs) setCutoffs(cleanCutoffs(m.doc.cutoffs));
        setHiddenKinds(new Set(EDGE_KINDS.filter((k) => m.doc.hidden.includes(k))));
        setWalletHidden(
          Object.fromEntries([...perWalletOf(m.doc.walletHidden)].map(([w, k]) => [w, [...k]])),
        );
        setHideLoose(m.doc.hideLoose ?? false);
        setFocus(m.doc.focus);
        setSelected(null);
        setTitle(m.title);
        setCurrent(m);
        setDirty(false);
        history.current.clear();
        setHistoryTick((t) => t + 1);
        go({ kind: "map", id });
        // A saved map keeps its wallets and coins; what TrenchScanner knows of them moves on. So its
        // names, tags and market caps, and the stored links among them, are read again as it opens
        // (database only, no credits). Nothing new joins the map; a map opened since is left alone.
        const seq = ++openSeq.current;
        const ids = new Set(m.doc.nodes.map((n) => n.id));
        const of = (kind: "wallet" | "token") => m.doc.nodes.filter((n) => n.kind === kind).map((n) => n.id);
        void asylApi
          .links(of("wallet").slice(0, LINKS_WALLETS), of("token").slice(0, LINKS_TOKENS))
          .then((r) => {
            if (seq !== openSeq.current) return;
            const fresh = {
              nodes: r.graph.nodes.filter((n) => ids.has(n.id)),
              edges: r.graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
            };
            setGraph((g) => withDeployLines(mergeGraph(g, fresh)));
          })
          .catch(() => undefined);
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
    openSeq.current += 1;
    setGrid(false);
    setEpoch((n) => n + 1);
    setGraph(EMPTY);
    setNotes({});
    setMapNote("");
    setRemoved(new Set());
    setPicked(new Set());
    setCut(new Set());
    setWalletHidden({});
    setDrawings(NO_DRAWINGS);
    setDrawingSel(null);
    setTool(null);
    setFocus(null);
    setSelected(null);
    setCurrent(null);
    setTitle("Untitled map");
    setDirty(false);
    setStatus(null);
    history.current.clear();
    setHistoryTick((t) => t + 1);
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
        (small ? ` ${small} under your cutoffs in Links ${small === 1 ? "is" : "are"} hidden.` : "");
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
      walletHidden: Object.fromEntries(
        Object.entries(walletHidden).filter(([w, k]) => k.length && graph.nodes.some((n) => n.id === w)),
      ),
      hideLoose,
      removed: [...removed].filter((id) => graph.nodes.some((n) => n.id === id)),
      cut: [...cut].filter((k) => graph.edges.some((e) => edgeKey(e) === k)),
      cutoffs,
      pinned: [...layout.current.pinned].filter((id) => id in positions),
      grid,
      analyst,
      times: timeLabels,
      drawings: {
        lines: drawings.lines.filter(
          (l) => graph.nodes.some((n) => n.id === l.a) && graph.nodes.some((n) => n.id === l.b),
        ),
        texts: drawings.texts,
        strokes: drawings.strokes,
      },
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

  /**
   * Holders now and before, as the cutoffs keep them, for one coin or for every coin picked (user
   * ask 2026-10-26: the coin actions on many coins at once). Coins are read one after another, so
   * a long pick keeps inside the API's rate limits, and the map takes them all as one undo step.
   */
  const coinName = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? nodeName(n) : shortAddr(id);
  };

  const showHolders = (mints: string[], live: boolean) => {
    if (mints.length === 0) return;
    if (mints.length > PICK_COINS_MAX)
      return setStatus({
        tone: "error",
        text: `Pick ${PICK_COINS_MAX} coins or fewer to show their holders together; ${mints.length} are picked.`,
      });
    if (live && mints.length > PICK_LIVE_MAX)
      return setStatus({
        tone: "error",
        text: `Live reads go up to ${PICK_LIVE_MAX} coins at once; ${mints.length} are picked. Untick Live from the chain for TrenchScanner's own lists, or pick fewer.`,
      });
    const go = () =>
      void run(
        mints.length > 1
          ? `Reading the holders of ${mints.length} coins…`
          : live
            ? "Reading its holders from the chain…"
            : "Reading its holders…",
        async () => {
          const { minPct, minSol } = holderRule;
          const one = mints.length === 1;
          const said: string[] = [];
          let read: AsylGraph = { nodes: [], edges: [] };
          const more: { mint: string; r: Awaited<ReturnType<typeof asylApi.pastHolders>> }[] = [];
          let heldNow = 0;
          let pastDrawn = 0;
          let credits = 0;
          const failed: string[] = [];
          for (const mint of mints) {
            // Holders now (the stored list, or the chain's) and in the past, both as the cutoffs keep them.
            const [now, past] = await Promise.allSettled([
              live ? asylApi.chainToken(mint, { minPct }) : asylApi.token(mint, { minPct, all: true }),
              asylApi.pastHolders(mint, { minSol }),
            ]);
            if (now.status === "fulfilled") {
              const r = now.value;
              read = mergeGraph(read, r.graph);
              const held = r.graph.edges.filter((e) => e.kind === "holds" && e.b === mint).map((e) => e.a);
              heldNow += held.length;
              if ("credits" in r) {
                const c = r as ChainRead;
                setSession((s) => (typeof s === "object" ? { ...s, chain: c.allowance } : s));
                if (!c.cached) credits += c.credits;
                if (one)
                  said.push(
                    `${held.length} hold${held.length === 1 ? "s" : ""} it now${minPct > 0 ? ` with ${minPct}% or more` : ""}, read live.`,
                  );
                // The live list replaces the stored one: a wallet that has sold since doesn't still hold.
                const liveSet = new Set(held);
                if (liveSet.size > 0)
                  setGraph((g) => ({
                    ...g,
                    edges: g.edges.filter((e) => !(e.kind === "holds" && e.b === mint && !liveSet.has(e.a))),
                  }));
              } else if (one && "coverage" in r && r.coverage?.note) said.push(r.coverage.note);
            } else failed.push(`${coinName(mint)} now: ${errorText(now.reason)}`);
            if (past.status === "fulfilled") {
              // With more than the map draws at once, the ask below says how many before any are added.
              if (past.value.total > past.value.shown) more.push({ mint, r: past.value });
              else {
                read = mergeGraph(read, past.value.graph);
                pastDrawn += past.value.shown;
                if (one) said.push(past.value.note);
              }
            } else failed.push(`${coinName(mint)} before: ${errorText(past.reason)}`);
          }
          if (!one)
            said.push(
              `Holders of ${mints.length} coins: ${heldNow} holding now${minPct > 0 ? ` with ${minPct}% or more` : ""}, and ${pastDrawn} past holders who put in ${minSol} SOL or more.`,
            );
          if (live)
            said.push(credits ? `${credits} credits used.` : "Already read recently, no credits used.");
          if (failed.length) said.push(`Didn't load: ${failed.join("; ")}.`);
          const before = latest.current.graph;
          if (read.nodes.length) {
            add(read);
            if (one) placed(mints[0]!, "token", read, before);
          }
          if (more.length) {
            // More past holders than the map draws at once: the reader says whether it takes them all.
            const total = more.reduce((n, m) => n + m.r.total, 0);
            const shown = more.reduce((n, m) => n + m.r.shown, 0);
            setAsk({
              text: `${total} wallets put ${minSol} SOL or more into ${one ? "this coin" : `${more.length} of these coins`}. Loading all of them adds up to ${total} bubbles to the map, which has ${graph.nodes.length} now. A map that big can be slow and hard to read.`,
              choices: [
                {
                  label: `Load all ${total}`,
                  primary: true,
                  run: () =>
                    void run(`Loading all ${total} past holders…`, async () => {
                      let g: AsylGraph = { nodes: [], edges: [] };
                      const notes: string[] = [];
                      for (const m of more) {
                        const all = await asylApi.pastHolders(m.mint, { minSol, all: true });
                        g = mergeGraph(g, all.graph);
                        notes.push(all.note);
                      }
                      add(g);
                      return one ? notes[0] : `Added all ${total} past holders of ${more.length} coins.`;
                    }),
                },
                {
                  label: one ? `Just the top ${shown}` : `Just the top of each (${shown})`,
                  run: () => {
                    add(
                      more.reduce((g, m) => mergeGraph(g, m.r.graph), { nodes: [], edges: [] } as AsylGraph),
                    );
                    setStatus({
                      text: one
                        ? more[0]!.r.note
                        : `Added the ${shown} past holders who put in most, of ${total}.`,
                      tone: "info",
                    });
                  },
                },
                { label: "Cancel", run: () => undefined },
              ],
            });
          }
          return said.join(" ");
        },
      );
    // Live reads of many coins cost credits each: the reader says yes first.
    if (live && mints.length > 1)
      return setAsk({
        text: `Reading ${mints.length} coins' holders live from the chain costs up to ${mints.length * 130} credits (coins read in the last few minutes are free).`,
        choices: [
          { label: "Read them live", primary: true, run: go },
          { label: "Cancel", run: () => undefined },
        ],
      });
    go();
  };

  /** Each picked coin's deployer, one after another, as Show deployer finds one. */
  const showDeployers = (mints: string[]) => {
    if (mints.length === 0) return;
    if (mints.length > PICK_COINS_MAX)
      return setStatus({
        tone: "error",
        text: `Pick ${PICK_COINS_MAX} coins or fewer to find their deployers together; ${mints.length} are picked.`,
      });
    void run(`Finding who deployed ${mints.length} coins…`, async () => {
      let g: AsylGraph = { nodes: [], edges: [] };
      let found = 0;
      let verified = 0;
      let credits = 0;
      const failed: string[] = [];
      for (const mint of mints) {
        try {
          const r = await asylApi.deployer(mint);
          g = mergeGraph(g, r.graph);
          if (r.allowance) {
            const allowance = r.allowance;
            setSession((s) => (typeof s === "object" ? { ...s, chain: allowance } : s));
          }
          credits += r.credits ?? 0;
          if (r.deployer) {
            found += 1;
            if (r.deployer.verified) verified += 1;
          }
        } catch (e) {
          failed.push(`${coinName(mint)}: ${errorText(e)}`);
        }
      }
      if (g.nodes.length) add(g);
      return [
        `Found who deployed ${found} of ${mints.length} coins${found ? `, ${verified} confirmed by their create transaction` : ""}.`,
        credits ? `Read from the chain: ${credits} credits.` : "",
        failed.length ? `Didn't load: ${failed.join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    });
  };

  const actions: InspectorActions = {
    expand: (n: AsylNode) => void (n.kind === "token" ? openToken(n.id) : openWallet(n.id)),
    pair: (a, b) => setPair({ a, b }),
    similar: (wallet) =>
      void run("Finding wallets that trade like it…", async () => {
        const r = await asylApi.similar(wallet);
        const total = r.total ?? r.coTraders.length;
        setCoTraderTotals((t) => ({ ...t, [wallet]: total }));
        const said = (read: typeof r) => {
          const n = read.coTraders.length;
          const of = read.coTraders[0]?.of;
          return n
            ? `${n} wallet${n === 1 ? "" : "s"} bought 5 or more of its ${of ?? ""} latest coins within 3 minutes of it.`.replace(
                "  ",
                " ",
              )
            : "No wallet bought 5 or more of its latest coins within 3 minutes of it.";
        };
        if (total <= r.coTraders.length) {
          add(r.graph);
          return said(r);
        }
        // More than the first 20: the reader says whether the map takes them all.
        const onMap = new Set(graph.nodes.map((n) => n.id));
        setAsk({
          text: `${total} wallets bought together with this one. Loading all of them adds up to ${total} bubbles to the map${
            onMap.size ? `, which has ${onMap.size} now` : ""
          }. A map that big can be slow and hard to read.`,
          choices: [
            {
              label: `Load all ${total}`,
              primary: true,
              run: () =>
                void run(`Loading all ${total} wallets that trade like it…`, async () => {
                  const all = await asylApi.similar(wallet, true);
                  add(all.graph);
                  return said(all);
                }),
            },
            {
              label: `Just the top ${r.coTraders.length}`,
              run: () => {
                add(r.graph);
                setStatus({
                  text: `${said(r)} These are the ${r.coTraders.length} with the most coins in common, of ${total}.`,
                  tone: "info",
                });
              },
            },
            { label: "Cancel", run: () => undefined },
          ],
        });
      }),
    flows: (wallet) =>
      void run("Reading its transfers from the chain…", async () => {
        const r = await asylApi.flows(wallet);
        return afterChain(r, `${r.flows?.txs ?? 0} transactions read`);
      }),
    funders: (wallets) =>
      void run("Finding funders on the chain…", async () => {
        const r = await asylApi.funders(wallets);
        // Counted off the answer's lines, so a funder already known counts as found too.
        const funded = new Set(r.graph.edges.filter((e) => e.kind === "funded").map((e) => e.b));
        const found = wallets.filter((w) => funded.has(w)).length;
        const said = (w: string) => (funded.has(w) ? "found" : (r.results?.[w] ?? "none"));
        const counts = wallets.map(said);
        const failed = counts.filter((c) => c === "failed").length;
        const busyN = counts.filter((c) => c === "busy").length;
        if (wallets.length === 1) {
          const one = counts[0];
          return afterChain(
            r,
            one === "found"
              ? "Funder found"
              : one === "failed"
                ? "The chain read didn't come back, so its funder isn't known yet. Try again in a moment"
                : one === "busy"
                  ? "Too many transactions to reach its first: most likely an exchange or service"
                  : one === "empty"
                    ? "No funder: it has no transactions yet"
                    : "No funder found: nothing paid it SOL in its first transactions (it may have been funded by a swap or a program)",
          );
        }
        return afterChain(
          r,
          `${found} of ${wallets.length} funders found` +
            (failed ? `; ${failed} read${failed === 1 ? "" : "s"} failed, try again` : "") +
            (busyN ? `; ${busyN} too busy to read` : ""),
        );
      }),
    trace: (wallet) =>
      void run("Tracing its funders back…", async () => {
        const r = await asylApi.trace(wallet);
        add(r.graph);
        setSession((s) => (typeof s === "object" ? { ...s, chain: r.allowance } : s));
        const end = r.trace.path[r.trace.path.length - 1];
        if (end && end !== wallet) setSelected(end);
        const spent = r.cached
          ? "No credits used."
          : `${r.credits} credit${r.credits === 1 ? "" : "s"} used.`;
        return `${r.note} ${spent}`;
      }),
    holders: (mint, live) => showHolders([mint], live),
    hide: (id) => {
      record();
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
      record();
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
    () => visibleGraph(kept, hiddenKinds, keep, { cut, cutoffs, solUsd, perWallet, hideLoose }),
    [kept, hiddenKinds, keep, cut, cutoffs, solUsd, perWallet, hideLoose],
  );
  // The inspector lists the links drawn, so one hidden by a slider or by hand isn't listed.
  const inspected = useMemo(() => ({ nodes: kept.nodes, edges: shown.edges }), [kept, shown]);
  const layoutKey = `${shown.nodes.length}:${shown.edges.length}:${shown.nodes.at(-1)?.id ?? ""}`;
  const selectedNode = selected ? (kept.nodes.find((n) => n.id === selected) ?? null) : null;
  // The selected bubble's own links on the map by kind, before any filter, for its own switches.
  const ownLinks = useMemo(() => {
    const m = new Map<WalletSwitch, number>();
    const bump = (k: WalletSwitch) => m.set(k, (m.get(k) ?? 0) + 1);
    if (selected)
      for (const e of kept.edges) {
        if (e.a !== selected && e.b !== selected) continue;
        // Transfers count by direction, which its panel switches apart.
        if (e.kind === "transfer") bump(e.a === selected ? "transfer:out" : "transfer:in");
        else bump(e.kind);
      }
    return m;
  }, [kept, selected]);
  // Taken off the map, newest first, with what the map knows of each.
  const hiddenNodes = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return [...removed]
      .reverse()
      .map((id) => byId.get(id))
      .filter((n): n is AsylNode => !!n);
  }, [graph, removed]);

  // The pick, as far as it is on the map now: a bubble taken off or filtered away drops out of it.
  const pickedShown = useMemo(() => {
    const on = new Set(shown.nodes.map((n) => n.id));
    return new Set([...picked].filter((id) => on.has(id)));
  }, [picked, shown]);
  const onPick = (ids: string[], mode: PickMode) => {
    setPicked((p) => (mode === "add" ? new Set([...p, ...ids]) : new Set(ids)));
    // The pick bar takes over from the one bubble's panel, which on a phone would cover it.
    if (ids.length) {
      setDrawingSel(null);
      setSelected(null);
    }
  };
  /** Takes these bubbles off the map, as one undo step. */
  const hideMany = (ids: readonly string[], what: string) => {
    if (ids.length === 0) return;
    record();
    setRemoved((s) => {
      const n = new Set([...s].filter((id) => !ids.includes(id)));
      for (const id of ids) n.add(id);
      return n;
    });
    if (selected && ids.includes(selected)) setSelected(null);
    setDirty(true);
    setStatus({ tone: "info", text: `${what} Undo brings them back.` });
  };
  // What the pick bar shows: how many of each, their own link switches, and whether they hold.
  const pickInfo = useMemo(() => {
    const ids = [...pickedShown];
    const kindOf = new Map(kept.nodes.map((n) => [n.id, n.kind]));
    const wallets = ids.filter((id) => kindOf.get(id) === "wallet");
    const count = new Map<WalletSwitch, number>();
    const has = new Map<WalletSwitch, Set<string>>();
    const mine = new Set(wallets);
    for (const e of kept.edges)
      for (const w of [e.a, e.b]) {
        if (!mine.has(w)) continue;
        const k: WalletSwitch = e.kind === "transfer" ? (e.a === w ? "transfer:out" : "transfer:in") : e.kind;
        count.set(k, (count.get(k) ?? 0) + 1);
        if (!has.has(k)) has.set(k, new Set());
        has.get(k)!.add(w);
      }
    const share = (n: number, of: number): Share => (n === 0 ? "none" : n === of ? "all" : "some");
    const switches: PickSwitch[] = [...count].map(([kind, c]) => {
      const ws = [...has.get(kind)!];
      return { kind, count: c, off: share(ws.filter((w) => perWallet.get(w)?.has(kind)).length, ws.length) };
    });
    return { ids, wallets, tokens: ids.filter((id) => kindOf.get(id) === "token"), switches, has };
  }, [pickedShown, kept, perWallet]);
  const pickPinned: Share = (() => {
    const n = pickInfo.ids.filter((id) => layout.current.pinned.has(id)).length;
    return n === 0 ? "none" : n === pickInfo.ids.length ? "all" : "some";
  })();
  const pickActions = {
    hide: () => {
      const n = pickInfo.ids.length;
      hideMany(pickInfo.ids, `Took ${n} off the map.`);
      setPicked(new Set());
    },
    keepOnly: () => {
      const others = shown.nodes.map((n) => n.id).filter((id) => !pickedShown.has(id));
      hideMany(others, `Took off the ${others.length} not picked.`);
    },
    pin: (hold: boolean) => {
      record();
      for (const id of pickInfo.ids) {
        if (hold) layout.current.pinned.add(id);
        else layout.current.pinned.delete(id);
      }
      setDirty(true);
      view.current?.redraw();
    },
    linksAmong: () => void linksAmong(pickInfo.wallets, pickInfo.tokens),
    grow: () => {
      const more = new Set(pickedShown);
      for (const e of shown.edges) {
        if (pickedShown.has(e.a)) more.add(e.b);
        if (pickedShown.has(e.b)) more.add(e.a);
      }
      setPicked(more);
    },
    switchKind: (k: WalletSwitch, on: boolean) => {
      const ws = pickInfo.has.get(k) ?? new Set<string>();
      setWalletHidden((m) => {
        const out = { ...m };
        for (const w of ws) {
          const was = out[w] ?? [];
          const next = on ? was.filter((x) => x !== k) : was.includes(k) ? was : [...was, k];
          if (next.length) out[w] = next;
          else delete out[w];
        }
        return out;
      });
      setDirty(true);
    },
  };

  const unhide = (ids: Iterable<string>) => {
    const back = new Set(ids);
    if (back.size === 0) return;
    record();
    setRemoved((s) => new Set([...s].filter((id) => !back.has(id))));
    setUnhidePick((s) => new Set([...s].filter((id) => !back.has(id))));
    setDirty(true);
  };

  /** Drawing on the map: each change is an undo step. */
  const drawColour = useRef<string>(DRAW_COLOURS[0]);
  // The pen (user ask 2026-10-25): its colour and thickness, kept for the next stroke.
  const [pen, setPen] = useState<Pen>({ colour: DRAW_COLOURS[1], width: PEN_WIDTHS[1] });
  const draw: DrawHandlers = {
    addLine: (a, b) => {
      record();
      const id = newDrawingId();
      setDrawings((d) => ({
        ...d,
        lines: [...d.lines, { id, a, b, label: "", colour: drawColour.current }],
      }));
      setDrawingSel(id);
      setDirty(true);
    },
    addText: (x, y) => {
      record();
      const id = newDrawingId();
      setDrawings((d) => ({ ...d, texts: [...d.texts, { id, x, y, text: "", colour: drawColour.current }] }));
      setDrawingSel(id);
      setTool(null);
      setDirty(true);
    },
    addStroke: (points, width) => {
      if (drawings.strokes.length >= STROKES_MAX) {
        setStatus({
          tone: "info",
          text: `A map keeps up to ${STROKES_MAX} pen strokes. Delete some to draw more.`,
        });
        return;
      }
      record();
      const id = newDrawingId();
      const kept = thinStroke(points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
      setDrawings((d) => ({
        ...d,
        strokes: [...d.strokes, { id, points: kept, colour: pen.colour, width }],
      }));
      setDirty(true);
    },
    select: (id) => {
      setDrawingSel(id);
      if (id) setSelected(null);
    },
    moveText: (id, x, y) =>
      setDrawings((d) => ({ ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, x, y } : t)) })),
  };
  const deleteDrawing = (id: string) => {
    record();
    setDrawings((d) => ({
      lines: d.lines.filter((l) => l.id !== id),
      texts: d.texts.filter((t) => t.id !== id),
      strokes: d.strokes.filter((t) => t.id !== id),
    }));
    setDrawingSel(null);
    setDirty(true);
  };
  const editDrawing = (
    id: string,
    patch: { label?: string; text?: string; colour?: string; width?: number },
  ) => {
    if (patch.colour) drawColour.current = patch.colour;
    setDrawings((d) => ({
      strokes: d.strokes.map((st) =>
        st.id === id
          ? {
              ...st,
              ...(patch.colour ? { colour: patch.colour } : {}),
              ...(patch.width ? { width: patch.width } : {}),
            }
          : st,
      ),
      lines: d.lines.map((l) =>
        l.id === id
          ? {
              ...l,
              ...(patch.label !== undefined ? { label: patch.label } : {}),
              ...(patch.colour ? { colour: patch.colour } : {}),
            }
          : l,
      ),
      texts: d.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(patch.text !== undefined ? { text: patch.text } : {}),
              ...(patch.colour ? { colour: patch.colour } : {}),
            }
          : t,
      ),
    }));
    setDirty(true);
  };
  const pickedLine = drawingSel ? drawings.lines.find((l) => l.id === drawingSel) : undefined;
  const pickedText = drawingSel ? drawings.texts.find((t) => t.id === drawingSel) : undefined;
  const pickedStroke = drawingSel ? drawings.strokes.find((t) => t.id === drawingSel) : undefined;
  const viewK = () => view.current?.view().k ?? 1;

  // The latest state, for the one key listener.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    // The trades panel keeps its own keys (Esc closes it), and leaves the map's alone.
    if (pair) return;
    if (ask && e.key === "Escape") {
      setAsk(null);
      return;
    }
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
    if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setPicked(new Set(shown.nodes.map((n) => n.id)));
      return;
    }
    if (mod || e.altKey) return;
    const sel = selectedNode;
    switch (e.key) {
      case "Delete":
      case "Backspace":
        if (drawingSel) {
          e.preventDefault();
          deleteDrawing(drawingSel);
          return;
        }
        if (pickedShown.size) {
          e.preventDefault();
          pickActions.hide();
          return;
        }
        if (!sel) return;
        e.preventDefault();
        actions.hide(sel.id);
        return;
      case "Escape":
        if (keysOpen) setKeysOpen(false);
        else if (tool) setTool(null);
        else if (drawingSel) setDrawingSel(null);
        else if (pickedShown.size) setPicked(new Set());
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
      case "a":
        if (graph.nodes.length) {
          setAnalyst(!analyst);
          setDirty(true);
        }
        return;
      case "b":
      case "o":
        if (graph.nodes.length) {
          const t = e.key.toLowerCase() === "b" ? "box" : "lasso";
          setDrawingSel(null);
          setTool((x) => (x === t ? null : t));
        }
        return;
      case "p":
        if (graph.nodes.length) {
          setDrawingSel(null);
          setTool((t) => (t === "pen" ? null : "pen"));
        }
        return;
      case "t": {
        // The bought-together link with the most coins in common, from or to the selected wallet.
        if (sel?.kind !== "wallet") return;
        const best = shown.edges
          .filter((x) => x.kind === "cotrade" && (x.a === sel.id || x.b === sel.id))
          .sort((x, y) => (y.shared ?? y.weight) - (x.shared ?? x.weight))[0];
        if (best) setPair({ a: best.a, b: best.b });
        return;
      }
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
        <SearchBox
          query={query}
          onQuery={setQuery}
          busy={!!busy}
          adding={graph.nodes.length > 0}
          inputRef={searchBox}
          onSubmit={search}
          onPick={(p) => {
            setQuery("");
            void (p.kind === "token" ? openToken(p.address) : openWallet(p.address));
          }}
        />
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
                onToggleKind={(k) => {
                  record();
                  setHiddenKinds((s) => {
                    const n = new Set(s);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  });
                }}
                cutoffs={cutoffs}
                onCutoffs={setCutoffs}
                solUsd={solUsd}
                cut={cut}
                timeLabels={timeLabels}
                onTimeLabels={setTimeLabels}
                hideLoose={hideLoose}
                onHideLoose={(v) => {
                  setHideLoose(v);
                  setDirty(true);
                }}
                perWallet={perWallet}
                onClearWallet={(w) => {
                  setWalletHidden((m) =>
                    w ? Object.fromEntries(Object.entries(m).filter(([x]) => x !== w)) : {},
                  );
                  setDirty(true);
                }}
                onRestore={(keys) => {
                  record();
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
            <span className="asyl-btn-group" role="group" aria-label="Pick bubbles">
              <button
                className={`asyl-btn ghost${tool === "box" ? " on" : ""}`}
                disabled={graph.nodes.length === 0}
                aria-pressed={tool === "box"}
                title="Pick bubbles with a box (B), to hide or change them together. Shift and a drag on the background does it too"
                onClick={() => {
                  setDrawingSel(null);
                  setTool((t) => (t === "box" ? null : "box"));
                }}
              >
                ⬚ Box
              </button>
              <button
                className={`asyl-btn ghost${tool === "lasso" ? " on" : ""}`}
                disabled={graph.nodes.length === 0}
                aria-pressed={tool === "lasso"}
                title="Pick bubbles by drawing a loop round them (O)"
                onClick={() => {
                  setDrawingSel(null);
                  setTool((t) => (t === "lasso" ? null : "lasso"));
                }}
              >
                ◌ Lasso
              </button>
            </span>
            <span className="asyl-btn-group" role="group" aria-label="Draw">
              <button
                className={`asyl-btn ghost${tool === "line" ? " on" : ""}`}
                disabled={graph.nodes.length < 2}
                aria-pressed={tool === "line"}
                title="Draw a line: click one bubble, then another, then label it"
                onClick={() => setTool((t) => (t === "line" ? null : "line"))}
              >
                ╱ Line
              </button>
              <button
                className={`asyl-btn ghost${tool === "text" ? " on" : ""}`}
                disabled={graph.nodes.length === 0}
                aria-pressed={tool === "text"}
                title="Add a text box: click where it goes"
                onClick={() => setTool((t) => (t === "text" ? null : "text"))}
              >
                T Text
              </button>
              <button
                className={`asyl-btn ghost${tool === "pen" ? " on" : ""}`}
                disabled={graph.nodes.length === 0}
                aria-pressed={tool === "pen"}
                title="Draw freehand on the map, in the colour and thickness you pick"
                onClick={() => {
                  setDrawingSel(null);
                  setTool((t) => (t === "pen" ? null : "pen"));
                }}
              >
                ✎ Draw
              </button>
            </span>
            <button
              className={`asyl-btn ghost${analyst ? " on" : ""}`}
              aria-pressed={analyst}
              disabled={graph.nodes.length === 0}
              title={
                analyst
                  ? "Analyst Mode is on: wallets as boxes, money along right-angled lines, traders folded into their coin. Click for the bubble map (A)"
                  : "Analyst Mode: the map as an investigator's flowchart, wallets as boxes with the money on each line (A)"
              }
              onClick={() => {
                setAnalyst(!analyst);
                setDirty(true);
              }}
            >
              ⧉ Analyst
            </button>
            <button
              className={`asyl-btn ghost${grid ? " on" : ""}`}
              disabled={analyst}
              aria-pressed={grid}
              title={
                grid
                  ? "Grid mode is on: each bubble has its own cell, with room for every name and line time. Click to place bubbles freely"
                  : "Grid mode: put each bubble on its own cell, with room for every name and line time"
              }
              onClick={() => {
                record();
                setGrid((g) => !g);
                setDirty(true);
              }}
            >
              ▦ Grid
            </button>
            <span className="asyl-btn-group" role="group" aria-label="Undo and redo">
              <button
                className="asyl-btn ghost"
                disabled={!history.current.canUndo}
                title={`Undo (Ctrl+Z)${history.current.canUndo ? ` · ${history.current.depth.back} step${history.current.depth.back === 1 ? "" : "s"} back` : ""}`}
                onClick={undo}
              >
                ↶ Undo
              </button>
              <button
                className="asyl-btn ghost"
                disabled={!history.current.canRedo}
                title="Redo (Ctrl+Shift+Z)"
                onClick={redo}
              >
                Redo ↷
              </button>
            </span>
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
              title="A picture of the map as you see it now, with the legend and Asyl's brand"
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
              key={epoch}
              grid={grid}
              analyst={analyst}
              solUsd={solUsd}
              graph={shown}
              layout={layout.current}
              selected={selected}
              focus={focus}
              onSelect={setSelected}
              onOpen={(id) => {
                const n = graph.nodes.find((x) => x.id === id);
                if (n) actions.expand(n);
              }}
              onMoveStart={record}
              drawings={drawings}
              tool={tool}
              drawingSelected={drawingSel}
              onDraw={draw}
              pen={pen}
              picked={pickedShown}
              onPick={onPick}
              timeLabels={timeLabels}
              onMoved={() => setDirty(true)}
              layoutKey={layoutKey}
              handle={view}
            />
          )}
          {shown.edges.length > 0 &&
            (analyst ? <AnalystLegend graph={shown} focus={focus} /> : <MapLegend graph={shown} />)}

          {tool === "pen" && (
            <PenBar
              colour={pen.colour}
              width={pen.width}
              onColour={(colour) => setPen((p) => ({ ...p, colour }))}
              onWidth={(width) => setPen((p) => ({ ...p, width }))}
              onDone={() => setTool(null)}
            />
          )}
          {tool && tool !== "pen" && !pickedLine && !pickedText && (
            <div className="asyl-draw-hint" role="status">
              {tool === "line"
                ? "Click a bubble, then the one to join it to · Esc to stop"
                : tool === "box"
                  ? "Drag a box round bubbles · Shift adds to the pick · drag a picked one to move them all · Esc to stop"
                  : tool === "lasso"
                    ? "Draw a loop round bubbles · Shift adds to the pick · Esc to stop"
                    : "Click where the text box goes · Esc to stop"}
            </div>
          )}
          {pickedStroke && tool !== "pen" && (
            <DrawEditor
              key={drawingSel}
              kind="stroke"
              value=""
              colour={pickedStroke.colour}
              width={pickedStroke.width * viewK()}
              onStartEdit={record}
              onChange={() => undefined}
              onColour={(c) => {
                record();
                editDrawing(pickedStroke.id, { colour: c });
              }}
              onWidth={(w) => {
                record();
                editDrawing(pickedStroke.id, { width: w / viewK() });
              }}
              onDelete={() => deleteDrawing(pickedStroke.id)}
              onDone={() => setDrawingSel(null)}
            />
          )}
          {(pickedLine || pickedText) && (
            <DrawEditor
              key={drawingSel}
              kind={pickedLine ? "line" : "text"}
              value={pickedLine ? pickedLine.label : (pickedText?.text ?? "")}
              colour={(pickedLine ?? pickedText)!.colour}
              onStartEdit={record}
              onChange={(v) => editDrawing(drawingSel!, pickedLine ? { label: v } : { text: v })}
              onColour={(c) => {
                record();
                editDrawing(drawingSel!, { colour: c });
              }}
              onDelete={() => deleteDrawing(drawingSel!)}
              onDone={() => setDrawingSel(null)}
            />
          )}
          {pickedShown.size > 0 && tool !== "pen" && (
            <PickBar
              wallets={pickInfo.wallets.length}
              tokens={pickInfo.tokens.length}
              switches={pickInfo.switches}
              pinned={pickPinned}
              busy={!!busy}
              onHide={pickActions.hide}
              onKeepOnly={pickActions.keepOnly}
              onPin={pickActions.pin}
              onLinksAmong={pickActions.linksAmong}
              onGrow={pickActions.grow}
              onSwitch={pickActions.switchKind}
              onClear={() => setPicked(new Set())}
              chainOff={
                typeof session !== "object" || !session.pro
                  ? "Chain reads need Pro Mode"
                  : session.chain && session.chain.left <= 0
                    ? "Today's chain reads are used up"
                    : null
              }
              onShowHolders={(live) => showHolders(pickInfo.tokens, live)}
              onShowDeployers={() => showDeployers(pickInfo.tokens)}
            />
          )}
          {ask && (
            <div className="asyl-ask" role="alertdialog" aria-label="Before loading">
              <p>{ask.text}</p>
              <div className="asyl-actions">
                {ask.choices.map((c) => (
                  <button
                    key={c.label}
                    className={`asyl-btn${c.primary ? " primary" : ""}`}
                    onClick={() => {
                      setAsk(null);
                      c.run();
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            coTraderTotal={coTraderTotals[selectedNode.id]}
            ownLinks={ownLinks}
            ownOff={perWallet.get(selectedNode.id)}
            onOwnKind={(k) => {
              const w = selectedNode.id;
              setWalletHidden((m) => {
                const was = m[w] ?? [];
                const next = was.includes(k) ? was.filter((x) => x !== k) : [...was, k];
                const out = { ...m, [w]: next };
                if (!next.length) delete out[w];
                return out;
              });
              setDirty(true);
            }}
            holderRule={holderRule}
            onEditRule={() => {
              setRail("links");
              setRailOpen(true);
            }}
            actions={actions}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {pair && (
        <PairPanel
          a={pair.a}
          b={pair.b}
          nameOf={(id) => {
            const n = graph.nodes.find((x) => x.id === id);
            return n ? nodeName(n) : shortAddr(id);
          }}
          onSelect={(id) => {
            // Back to the map, on the wallet picked.
            setPair(null);
            setSelected(id);
            view.current?.centre(id);
          }}
          onClose={() => setPair(null)}
        />
      )}
      {sharing && (
        <ShareImageDialog
          title={title}
          fileName={`asyl-${(title.trim() || "map").replace(/[^\w-]+/g, "-").toLowerCase()}`}
          caption={`${title} · Asyl`}
          link={current?.shareSlug ? sharedLink(current.shareSlug) : "asyl.trenchscanner.app"}
          wide
          render={() =>
            (analyst ? renderAnalystCard : renderMapCard)({
              solUsd,
              title:
                title.trim() ||
                (focus
                  ? `Around ${nodeName(graph.nodes.find((n) => n.id === focus) ?? ({ id: focus, name: null } as AsylNode))}`
                  : "Asyl map"),
              graph: shown,
              layout: layout.current,
              focus,
              drawings: {
                lines: drawings.lines.filter(
                  (l) => shown.nodes.some((n) => n.id === l.a) && shown.nodes.some((n) => n.id === l.b),
                ),
                texts: drawings.texts,
                strokes: drawings.strokes,
              },
              timeLabels,
              // What is on screen now (user ask 2026-10-25), as a screenshot of the map.
              view: view.current ? { ...view.current.view(), ...view.current.size() } : undefined,
              onNote: setCardNote,
            })
          }
          controls={cardNote ? <p className="asyl-card-note">{cardNote}</p> : null}
          onClose={() => {
            setSharing(false);
            setCardNote(null);
          }}
        />
      )}
    </div>
  );
}
