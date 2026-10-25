import { useEffect, useState } from "react";
import { ago, usd } from "../format";
import { LinkSwatch, imageSources } from "./GraphView";
import { asylApi, avatarUrl, type AsylMe, type Dossier } from "./asylApi";
import {
  EDGE_LABEL,
  WALLET_SWITCHES,
  TAG_LABEL,
  edgeKey,
  neighbours,
  nodeName,
  shortAddr,
  type AsylEdgeKind,
  type AsylGraph,
  type AsylNode,
  type WalletSwitch,
} from "./graph";

/** Its transfers one way, as its own switches name them (user ask 2026-10-25). */
const SWITCH_CHIP: Partial<Record<WalletSwitch, string>> = {
  "transfer:out": "Sent ↗",
  "transfer:in": "Received ↙",
};
const OWN_WHAT: Partial<Record<WalletSwitch, string>> = {
  "transfer:out": "transfers sent",
  "transfer:in": "transfers received",
};

const DIRS = [
  ["all", "All", "Both ways"],
  ["out", "Out ↗", "What it sent, funded or bought"],
  ["in", "In ↙", "What it received, or who funded it"],
] as const;

/** What the inspector's buttons ask of the page. */
export interface InspectorActions {
  expand: (n: AsylNode) => void;
  similar: (wallet: string) => void;
  /** Opens the trades behind a bought-together link. */
  pair: (a: string, b: string) => void;
  flows: (wallet: string) => void;
  funders: (wallets: string[]) => void;
  trace: (wallet: string) => void;
  chainToken: (mint: string) => void;
  pastHolders: (mint: string) => void;
  /** Finds a coin's deployer (from the chain for Pro Mode when unknown) and puts it on the map. */
  showDeployer: (mint: string) => void;
  hide: (id: string) => void;
  /** Hides one link (by edgeKey), listed in the rail's Links tab to show again. */
  cutLink: (key: string) => void;
  select: (id: string) => void;
  saveLabel: (wallet: string, name: string, kol: boolean) => Promise<void>;
  removeLabel: (wallet: string) => Promise<void>;
  setNote: (id: string, text: string) => void;
}

const sol = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : `${n >= 0 ? "" : "−"}${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2)} SOL`;

/** Seconds as the map says them: "42s", "2m 5s". */
export const gapText = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
};

/** A coin's picture, trying each source in turn; nothing when none loads. */
function TokenImage({ sources }: { sources: string[] }) {
  const [n, setN] = useState(0);
  const src = sources[n];
  if (!src) return null;
  return (
    <img className="asyl-insp-img" src={src} alt="" width={40} height={40} onError={() => setN(n + 1)} />
  );
}

