import { useEffect, useMemo, useState } from "react";
import { ago } from "../format";
import { asylApi, type BetweenRead, type BetweenTransfer } from "./asylApi";
import { EDGE_LABEL, edgeTimeFull, shortAddr, type AsylEdge } from "./graph";
import { EDGE_COLOUR, EDGE_STYLE } from "./GraphView";

/**
 * Transfers between wallets (user ask 2026-10-28: "select two or more wallets, and see every
 * historical transfer between them"), and what a line on the map stands for (same day: "the
 * dot/line can be clicked to open a modal with full details"). Over the map, as PairPanel is;
 * Esc or the close button leaves it.
 *
 * Opens on what TrenchScanner's tables hold, free; Pro Mode reads the rest from the chain. Each row
 * is one move in one transaction, and opens to its full details.
 */

/** The wallets' colours, in the order they were picked. */
export const BETWEEN_COLOURS = ["#ff7a2f", "#6ee7f9", "#c4a1ff", "#3ee08f", "#ffd84a", "#ff6fae"];
/** Wallets read together at most (the API's BETWEEN_WALLETS_MAX). */
export const BETWEEN_WALLETS_MAX = 6;
/** The most a chain read of `n` wallets may take (the API's betweenWorst). */
export const betweenWorst = (n: number) => n * 50 + 200;

const amountText = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `${(a / 1_000).toFixed(1)}K`;
  if (a >= 100) return a.toFixed(0);
  if (a >= 1) return a.toFixed(2);
  return a.toPrecision(2);
};
const when = (ms: number | null) =>
  ms === null
    ? "time unknown"
    : new Date(ms).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
const dayText = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A row's key: one move of one asset, one way, in one transaction. */
export const rowKey = (t: BetweenTransfer) =>
  `${t.signature ?? `funding@${t.at ?? ""}`}|${t.from}|${t.to}|${t.mint ?? ""}`;

/** What a chain read covered, in words: a missing transfer is never read as no transfer. */
export function coverNote(read: BetweenRead, nameOf: (id: string) => string): string {
  const c = read.chain;
  if (!c) return "";
  const partial = c.covers.filter((w) => !w.complete);
  const parts: string[] = [];
  if (partial.length === 0) parts.push("Every wallet's whole history was read.");
  else
    parts.push(
      partial
        .map((w) =>
          w.txs === 0
            ? `${nameOf(w.wallet)} couldn't be read`
            : `${nameOf(w.wallet)} back to ${w.fromMs ? dayText(w.fromMs) : "its oldest listed"} (${w.txs.toLocaleString()} transactions)`,
        )
        .join("; ") + ". Anything older between those wallets isn't in this read.",
    );
  if (c.read < c.shared)
    parts.push(
      `${c.read} of the ${c.shared} transactions they share were read in full, newest first${
        c.stop === "allowance" ? ": today's chain allowance ran short" : ""
      }.`,
    );
  if (c.stop === "paused") parts.push("Chain reads paused part way; try again in a few minutes.");
  return parts.join(" ");
}

function Wallet({
  id,
  colour,
  nameOf,
  onSelect,
}: {
  id: string;
  colour: string | undefined;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className="asyl-tx-who"
      style={colour ? { borderColor: colour } : undefined}
      onClick={() => onSelect(id)}
      title={`${id}: show it on the map`}
    >
      <span className="asyl-pair-dot" style={{ background: colour ?? "var(--asyl-muted)" }} />
      {nameOf(id)}
    </button>
  );
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="asyl-btn ghost asyl-tx-copy"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => undefined);
      }}
      aria-label={`Copy ${label}`}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** One transfer's full details: the transaction, both wallets in full, the asset, where it was read. */
