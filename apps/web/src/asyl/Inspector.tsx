import { useEffect, useState } from "react";
import { ago, usd } from "../format";
import { imageSources } from "./GraphView";
import { asylApi, avatarUrl, type AsylMe, type Dossier } from "./asylApi";
import {
  EDGE_LABEL,
  TAG_LABEL,
  edgeKey,
  neighbours,
  nodeName,
  shortAddr,
  type AsylGraph,
  type AsylNode,
} from "./graph";

/** What the inspector's buttons ask of the page. */
export interface InspectorActions {
  expand: (n: AsylNode) => void;
  similar: (wallet: string) => void;
  flows: (wallet: string) => void;
  funders: (wallets: string[]) => void;
  chainToken: (mint: string) => void;
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
  actions,
  onClose,
}: {
  node: AsylNode;
  graph: AsylGraph;
  me: AsylMe;
  busy: string | null;
  note: string;
  actions: InspectorActions;
  onClose: () => void;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierError, setDossierError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
          <dd>{usd(node.mcapUsd ?? null)}</dd>
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

      <section className="asyl-insp-section">
        <h3>
          Links on the map <span className="asyl-muted">({links.length})</span>
        </h3>
        <ul className="asyl-links">
          {links.slice(0, 60).map(({ node: other, edge }, i) => {
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