/** The selected wallet or coin: what it is, what ties it to the map, and what to read next. */
export function Inspector({
  node,
  graph,
  me,
  busy,
  note,
  coTraderTotal,
  ownLinks,
  ownOff,
  onOwnKind,
  actions,
  onClose,
}: {
  node: AsylNode;
  graph: AsylGraph;
  me: AsylMe;
  busy: string | null;
  note: string;
  /** How many wallets bought together with it in all, when a read said (the map shows up to 20). */
  coTraderTotal?: number;
  /** Its links on the map by kind, before any filter. */
  ownLinks?: ReadonlyMap<WalletSwitch, number>;
  /** The kinds switched off for this bubble only. */
  ownOff?: ReadonlySet<WalletSwitch>;
  onOwnKind?: (k: WalletSwitch) => void;
  actions: InspectorActions;
  onClose: () => void;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierError, setDossierError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The links list, one way or both (user ask 2026-10-25).
  const [dir, setDir] = useState<"all" | "out" | "in">("all");
  const [labelName, setLabelName] = useState("");
  const [labelKol, setLabelKol] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const mine = node.tags.includes("mine");

  useEffect(() => {
    setDossier(null);
    setDossierError(null);
    setCopied(false);
    setLabelName(mine ? (node.name ?? "") : "");
    setLabelKol(false);
    setLabelError(null);
    if (node.kind !== "wallet") return;
    let live = true;
    asylApi
      .dossier(node.id)
      .then((d) => live && setDossier(d))
      .catch((e: Error) => live && setDossierError(e.message));
    return () => {
      live = false;
    };
    // The label field follows the node, not each rename of it.
  }, [node.id]);

  const links = neighbours(graph, node.id);
  const together = links
    .filter((l) => l.edge.kind === "cotrade")
    .sort((x, y) => (y.edge.shared ?? y.edge.weight) - (x.edge.shared ?? x.edge.weight));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chain = me.chain;
  const chainOff = !me.pro
    ? "Chain reads need Pro Mode"
    : chain && chain.left <= 0
      ? "Today's chain reads are used up"
      : null;

  const copy = () => {
    void navigator.clipboard?.writeText(node.id).then(() => setCopied(true));
  };

  const saveLabel = async () => {
    setLabelError(null);
    try {
      await actions.saveLabel(node.id, labelName.trim(), labelKol);
    } catch (e) {
      setLabelError((e as Error).message);
    }
  };

  return (
    <aside className="asyl-inspector" aria-label="Selected">
      <header className="asyl-insp-head">
        {node.kind === "token" && <TokenImage key={node.id} sources={imageSources(node)} />}
        {!node.image && node.avatar && (
          <img className="asyl-insp-img round" src={avatarUrl(node.avatar)} alt="" width={40} height={40} />
        )}
        <div className="asyl-insp-title">
          <h2>{nodeName(node)}</h2>
          <button className="asyl-addr" onClick={copy} title="Copy the address">
            {shortAddr(node.id)} {copied ? "· copied" : ""}
          </button>
        </div>
        <button className="asyl-icon-btn" onClick={onClose} aria-label="Close">
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

      {node.kind === "token" && (
        <dl className="asyl-facts">
          {node.title && (
            <>
              <dt>Name</dt>
              <dd>{node.title}</dd>
            </>
          )}
          <dt>Market cap</dt>
          <dd>
            {usd(node.mcapUsd ?? null)}
            {node.mcapUsd != null && node.mcapAt && Date.now() - Date.parse(node.mcapAt) > 15 * 60_000 && (
              <span className="asyl-muted asyl-small"> · read {ago(node.mcapAt)}</span>
            )}
          </dd>
          <dt>Peak</dt>
          <dd>{usd(node.athUsd ?? null)}</dd>
          {node.launchedAt && (
            <>
              <dt>Launched</dt>
              <dd>{ago(node.launchedAt)}</dd>
            </>
          )}
          {node.deployer && (
            <>
              <dt>Deployed by</dt>
              <dd>
                {byId.has(node.deployer) ? (
                  <button className="asyl-link" onClick={() => actions.select(node.deployer!)}>
                    {nodeName(byId.get(node.deployer)!)}
                  </button>
                ) : (
                  shortAddr(node.deployer)
                )}
                {node.deployerVerified === false && (
                  <span
                    className="asyl-muted asyl-small"
                    title="The creator TrenchScanner was told. A community takeover moves Pump.fun's creator to a new wallet; Show deployer reads the create transaction (Pro Mode) to be sure."
                  >
                    {" "}
                    · unconfirmed
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
      )}

      {node.kind === "wallet" && (
        <div className="asyl-dossier">
          {!dossier && !dossierError && <p className="asyl-muted">Reading the wallet…</p>}
          {dossierError && <p className="asyl-muted">Couldn&apos;t read its profile: {dossierError}</p>}
          {dossier && (
            <>
              {dossier.labels.length > 0 && (
                <div className="asyl-tags">
                  {dossier.labels.slice(0, 8).map((l, i) => (
                    <span key={i} className={`asyl-tag tone-${l.tone}`} title={l.detail}>
                      {l.text}
                    </span>
                  ))}
                </div>
              )}
              <dl className="asyl-facts">
                <dt>Coins</dt>
                <dd>
                  {dossier.totals.coins} ({dossier.totals.wins} won)
                </dd>
                <dt>Net</dt>
                <dd className={dossier.totals.netSol >= 0 ? "good" : "bad"}>{sol(dossier.totals.netSol)}</dd>
                {dossier.live?.balanceSol !== null && dossier.live?.balanceSol !== undefined && (
                  <>
                    <dt>Balance</dt>
                    <dd>{sol(dossier.live.balanceSol)}</dd>
                  </>
                )}
                {dossier.firstSeenAt && (
                  <>
                    <dt>First seen</dt>
                    <dd>
                      {dossier.firstSeenIsFloor ? "before " : ""}
                      {ago(dossier.firstSeenAt)}
                    </dd>
                  </>
                )}
                {dossier.funder?.wallet && (
                  <>
                    <dt>Funded by</dt>
                    <dd>
                      <button className="asyl-link" onClick={() => actions.select(dossier.funder!.wallet!)}>
                        {dossier.funder.label ??
                          byId.get(dossier.funder.wallet)?.name ??
                          shortAddr(dossier.funder.wallet)}
                      </button>
                      {dossier.funder.amountSol !== null ? ` · ${sol(dossier.funder.amountSol)}` : ""}
                    </dd>
                  </>
                )}
                {dossier.risk && (
                  <>
                    <dt>Risk</dt>
                    <dd>
                      {dossier.risk.score}/100 · {dossier.risk.dumps} dumps · {dossier.risk.snipes} snipes
                    </dd>
                  </>
                )}
                {dossier.kol?.name && (
                  <>
                    <dt>KOL</dt>
                    <dd>
                      {dossier.kol.name}
                      {dossier.kol.twitter && (
                        <>
                          {" · "}
                          <a href={`https://x.com/${dossier.kol.twitter}`} target="_blank" rel="noreferrer">
                            @{dossier.kol.twitter}
                          </a>
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      )}

      {together.length > 0 && (
        <section className="asyl-insp-section">
          <h3>
            Bought together <span className="asyl-muted">({together.length})</span>
          </h3>
          <table className="asyl-together">
            <thead>
              <tr>
                <th>Wallet</th>
                <th title="Coins both bought within 3 minutes of each other">Coins in common</th>
                <th title="The typical time between their first buys of those coins">Apart</th>
                <th aria-label="Trades" />
              </tr>
            </thead>
            <tbody>
              {together.map(({ node: other, edge }) => {
                const o = byId.get(other);
                const shared = edge.shared ?? edge.weight;
                return (
                  <tr key={other}>
                    <td>
                      <button className="asyl-link" onClick={() => actions.select(other)}>
                        {o ? nodeName(o) : shortAddr(other)}
                      </button>
                    </td>
                    <td>{edge.of ? `${shared} of ${edge.of}` : shared}</td>
                    <td>{edge.gapSec !== undefined && edge.gapSec !== null ? gapText(edge.gapSec) : "–"}</td>
                    <td>
                      <button
                        className="asyl-btn asyl-btn-xs"
                        title="Their trades on each coin, side by side"
                        onClick={() => actions.pair(edge.a, edge.b)}
                      >
                        Trades
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="asyl-muted asyl-small">
            Coins both bought within 3 minutes of each other, out of the latest coins read; apart is the
            typical time between their first buys.
          </p>
          {coTraderTotal !== undefined && coTraderTotal > together.length && (
            <p className="asyl-small">
              Showing {together.length} of {coTraderTotal}.{" "}
              <button className="asyl-link" disabled={!!busy} onClick={() => actions.similar(node.id)}>
                Load all {coTraderTotal}
              </button>
            </p>
          )}
        </section>
      )}

      <section className="asyl-insp-section">
        <h3>Read more</h3>
        <div className="asyl-actions">
          <button className="asyl-btn" disabled={!!busy} onClick={() => actions.expand(node)}>
            {node.kind === "wallet" ? "Expand its links" : "Map its holders"}
          </button>
          {node.kind === "wallet" && (
            <button className="asyl-btn" disabled={!!busy} onClick={() => actions.similar(node.id)}>
              Wallets that trade like it
            </button>
          )}
          {node.kind === "token" && (
            <button
              className="asyl-btn deploy"
              disabled={!!busy}
              title={
                node.deployerVerified
                  ? "The wallet that signed its create transaction (no credits)"
                  : me.pro
                    ? "Reads its create transaction from the chain when TrenchScanner hasn't (10 credits, once for everyone)"
                    : "The creator TrenchScanner knows; Pro Mode confirms it from the chain"
              }
              onClick={() => actions.showDeployer(node.id)}
            >
              Show deployer
            </button>
          )}
          {node.kind === "token" && (
            <button
              className="asyl-btn"
              disabled={!!busy}
              title="Everyone who put 0.1 SOL or more into it, sold out or still holding, from TrenchScanner's read of its trades (no credits)"
              onClick={() => actions.pastHolders(node.id)}
            >
              Include all historical holders (&gt;0.1 SOL)
            </button>
          )}
        </div>
        <h3 className="asyl-chain-head">
          From the chain <span className="asyl-pro-chip">Pro</span>
        </h3>
        <div className="asyl-actions">
          {node.kind === "wallet" && (
            <>
              <button
                className="asyl-btn chain"
                disabled={!!busy || !!chainOff}
                title={chainOff ?? "Up to 30 credits"}
                onClick={() => actions.flows(node.id)}
              >
                Read its transfers
              </button>
              <button
                className="asyl-btn chain"
                disabled={!!busy || !!chainOff}
                title={chainOff ?? "Up to 11 credits"}
                onClick={() => actions.funders([node.id])}
              >
                Find its funder
              </button>
              <button
                className="asyl-btn chain"
                disabled={!!busy || !!chainOff}
                title={
                  chainOff ??
                  "Follows funder after funder until an exchange, or a wallet the chain can't name a funder for. Up to 10 hops, up to 11 credits each; answers already read are free"
                }
                onClick={() => actions.trace(node.id)}
              >
                Trace to terminal funder
              </button>
            </>
          )}
          {node.kind === "token" && (
            <button
              className="asyl-btn chain"
              disabled={!!busy || !!chainOff}
              title={chainOff ?? "Up to 130 credits"}
              onClick={() => actions.chainToken(node.id)}
            >
              Read live holders and funders
            </button>
          )}
        </div>
        {chainOff && <p className="asyl-muted asyl-small">{chainOff}.</p>}
      </section>

      {node.kind === "wallet" && (
        <section className="asyl-insp-section">
          <h3>Your label</h3>
          {me.pro ? (
            <>
              <div className="asyl-label-row">
                <input
                  className="asyl-input"
                  value={labelName}
                  maxLength={me.labels.nameMax}
                  placeholder="Name this wallet"
                  onChange={(e) => setLabelName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && labelName.trim() && void saveLabel()}
                />
                <button className="asyl-btn" disabled={!labelName.trim()} onClick={() => void saveLabel()}>
                  {mine ? "Rename" : "Save"}
                </button>
              </div>
              {!mine && (
                <label className="asyl-check">
                  <input type="checkbox" checked={labelKol} onChange={(e) => setLabelKol(e.target.checked)} />{" "}
                  It&apos;s a KOL
                </label>
              )}
              {mine && (
                <button
                  className="asyl-link danger"
                  onClick={() =>
                    void actions.removeLabel(node.id).catch((e: Error) => setLabelError(e.message))
                  }
                >
                  Remove your label
                </button>
              )}
              {labelError && <p className="asyl-error">{labelError}</p>}
              <p className="asyl-muted asyl-small">Your labels show in TrenchScanner too, and only to you.</p>
            </>
          ) : (
            <p className="asyl-muted asyl-small">
              Naming wallets is part of Pro Mode, with your labels shared with TrenchScanner.
            </p>
          )}
        </section>
      )}

      <section className="asyl-insp-section">
        <h3>Note on this map</h3>
        <textarea
          className="asyl-input asyl-note"
          value={note}
          maxLength={500}
          rows={2}
          placeholder="What you make of it"
          onChange={(e) => actions.setNote(node.id, e.target.value)}
        />
      </section>

      {ownLinks && ownLinks.size > 0 && onOwnKind && (
        <section className="asyl-insp-section">
          <h3>Its links</h3>
          <div className="asyl-own-kinds" role="group" aria-label="This bubble's kinds of link">
            {WALLET_SWITCHES.filter((k) => ownLinks.has(k)).map((k) => {
              const on = !ownOff?.has(k);
              const what = OWN_WHAT[k] ?? `${EDGE_LABEL[k as AsylEdgeKind]} links`;
              return (
                <button
                  key={k}
                  className={`asyl-chip${on ? " on" : ""}`}
                  aria-pressed={on}
                  title={on ? `Hide its ${what} only` : `Show its ${what} again`}
                  onClick={() => onOwnKind(k)}
                >
                  <LinkSwatch kind={k.startsWith("transfer:") ? "transfer" : (k as AsylEdgeKind)} />
                  {SWITCH_CHIP[k] ?? EDGE_LABEL[k as AsylEdgeKind]}
                  <span className="asyl-count">{ownLinks.get(k)}</span>
                </button>
              );
            })}
          </div>
          <p className="asyl-muted asyl-small">
            For this bubble only; Links in the side menu switches a kind for the whole map. It stays on the
            map either way.
          </p>
        </section>
      )}

      <section className="asyl-insp-section">
        <h3>
          Links on the map <span className="asyl-muted">({links.length})</span>
          {links.some((l) => l.edge.kind === "transfer" || l.edge.kind === "funded") && (
            <span className="asyl-seg asyl-seg-small" role="group" aria-label="Direction">
              {DIRS.map(([v, label, help]) => (
                <button
                  key={v}
                  className={dir === v ? "on" : ""}
                  aria-pressed={dir === v}
                  title={help}
                  onClick={() => setDir(v)}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
        </h3>
        <ul className="asyl-links">
          {links
            .filter(({ edge }) => dir === "all" || (dir === "out" ? edge.a === node.id : edge.b === node.id))
            .slice(0, 60)
            .map(({ node: other, edge }, i) => {
              const o = byId.get(other);
              const out = edge.a === node.id;
              return (
                <li key={i}>
                  <span className="asyl-link-text">
                    <button className="asyl-link" onClick={() => actions.select(other)}>
                      {o ? nodeName(o) : shortAddr(other)}
                    </button>
                    <span className="asyl-muted">
                      {" "}
                      {EDGE_LABEL[edge.kind]} {out ? "→" : "←"} {edge.label}
                      {edge.source === "chain" ? " · chain" : ""}
                    </span>
                  </span>
                  <button
                    className="asyl-icon-btn"
                    title="Hide this link (bring it back from Links)"
                    aria-label={`Hide the ${EDGE_LABEL[edge.kind]} link`}
                    onClick={() => actions.cutLink(edgeKey(edge))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
        </ul>
      </section>

      <footer className="asyl-insp-foot">
        <a
          href={`https://solscan.io/${node.kind === "token" ? "token" : "account"}/${node.id}`}
          target="_blank"
          rel="noreferrer"
        >
          Solscan
        </a>
        {node.kind === "token" && (
          <a href={`https://dexscreener.com/solana/${node.id}`} target="_blank" rel="noreferrer">
            DexScreener
          </a>
        )}
        <button className="asyl-link danger" title="Key: Del" onClick={() => actions.hide(node.id)}>
          Take off the map
        </button>
      </footer>
    </aside>
  );
}