function TransferDetail({
  t,
  coin,
  nameOf,
}: {
  t: BetweenTransfer;
  coin: BetweenRead["coins"][number] | undefined;
  nameOf: (id: string) => string;
}) {
  const asset = t.mint ? (coin?.symbol ? `$${coin.symbol}` : (coin?.name ?? shortAddr(t.mint))) : "SOL";
  return (
    <dl className="asyl-tx-detail">
      <dt>Transaction</dt>
      <dd>
        {t.signature ? (
          <>
            <code className="asyl-tx-sig">{t.signature}</code>
            <CopyText text={t.signature} label="signature" />
            <a
              className="asyl-link"
              href={`https://solscan.io/tx/${t.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              Solscan ↗
            </a>
          </>
        ) : (
          <span className="asyl-muted">
            TrenchScanner kept who paid this wallet its first SOL, not the transaction. A chain read finds it.
          </span>
        )}
      </dd>
      <dt>When</dt>
      <dd>
        {when(t.at)}
        {t.at !== null && <span className="asyl-muted"> · {ago(new Date(t.at).toISOString())}</span>}
      </dd>
      <dt>From</dt>
      <dd>
        <span>{nameOf(t.from)}</span> <code className="asyl-tx-addr">{t.from}</code>
        <CopyText text={t.from} label="sender" />
      </dd>
      <dt>To</dt>
      <dd>
        <span>{nameOf(t.to)}</span> <code className="asyl-tx-addr">{t.to}</code>
        <CopyText text={t.to} label="receiver" />
      </dd>
      <dt>Asset</dt>
      <dd>
        {asset}
        {t.mint && (
          <>
            {" "}
            <code className="asyl-tx-addr">{t.mint}</code>{" "}
            <a
              className="asyl-link"
              href={`https://solscan.io/token/${t.mint}`}
              target="_blank"
              rel="noreferrer"
            >
              Token ↗
            </a>
          </>
        )}
      </dd>
      <dt>Amount</dt>
      <dd>
        {t.amount !== null ? `${amountText(t.amount)} ${t.mint ? "coins" : "SOL"}` : "Not kept"}
        {t.pct !== null && (
          <span className="asyl-muted"> · {t.pct.toFixed(t.pct < 0.1 ? 3 : 2)}% of supply</span>
        )}
      </dd>
      <dt>Read from</dt>
      <dd>
        {t.source === "chain"
          ? "The chain: the transaction itself, by both wallets' balance changes"
          : t.kind === "funding"
            ? "TrenchScanner's funding record: the first SOL into the wallet"
            : "TrenchScanner's holder transfers: coins moved between a coin's top holders"}
      </dd>
    </dl>
  );
}

export function TransfersPanel({
  wallets,
  edge,
  pro,
  chainOff,
  nameOf,
  onSelect,
  onSpent,
  onClose,
}: {
  wallets: string[];
  /** The line on the map it was opened from, shown first and filtered to. */
  edge?: AsylEdge | null;
  pro: boolean;
  /** Why a chain read can't run now, or null when it can. */
  chainOff: string | null;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  /** A chain read took credits: the page refreshes the allowance it shows. */
  onSpent?: () => void;
  onClose: () => void;
}) {
  const [read, setRead] = useState<BetweenRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [asset, setAsset] = useState<"all" | "sol" | "coins">("all");
  // Opened from a line: that pair, and that asset, until the reader widens it.
  const [onlyEdge, setOnlyEdge] = useState(!!edge);
  const [open, setOpen] = useState<string | null>(null);
  const key = wallets.join(",");

  useEffect(() => {
    let live = true;
    setRead(null);
    setError(null);
    asylApi
      .between(wallets)
      .then((r) => live && setRead(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readChain = () => {
    setReading(true);
    setError(null);
    asylApi
      .chainBetween(wallets)
      .then((r) => {
        setRead(r);
        if ((r.credits ?? 0) > 0) onSpent?.();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setReading(false));
  };

  const colourOf = useMemo(
    () => new Map(wallets.map((w, i) => [w, BETWEEN_COLOURS[i % BETWEEN_COLOURS.length]])),
    [key],
  );
  const coins = useMemo(() => new Map((read?.coins ?? []).map((c) => [c.mint, c])), [read]);
  const rows = useMemo(() => {
    let list = read?.transfers ?? [];
    if (onlyEdge && edge) {
      const pair = new Set([edge.a, edge.b]);
      list = list.filter((t) => pair.has(t.from) && pair.has(t.to));
      if (edge.kind === "transfer" && edge.mint !== undefined)
        list = list.filter((t) => (t.mint ?? null) === (edge.mint ?? null));
    }
    if (asset === "sol") list = list.filter((t) => t.mint === null);
    if (asset === "coins") list = list.filter((t) => t.mint !== null);
    return list;
  }, [read, asset, onlyEdge, edge]);

  // Opened from a line with one transfer behind it: that one is open already.
  useEffect(() => {
    if (edge && rows.length === 1) setOpen(rowKey(rows[0]!));
  }, [read]);

  const sol = rows.filter((t) => t.mint === null).reduce((s, t) => s + (t.amount ?? 0), 0);
  const coinMoves = rows.filter((t) => t.mint !== null).length;
  const times = rows.map((t) => t.at).filter((x): x is number => x !== null);
  const pairs = new Set(rows.map((t) => [t.from, t.to].sort().join("|"))).size;
  const chainNote = read ? coverNote(read, nameOf) : "";
  const title =
    wallets.length === 2
      ? `Transfers between ${nameOf(wallets[0]!)} and ${nameOf(wallets[1]!)}`
      : `Transfers between ${wallets.length} wallets`;

  return (
    <div className="asyl-pair-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="asyl-pair asyl-tx" role="dialog" aria-label={title}>
        <header className="asyl-pair-head">
          <div>
            <p className="asyl-pair-kicker">{edge ? "This link" : "Transfers between"}</p>
            <h2>
              {wallets.map((w, i) => (
                <span key={w} className="asyl-tx-whos">
                  {i > 0 && <span className="asyl-pair-amp">{edge ? "→" : "&"}</span>}
                  <Wallet id={w} colour={colourOf.get(w)} nameOf={nameOf} onSelect={onSelect} />
                </span>
              ))}
            </h2>
          </div>
          <button className="asyl-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {edge && <EdgeFacts edge={edge} nameOf={nameOf} />}

        {error && <p className="asyl-error">{error}</p>}
        {!read && !error && <p className="asyl-muted asyl-pair-loading">Reading their transfers…</p>}

        {read && (
          <>
            <div className="asyl-pair-stats">
              <div className="asyl-pair-stat">
                <span>Transfers</span>
                <b>{rows.length}</b>
                <small>
                  {wallets.length > 2
                    ? `between ${pairs} pair${pairs === 1 ? "" : "s"}`
                    : "one a transaction"}
                </small>
              </div>
              <div className="asyl-pair-stat">
                <span>SOL moved</span>
                <b>{sol > 0 ? amountText(sol) : "–"}</b>
                <small>all directions</small>
              </div>
              <div className="asyl-pair-stat">
                <span>Coin moves</span>
                <b>{coinMoves}</b>
                <small>of {new Set(rows.filter((t) => t.mint).map((t) => t.mint)).size} coins</small>
              </div>
              <div className="asyl-pair-stat">
                <span>Span</span>
                <b>{times.length ? ago(new Date(Math.min(...times)).toISOString()) : "–"}</b>
                <small>
                  {times.length
                    ? `latest ${ago(new Date(Math.max(...times)).toISOString())}`
                    : "no times known"}
                </small>
              </div>
            </div>

            <div className="asyl-tx-chain">
              {read.chain ? (
                <p className="asyl-muted asyl-small">
                  <b>From the chain</b>
                  {read.cached
                    ? " (kept from an earlier read, free)"
                    : read.credits
                      ? ` (${read.credits} credits)`
                      : ""}
                  : {chainNote}
                </p>
              ) : pro ? (
                <>
                  <p className="asyl-muted asyl-small">
                    These are the transfers TrenchScanner&apos;s tables hold: coin moves between top holders
                    over the last 30 days, and who paid each wallet its first SOL. The chain has the rest.
                  </p>
                  <button
                    className="asyl-btn"
                    disabled={reading || !!chainOff}
                    title={chainOff ?? undefined}
                    onClick={readChain}
                  >
                    {reading
                      ? "Reading the chain…"
                      : `Read every transfer from the chain · up to ${betweenWorst(wallets.length)} credits`}
                  </button>
                </>
              ) : (
                <p className="asyl-muted asyl-small">
                  These are the transfers TrenchScanner&apos;s tables hold: coin moves between top holders
                  over the last 30 days, and who paid each wallet its first SOL.{" "}
                  <span className="asyl-pro-chip">Pro</span> Pro Mode reads every transfer between them from
                  the chain.
                </p>
              )}
            </div>

            <div className="asyl-pair-toolbar">
              <span className="asyl-muted asyl-small">
                {edge && (
                  <label className="asyl-check">
                    <input
                      type="checkbox"
                      checked={onlyEdge}
                      onChange={(e) => setOnlyEdge(e.target.checked)}
                    />{" "}
                    Only this link
                  </label>
                )}{" "}
                Click one for its full details
              </span>
              <span className="asyl-seg asyl-seg-small" role="group" aria-label="Asset">
                {(
                  [
                    ["all", "All"],
                    ["sol", "SOL"],
                    ["coins", "Coins"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    className={asset === v ? "on" : ""}
                    aria-pressed={asset === v}
                    onClick={() => setAsset(v)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>

            <ol className="asyl-pair-coins asyl-tx-rows">
              {rows.map((t) => {
                const k = rowKey(t);
                const isOpen = open === k;
                const coin = t.mint ? coins.get(t.mint) : undefined;
                const asset = t.mint
                  ? coin?.symbol
                    ? `$${coin.symbol}`
                    : (coin?.name ?? shortAddr(t.mint))
                  : "SOL";
                return (
                  <li key={k} className={isOpen ? "open" : ""}>
                    <button
                      className="asyl-tx-row"
                      onClick={() => setOpen(isOpen ? null : k)}
                      aria-expanded={isOpen}
                    >
                      <span className="asyl-tx-when">
                        <b>{t.at === null ? "–" : dayText(t.at)}</b>
                        <small className="asyl-muted">
                          {t.at === null
                            ? "time unknown"
                            : new Date(t.at).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                        </small>
                      </span>
                      <span className="asyl-tx-dir">
                        <span style={{ color: colourOf.get(t.from) }}>{nameOf(t.from)}</span>
                        <span className="asyl-muted" aria-label="sent to">
                          {" "}
                          →{" "}
                        </span>
                        <span style={{ color: colourOf.get(t.to) }}>{nameOf(t.to)}</span>
                      </span>
                      <span className="asyl-tx-amount">
                        {t.amount !== null
                          ? `${amountText(t.amount)} ${asset}`
                          : t.pct !== null
                            ? `${t.pct.toFixed(t.pct < 0.1 ? 3 : 2)}% of ${asset}`
                            : asset}
                      </span>
                      <span className={`asyl-tx-tag ${t.source}`}>
                        {t.kind === "funding" ? "First SOL" : t.source === "chain" ? "Chain" : "Stored"}
                      </span>
                      <span className="asyl-pair-chev" aria-hidden>
                        ▾
                      </span>
                    </button>
                    {isOpen && (
                      <div className="asyl-pair-detail">
                        <TransferDetail t={t} coin={coin} nameOf={nameOf} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {rows.length === 0 && (
              <p className="asyl-muted">
                {read.chain
                  ? "No transfer between them in what the chain read covered."
                  : "No transfer between them that TrenchScanner's tables hold."}
              </p>
            )}
            {read.more && (
              <p className="asyl-muted asyl-small">
                Showing the newest {read.transfers.length}; there are more.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** A line's own facts, as the map has them: what kind, between whom, how much, when, read where. */
function EdgeFacts({ edge, nameOf }: { edge: AsylEdge; nameOf: (id: string) => string }) {
  const facts: [string, string][] = [
    ["Link", `${EDGE_LABEL[edge.kind]}: ${EDGE_STYLE[edge.kind].meaning}`],
    ["Between", `${nameOf(edge.a)} → ${nameOf(edge.b)}`],
  ];
  if (edge.label) facts.push(["Reads", edge.label]);
  if (edge.sol != null) facts.push(["SOL", amountText(edge.sol)]);
  if (edge.tokens != null) facts.push(["Coins", amountText(edge.tokens)]);
  if (edge.pct != null) facts.push(["Share of supply", `${edge.pct.toFixed(edge.pct < 0.1 ? 3 : 2)}%`]);
  if (edge.net != null) facts.push(["Realised", `${edge.net >= 0 ? "+" : "−"}${amountText(edge.net)} SOL`]);
  if (edge.shared != null)
    facts.push(["Coins together", `${edge.shared}${edge.of != null ? ` of ${edge.of}` : ""}`]);
  const at = edgeTimeFull(edge.at ?? null);
  if (at) facts.push(["When", at]);
  facts.push(["Read from", edge.source === "chain" ? "A chain read of this map" : "TrenchScanner's tables"]);
  return (
    <dl className="asyl-tx-detail asyl-tx-edge" style={{ borderColor: EDGE_COLOUR[edge.kind] }}>
      {facts.map(([k, v]) => (
        <div key={k} className="asyl-tx-fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A line that isn't money between two wallets (holds, traded, deployed): its facts, and where to
 * look further. Money between wallets opens TransfersPanel; bought together opens PairPanel.
 */
export function LinkPanel({
  edge,
  nameOf,
  onSelect,
  onClose,
}: {
  edge: AsylEdge;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const coin = edge.mint ?? null;
  return (
    <div className="asyl-pair-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="asyl-pair asyl-tx" role="dialog" aria-label={`${EDGE_LABEL[edge.kind]} link`}>
        <header className="asyl-pair-head">
          <div>
            <p className="asyl-pair-kicker">This link</p>
            <h2>
              <Wallet id={edge.a} colour={BETWEEN_COLOURS[0]} nameOf={nameOf} onSelect={onSelect} />
              <span className="asyl-pair-amp">→</span>
              <Wallet id={edge.b} colour={BETWEEN_COLOURS[1]} nameOf={nameOf} onSelect={onSelect} />
            </h2>
          </div>
          <button className="asyl-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <EdgeFacts edge={edge} nameOf={nameOf} />
        <p className="asyl-muted asyl-small">
          {edge.kind === "traded" || edge.kind === "holds"
            ? "A wallet's trades and holdings are added up per coin, so this link has no one transaction behind it."
            : "The transaction behind it is on Solscan."}
        </p>
        <p className="asyl-tx-links">
          <a
            className="asyl-link"
            href={`https://solscan.io/account/${edge.a}`}
            target="_blank"
            rel="noreferrer"
          >
            {nameOf(edge.a)} on Solscan ↗
          </a>
          {coin && (
            <>
              <a
                className="asyl-link"
                href={`https://solscan.io/token/${coin}`}
                target="_blank"
                rel="noreferrer"
              >
                The coin on Solscan ↗
              </a>
              <a
                className="asyl-link"
                href={`https://dexscreener.com/solana/${coin}`}
                target="_blank"
                rel="noreferrer"
              >
                Chart on DexScreener ↗
              </a>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
