import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { cachedGet } from "../cache";
import { ago, shortAddress, signedPct, usd } from "../format";
import { closeWallet, openWallet, WALLET_LINKS, walletLink } from "../walletModal";
import { useWalletNames, type WalletNames } from "../walletNames";
import { WalletText } from "./WalletText";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, LinkIcon, LockIcon, WalletIcon } from "./Icons";

/** Mirrors apps/api/src/walletProfile.ts WalletProfile. */
export interface WalletProfile {
  wallet: string;
  labels: {
    text: string;
    tone: "dev" | "risky" | "linked" | "info" | "good";
    source: string;
    detail?: string;
  }[];
  /** On Solana Tracker's KOL roster. Absent from older API builds. */
  kol?: {
    name: string | null;
    twitter: string | null;
    realizedPnlUsd: number | null;
    winRate: number | null;
  } | null;
  live: {
    readAt: string;
    balanceSol: number | null;
    txCount: number;
    complete: boolean;
    lastAt: string | null;
  } | null;
  firstSeenAt: string | null;
  firstSeenIsFloor: boolean;
  funder: {
    status: string;
    wallet: string | null;
    amountSol: number | null;
    fundedAt: string | null;
    label: string | null;
  } | null;
  otherHoldingsUsd: number | null;
  otherHoldingsAt: string | null;
  risk: {
    score: number;
    coins: number;
    dumps: number;
    fastExits: number;
    snipes: number;
    /** The win side. Absent from older API builds. */
    wins?: number;
    earlyWins?: number;
    winScore?: number;
    medianSupplyPct: number | null;
    lastSeenAt: string;
    computedAt: string;
  } | null;
  totals: { coins: number; wins: number; solIn: number; solOut: number; netSol: number; profitable: number };
  coins: WalletCoin[];
  trades: { at: number; side: "buy" | "sell"; sol: number | null; mint: string; symbol: string | null }[];
  launches: WalletCoin[];
  linked: {
    wallet: string;
    relation: "sibling" | "funded" | "same-minute";
    amountSol: number | null;
    fundedAt: string | null;
    score: number | null;
  }[];
}

interface WalletCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  at: string;
  reason: string | null;
  outcome: "win" | "stop" | "fizzle" | null;
  peakPct: number | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  netSol: number;
  boughtPct: number | null;
  heldPct: number | null;
  firstBuyAt: string | null;
  roles: string[];
  isCreator: boolean;
}

/** Coins listed before "Show all". */
const COINS_SHOWN = 8;
const TRADES_SHOWN = 10;
const RISKY_SCORE = 70;
/** Mirrors core's WINNER_WALLET_SCORE. */
const WINNER_SCORE = 70;

/**
 * One wallet in full, in a dialog: what it is (labels), what it holds and how old it is, who paid
 * for it and who else they paid for, its risk score, and what it did in the coins TrenchScanner
 * tracked. Opened from any wallet the dashboard lists, or a `?wallet=<address>` link. A guest
 * sees what it is and how to get it.
 */
export function WalletModalHost({
  wallet,
  guest,
  onConnect,
}: {
  wallet: string;
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
      className="about-modal sheet-modal bm-modal wm-modal"
      aria-labelledby="wm-title"
      onClose={closeWallet}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
    >
      {guest ? (
        <Locked wallet={wallet} onClose={close} onConnect={onConnect} />
      ) : (
        <Body wallet={wallet} onClose={close} />
      )}
    </dialog>
  );
}

function Head({ wallet, actions }: { wallet: string; actions: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(wallet).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <header className="about-head bm-head">
      <div className="bm-head-text">
        <h2 id="wm-title" tabIndex={-1} autoFocus>
          <WalletIcon size={18} /> Wallet <span className="num wm-short">{shortAddress(wallet)}</span>
        </h2>
        <button type="button" className="wm-address num" onClick={copy} title="Copy the address">
          <span>{wallet}</span>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
      <div className="bm-actions">{actions}</div>
    </header>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
      <CloseIcon size={16} />
    </button>
  );
}

function Locked({
  wallet,
  onClose,
  onConnect,
}: {
  wallet: string;
  onClose: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="about-body bm-body">
      <Head wallet={wallet} actions={<CloseButton onClose={onClose} />} />
      <p className="tm-locked muted">
        <LockIcon size={14} /> Wallet details come with access: its balance and age, who funded it and the
        wallets linked to it, its risk score, and what it did in every coin TrenchScanner tracked.
      </p>
      <button type="button" onClick={onConnect}>
        Connect a wallet
      </button>
      <Links wallet={wallet} />
    </div>
  );
}

function Body({ wallet, onClose }: { wallet: string; onClose: () => void }) {
  const [data, setData] = useState<WalletProfile | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    cachedGet<WalletProfile>(`/wallets/${encodeURIComponent(wallet)}`, 30_000)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      live = false;
    };
  }, [wallet]);

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    void navigator.clipboard?.writeText(walletLink(wallet)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  const actions = (
    <>
      <button type="button" className="ghost share-btn" onClick={copyLink} title="Copy a link to this wallet">
        {copied ? <CheckIcon size={14} /> : <LinkIcon size={14} />}
        {copied ? " Copied" : " Link"}
      </button>
      <CloseButton onClose={onClose} />
    </>
  );

  if (error) {
    const locked = error instanceof ApiError && (error.status === 401 || error.status === 402);
    return (
      <div className="about-body bm-body">
        <Head wallet={wallet} actions={actions} />
        <p className={locked ? "tm-locked muted" : "error small"}>
          {locked ? (
            <>
              <LockIcon size={14} /> Wallet details come with access.
            </>
          ) : (
            `Couldn't load this wallet: ${error.message}`
          )}
        </p>
        <Links wallet={wallet} />
      </div>
    );
  }
  return (
    <div className="about-body bm-body">
      <Head wallet={wallet} actions={actions} />
      {!data ? <div className="bm-skeleton wm-skeleton" /> : <Profile p={data} />}
      <Links wallet={wallet} />
    </div>
  );
}

const sol = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)} SOL`;
const signedSol = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

/** "3d old", "5h old", from a first-seen time. */
function age(iso: string | null, floor: boolean): string {
  if (!iso) return "–";
  const text = ago(iso).replace(" ago", "");
  if (text === "just now") return "new";
  return floor ? `${text}+` : text;
}

function Profile({ p }: { p: WalletProfile }) {
  const risky = p.risk !== null && p.risk.score >= RISKY_SCORE;
  const winner = p.risk !== null && (p.risk.winScore ?? 0) >= WINNER_SCORE;
  // One read names its funder and every linked wallet.
  const names = useWalletNames(
    useMemo(() => [p.funder?.wallet ?? null, ...p.linked.map((l) => l.wallet)], [p]),
  );
  return (
    <>
      {p.kol && <Kol kol={p.kol} />}
      {p.labels.length > 0 && (
        <ul className="tm-tags wm-labels" aria-label="Labels">
          {p.labels.map((l) => (
            <li
              key={l.text}
              className={`tm-tag wm-tone-${l.tone}`}
              title={[l.detail, `Source: ${l.source}`].filter(Boolean).join(". ")}
            >
              {l.text}
            </li>
          ))}
        </ul>
      )}
      <dl className="bm-stats">
        <div>
          <dt>Balance</dt>
          <dd className="num">{p.live ? sol(p.live.balanceSol) : "–"}</dd>
        </div>
        <div title={p.firstSeenAt ? `First seen ${new Date(p.firstSeenAt).toLocaleString()}` : undefined}>
          <dt>Age</dt>
          <dd className="num">{age(p.firstSeenAt, p.firstSeenIsFloor)}</dd>
        </div>
        <div title={p.live?.lastAt ? `Last transaction ${ago(p.live.lastAt)}` : undefined}>
          <dt>Transactions</dt>
          <dd className="num">
            {p.live ? `${p.live.txCount.toLocaleString()}${p.live.complete ? "" : "+"}` : "–"}
          </dd>
        </div>
        <div className={risky ? "risky" : undefined}>
          <dt>Risk score</dt>
          <dd className="num">{p.risk ? Math.round(p.risk.score) : "–"}</dd>
        </div>
        <div className={winner ? "good" : undefined}>
          <dt>Win score</dt>
          <dd className="num">{p.risk?.winScore !== undefined ? Math.round(p.risk.winScore) : "–"}</dd>
        </div>
      </dl>
      <p className="faint small wm-sub">
        {p.live?.lastAt
          ? `Last active ${ago(p.live.lastAt)}`
          : p.live
            ? "No transactions"
            : "Live chain read unavailable"}
        {p.otherHoldingsUsd !== null && (
          <>
            {" · "}
            <span title="Tokens other than SOL and stablecoins, at the last holdings check (a floor: unpriced tokens count as 0)">
              {usd(p.otherHoldingsUsd)} in other tokens
            </span>
          </>
        )}
      </p>

      <Funding p={p} names={names} />
      {p.risk && <Risk risk={p.risk} />}
      <Coins
        title="Tracked coins"
        coins={p.coins}
        totals={p.totals}
        empty="Not seen trading any coin TrenchScanner read the trades of."
      />
      {p.trades.length > 0 && <Trades trades={p.trades} />}
      {p.launches.length > 0 && <Coins title="Coins it launched" coins={p.launches} />}
      <Linked p={p} names={names} />
    </>
  );
}

function WalletButton({ wallet, names }: { wallet: string; names: WalletNames }) {
  return (
    <button
      type="button"
      className="tm-link wm-wallet"
      onClick={() => openWallet(wallet)}
      title="Open this wallet"
    >
      <WalletText wallet={wallet} names={names} />
    </button>
  );
}

function Funding({ p, names }: { p: WalletProfile; names: WalletNames }) {
  const f = p.funder;
  let body: React.ReactNode;
  if (!f) body = <span className="muted">Not read yet.</span>;
  else if (f.status === "found" && f.wallet)
    body = (
      <>
        <WalletButton wallet={f.wallet} names={names} />
        {f.label && f.label !== names[f.wallet]?.name && (
          <span className="tm-tag wm-tone-info">{f.label}</span>
        )}
        <span className="muted">
          sent {sol(f.amountSol, 3)}
          {f.fundedAt ? ` · ${ago(f.fundedAt)}` : ""}
        </span>
      </>
    );
  else if (f.status === "empty") body = <span className="muted">No history on chain.</span>;
  else if (f.status === "none")
    body = <span className="muted">Nobody else paid in at the start: it funded itself.</span>;
  else body = <span className="muted">Couldn&apos;t be read yet.</span>;
  return (
    <section className="sage-card wm-section">
      <h4>First funder</h4>
      <p className="wm-row small">{body}</p>
    </section>
  );
}

function Risk({ risk }: { risk: NonNullable<WalletProfile["risk"]> }) {
  return (
    <section className="sage-card wm-section">
      <h4>
        Risk score <span className="sage-tag">{Math.round(risk.score)} / 100</span>
      </h4>
      <dl className="wm-facts small">
        <div>
          <dt>Coins read</dt>
          <dd className="num">{risk.coins}</dd>
        </div>
        <div>
          <dt>Sold into stops</dt>
          <dd className="num">{risk.dumps}</dd>
        </div>
        <div>
          <dt>Fast exits</dt>
          <dd className="num">{risk.fastExits}</dd>
        </div>
        <div>
          <dt>Launch snipes</dt>
          <dd className="num">{risk.snipes}</dd>
        </div>
        {risk.winScore !== undefined && (
          <div>
            <dt>Win score</dt>
            <dd className="num">{Math.round(risk.winScore)} / 100</dd>
          </div>
        )}
        {risk.wins !== undefined && (
          <div>
            <dt>Coins that doubled</dt>
            <dd className="num">
              {risk.wins}
              {risk.earlyWins !== undefined ? ` (${risk.earlyWins} bought before the call)` : ""}
            </dd>
          </div>
        )}
        <div>
          <dt>Median bought</dt>
          <dd className="num">
            {risk.medianSupplyPct === null ? "–" : `${risk.medianSupplyPct.toFixed(1)}%`}
          </dd>
        </div>
      </dl>
      <p className="faint small wm-note">
        How often it sold into a call&apos;s stop, against the market&apos;s rate, nudged up by fast exits and
        launch snipes. The win score is the mirror: how often the coins it bought doubled, against the market,
        nudged up by being in before the call. Updated {ago(risk.computedAt)}.
      </p>
    </section>
  );
}

const OUTCOME: Record<NonNullable<WalletCoin["outcome"]>, { text: string; cls: string }> = {
  win: { text: "2x", cls: "up" },
  stop: { text: "stop", cls: "down" },
  fizzle: { text: "flat", cls: "muted" },
};

function Coins({
  title,
  coins,
  totals,
  empty,
}: {
  title: string;
  coins: WalletCoin[];
  totals?: WalletProfile["totals"];
  empty?: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? coins : coins.slice(0, COINS_SHOWN);
  return (
    <section className="sage-card wm-section">
      <h4>
        {title}
        <span className="sage-tag">{coins.length}</span>
      </h4>
      {totals && totals.coins > 0 && (
        <p className="small wm-pnl">
          <span className={`num ${totals.netSol >= 0 ? "up" : "down"}`}>{signedSol(totals.netSol)} SOL</span>{" "}
          <span className="muted">
            realised across {totals.coins} coins · {totals.profitable} in profit · {sol(totals.solIn)} in,{" "}
            {sol(totals.solOut)} out
          </span>
        </p>
      )}
      {coins.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="wm-coins">
          {shown.map((c) => {
            const o = c.outcome ? OUTCOME[c.outcome] : null;
            return (
              <li key={c.mint}>
                <a
                  className="wm-coin"
                  href={`https://solscan.io/token/${c.mint}`}
                  target="_blank"
                  rel="noreferrer"
                  title={c.name ?? c.mint}
                >
                  {c.symbol ? `$${c.symbol}` : shortAddress(c.mint)}
                </a>
                <span className="faint small">{ago(c.at)}</span>
                {o && (
                  <span
                    className={`small num ${o.cls}`}
                    title={
                      c.peakPct !== null
                        ? `Peak in the hour after the call: ${signedPct(c.peakPct)}`
                        : undefined
                    }
                  >
                    {o.text}
                  </span>
                )}
                <span className="tm-tags">
                  {c.roles.map((r) => (
                    <span
                      key={r}
                      className={`tm-tag ${r === "dev" ? "k-dev" : r === "top 10" || r.startsWith("buyer") ? "k-linked" : "k-risky"}`}
                    >
                      {r}
                    </span>
                  ))}
                </span>
                <span className="tm-flow num wm-flow" title="SOL in and out of this coin (realised)">
                  {c.solIn.toFixed(2)} → {c.solOut.toFixed(2)}{" "}
                  <span className={c.netSol >= 0 ? "up" : "down"}>({signedSol(c.netSol)})</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {coins.length > COINS_SHOWN && (
        <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${coins.length}`}
        </button>
      )}
    </section>
  );
}

function Trades({ trades }: { trades: WalletProfile["trades"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? trades : trades.slice(0, TRADES_SHOWN);
  return (
    <section className="sage-card wm-section">
      <h4>Recent trades</h4>
      <ul className="wm-trades small">
        {shown.map((t, i) => (
          <li key={`${t.mint}-${t.at}-${i}`}>
            <span className={`wm-side ${t.side === "buy" ? "up" : "down"}`}>
              {t.side === "buy" ? "Buy" : "Sell"}
            </span>
            <span>{t.symbol ? `$${t.symbol}` : shortAddress(t.mint)}</span>
            <span className="num">{sol(t.sol, 3)}</span>
            <span className="faint">{ago(new Date(t.at))}</span>
          </li>
        ))}
      </ul>
      {trades.length > TRADES_SHOWN && (
        <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${trades.length}`}
        </button>
      )}
      <p className="faint small wm-note">
        From the trade reads of tracked coins only, not its whole history.
      </p>
    </section>
  );
}

function Linked({ p, names }: { p: WalletProfile; names: WalletNames }) {
  const siblings = p.linked.filter((l) => l.relation === "sibling");
  const funded = p.linked.filter((l) => l.relation === "funded");
  const sameMinute = p.linked.filter((l) => l.relation === "same-minute");
  if (p.linked.length === 0) {
    return (
      <section className="sage-card wm-section">
        <h4>Linked wallets</h4>
        <p className="muted small">
          {p.funder?.label
            ? "Funded from an exchange or service, which links it to no one."
            : "No other wallet TrenchScanner read shares its funder or was paid for by it."}
        </p>
      </section>
    );
  }
  const list = (rows: WalletProfile["linked"]) => (
    <ul className="wm-linked small">
      {rows.map((l) => (
        <li key={l.wallet}>
          <WalletButton wallet={l.wallet} names={names} />
          <span className="muted num">{sol(l.amountSol, 3)}</span>
          {l.fundedAt && <span className="faint">{ago(l.fundedAt)}</span>}
          {l.score !== null && (
            <span className={`num tm-score${l.score >= RISKY_SCORE ? " down" : ""}`} title="Risk score">
              {Math.round(l.score)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="sage-card wm-section">
      <h4>
        Linked wallets <span className="sage-tag">{p.linked.length}</span>
      </h4>
      {siblings.length > 0 && (
        <>
          <p className="faint small wm-note">
            Same funder (<WalletText wallet={p.funder?.wallet} names={names} />)
          </p>
          {list(siblings)}
        </>
      )}
      {funded.length > 0 && (
        <>
          <p className="faint small wm-note">Wallets it paid for</p>
          {list(funded)}
        </>
      )}
      {sameMinute.length > 0 && (
        <>
          <p className="faint small wm-note">Funded in the same minute, by other funders</p>
          {list(sameMinute)}
        </>
      )}
    </section>
  );
}

function Kol({ kol }: { kol: NonNullable<WalletProfile["kol"]> }) {
  const stats = [
    kol.realizedPnlUsd !== null && `${usd(kol.realizedPnlUsd)} realised`,
    kol.winRate !== null && `${Math.round(kol.winRate)}% win rate`,
  ].filter(Boolean);
  return (
    <p className="wm-identity" title="From Solana Tracker's KOL list">
      <strong>{kol.name ?? "Known KOL"}</strong>
      {kol.twitter && (
        <a href={`https://x.com/${encodeURIComponent(kol.twitter)}`} target="_blank" rel="noreferrer">
          @{kol.twitter} <ExternalIcon size={11} />
        </a>
      )}
      {stats.length > 0 && <span className="num">{stats.join(" · ")}</span>}
    </p>
  );
}

function Links({ wallet }: { wallet: string }) {
  return (
    <nav className="wm-links small" aria-label="Open in">
      {WALLET_LINKS.map((l) => (
        <a key={l.label} href={l.href(wallet)} target="_blank" rel="noreferrer">
          {l.label} <ExternalIcon size={11} />
        </a>
      ))}
    </nav>
  );
}
