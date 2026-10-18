import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, lookupRequired } from "../api";
import { cachedGet } from "../cache";
import { MIN_WIN_SOL, ago, shortAddress, signedPct, usd } from "../format";
import { closeWallet, openWallet, WALLET_LINKS, walletLink, xSearchLink } from "../walletModal";
import { useWalletNames, type WalletNames } from "../walletNames";
import { WalletText } from "./WalletText";
import { KolAvatar } from "./KolAvatar";
import { TrackedWalletEditor } from "./TrackedWallets";
import { LoadingNote, Reveal, SkelValue } from "./Loading";
import { Skeleton } from "./Charts";
import { bundleRead, KolSideWallets, SideLabelsExport, WalletBundle } from "../tabs/SideWalletChecker";
import { WalletWebButton } from "./WalletWeb";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  LinkIcon,
  LockIcon,
  WalletIcon,
  XLogoIcon,
} from "./Icons";

/** Mirrors apps/api/src/walletProfile.ts WalletProfile. */
export interface WalletProfile {
  wallet: string;
  labels: {
    text: string;
    tone: "dev" | "risky" | "linked" | "info" | "good" | "pumpfun" | "fomo";
    source: string;
    detail?: string;
  }[];
  /** On Solana Tracker's KOL roster. Absent from older API builds. */
  kol?: {
    name: string | null;
    twitter: string | null;
    /** Its X picture's path on the API. Absent from older API builds. */
    avatar?: string | null;
    realizedPnlUsd: number | null;
    winRate: number | null;
    /** A KOL's Known Side: the KOL's main wallet and its name. Absent from older API builds. */
    knownSideOf?: { wallet: string; name: string | null } | null;
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
    /** The labels the book decided (at most one of dumper and winner). Absent from older API builds. */
    dumper?: boolean;
    winner?: boolean;
    sniper?: boolean;
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
  /** A KOL's labeled sides, named as the Side Wallet Checker exports them. Absent from older API builds. */
  kolSides?: KolSide[];
}

interface KolSide {
  wallet: string;
  kind: "known" | "funded" | "possible";
  pct: number;
  /** Transfers with the KOL that earned the label (from the KOL 6 in 24 hours, 10 in 48 or 25 in 72; to it, 8 over 1% of supply in 24 hours, 16 over 0.5% in 24 or 16 over 2% in 72); absent when none. */
  transfers?: number;
  /** "Cupsey_3". */
  name: string;
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

/** How often an open wallet is re-read. */
const PROFILE_REFRESH_MS = 60_000;
/** Coins listed before "Show all". */
const COINS_SHOWN = 8;
const TRADES_SHOWN = 10;
const RISKY_SCORE = 70;

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
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) closeWallet();
      }}
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
      <div className="bm-actions">
        <a
          className="button ghost share-btn wm-x-search"
          href={xSearchLink(wallet)}
          target="_blank"
          rel="noreferrer"
          title="Search X for this address, top posts first"
        >
          <XLogoIcon size={13} /> Search X
        </a>
        {actions}
      </div>
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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    const path = `/wallets/${encodeURIComponent(wallet)}`;
    cachedGet<WalletProfile>(path, 30_000)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))));
    // Re-read while it stays open: a wallet's funder, risk score and trades fill in as the worker
    // reads them, and the profile follows without a reopen. A failed re-read keeps what is shown.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      cachedGet<WalletProfile>(path, PROFILE_REFRESH_MS / 2)
        .then((d) => live && setData((old) => (old ? d : old)))
        .catch(() => undefined);
    }, PROFILE_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [wallet, attempt]);

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
    const lookup = lookupRequired(error);
    const locked = !lookup && error instanceof ApiError && (error.status === 401 || error.status === 402);
    return (
      <div className="about-body bm-body">
        <Head wallet={wallet} actions={actions} />
        <p className={locked ? "tm-locked muted" : "error small"}>
          {lookup ? (
            <>
              <LockIcon size={14} /> {error.message}
            </>
          ) : locked ? (
            <>
              <LockIcon size={14} /> Wallet details come with access.
            </>
          ) : (
            `Couldn't load this wallet: ${error.message}`
          )}
        </p>
        {!lookup && !locked && (
          <p>
            <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        )}
        <Links wallet={wallet} />
      </div>
    );
  }
  return (
    <div className="about-body bm-body">
      <Head wallet={wallet} actions={actions} />
      {!data ? <ProfileSkeleton /> : <Profile p={data} />}
      <Links wallet={wallet} />
    </div>
  );
}

/**
 * The profile's place while the wallet is read (user ask 2026-10-16): its tiles and sections with
 * their own headings, values held by placeholders, so the profile fills in where it will sit. A
 * wallet TrenchScanner hasn't seen is read off the chain then, which can take a while: it says so.
 */
function ProfileSkeleton() {
  return (
    <div className="wm-loading" aria-busy="true">
      <LoadingNote slow="Still reading: a busy wallet's history takes longer to page through.">
        Reading this wallet: its balance, who funded it, and its trades in the coins we track…
      </LoadingNote>
      <dl className="bm-stats">
        {["Balance", "Age", "Transactions", "Risk score", "Win score"].map((l) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd className="num">
              <SkelValue width="3.6em" />
            </dd>
          </div>
        ))}
      </dl>
      {[
        ["First funder", 1],
        ["Risk score", 3],
        ["Tracked coins", 4],
        ["Linked wallets", 2],
      ].map(([title, lines]) => (
        <section key={title} className="sage-card wm-section" aria-hidden="true">
          <h4>{title}</h4>
          <Skeleton lines={lines as number} />
        </section>
      ))}
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
  const winner = p.risk?.winner === true;
  // One read names its funder and every linked wallet.
  const names = useWalletNames(
    useMemo(() => [p.funder?.wallet ?? null, ...p.linked.map((l) => l.wallet)], [p]),
  );
  // The reader's own label shows in its editor (TrackedWalletEditor), kept up to date as it changes.
  const labels = p.labels.filter((l) => l.source !== "Your label");
  return (
    <>
      {p.kol && <Kol kol={p.kol} />}
      <TrackedWalletEditor wallet={p.wallet} />
      {labels.length > 0 && (
        <ul className="tm-tags wm-labels" aria-label="Labels">
          {labels.map((l) => (
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
      {p.kolSides && p.kolSides.length > 0 && (
        <KolSides
          sides={p.kolSides}
          wallet={p.wallet}
          name={p.kol?.knownSideOf?.name ?? p.kol?.name ?? shortAddress(p.wallet)}
        />
      )}
      {!p.kol && <BundleLabels wallet={p.wallet} />}
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
      {/* Any wallet that isn't a KOL: its Multi-Wallet-Bundle, read now (never on the bubble map). */}
      {!p.kol && <WalletBundle wallet={p.wallet} />}
      {p.kol && (
        <KolSideWallets
          wallet={p.wallet}
          kolName={
            p.kol.knownSideOf
              ? `${p.kol.knownSideOf.name ?? shortAddress(p.kol.knownSideOf.wallet)} Known Side`
              : (p.kol.name ?? shortAddress(p.wallet))
          }
        />
      )}
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

const KOL_SIDE_GROUPS: { kind: KolSide["kind"]; title: string }[] = [
  { kind: "known", title: "Known Side Wallets" },
  { kind: "funded", title: "KOL Funded Wallets" },
  { kind: "possible", title: "Probable Side Wallets" },
];

/**
 * A KOL's labeled sides under its first funder (user ask 2026-10-15): its Known Sides, the wallets
 * it funded and its high-confidence Possible Sides, with the names the Side Wallet Checker exports.
 */
function KolSides({ sides, wallet, name }: { sides: KolSide[]; wallet: string; name: string }) {
  return (
    <section className="sage-card wm-section">
      <h4 className="wm-sides-head">
        Labeled side wallets <span className="sage-tag">{sides.length}</span>
        <WalletWebButton wallet={wallet} name={name} className="ghost small-btn side-web-btn wm-web-btn">
          <span className="wm-web-label">Wallet web</span>
        </WalletWebButton>
        <SideLabelsExport labels={{ count: sides.length, wallets: sides }} />
      </h4>
      {KOL_SIDE_GROUPS.map(({ kind, title }) => {
        const rows = sides.filter((s) => s.kind === kind);
        if (rows.length === 0) return null;
        return (
          <div key={kind}>
            <p className="faint small wm-note">
              {title} <span className="num">({rows.length})</span>
            </p>
            <ul className="wm-linked small">
              {rows.map((s) => (
                <li key={s.wallet}>
                  <WalletButton wallet={s.wallet} names={{}} />
                  <span className="tm-tag wm-tone-linked">{s.name}</span>
                  {kind === "possible" && (
                    <span className="muted num">
                      {[
                        s.pct > 0 ? `${Math.round(s.pct)}% shared` : null,
                        s.transfers ? `${s.transfers} transfers` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** Mirrors BundleLabel in apps/api/src/walletBundle.ts. */
interface BundleLabel {
  wallet: string;
  pct: number;
  shared: number;
  coins: number;
  hours: number;
  /** "7xKXtg_1". */
  name: string;
  /** Transfers with it that qualify the wallet (4 in 48 hours or 10 in 72); absent when none. */
  transfers?: number;
  /** The transfer tier's span when it differs from `hours`. */
  transferHours?: number;
}

/**
 * A normal wallet's card like a KOL's labeled sides (user ask 2026-10-15): the wallets in its
 * Multi-Wallet-Bundle that would qualify for a Possible Side label against it. Read with the bundle,
 * never stored, never on the bubble map. Shown only when there are any.
 */
function BundleLabels({ wallet }: { wallet: string }) {
  const [labels, setLabels] = useState<BundleLabel[]>([]);
  useEffect(() => {
    let live = true;
    setLabels([]);
    bundleRead<{ labeled?: BundleLabel[] }>(wallet)
      .then((d) => live && setLabels(d.labeled ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet]);
  if (labels.length === 0) return null;
  // Read after the profile: it opens into place rather than pushing the sections below down at once.
  return (
    <Reveal>
      <section className="sage-card wm-section">
        <h4 className="wm-sides-head">
          Labeled bundle wallets <span className="sage-tag">{labels.length}</span>
          <WalletWebButton
            wallet={wallet}
            name={shortAddress(wallet)}
            className="ghost small-btn side-web-btn wm-web-btn"
          >
            <span className="wm-web-label">Wallet web</span>
          </WalletWebButton>
          <SideLabelsExport labels={{ count: labels.length, wallets: labels }} />
        </h4>
        <p className="faint small wm-note">
          Wallets in its Multi-Wallet-Bundle that would qualify for a label: they bought nearly all of its
          coins within minutes of it, or moved coins with it 4 times in 48 hours or 10 in 72. Not stored, and
          not on the token bubble map.
        </p>
        <ul className="wm-linked small">
          {labels.map((l) => (
            <li key={l.wallet}>
              <WalletButton wallet={l.wallet} names={{}} />
              <span className="tm-tag wm-tone-linked">{l.name}</span>
              <span className="muted num">
                {[
                  l.coins > 0 ? `${Math.round(l.pct)}% of ${l.coins} coins over ${l.hours}h` : null,
                  l.transfers ? `${l.transfers} transfers within ${l.transferHours ?? l.hours}h` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Reveal>
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
          <div className="wm-fact-wide">
            <dt>Wins (sold at 2x+, {MIN_WIN_SOL}+ SOL profit)</dt>
            <dd className="num">
              {risk.wins}
              {risk.earlyWins !== undefined ? ` (${risk.earlyWins} bought before the alert)` : ""}
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
        How often it sold into an alert&apos;s stop, against the market&apos;s rate, nudged up by fast exits
        and launch snipes. The win score is the mirror: how often it sold a coin for twice what it paid and{" "}
        {MIN_WIN_SOL}+ SOL profit, against the market, nudged up by being in before the alert. Labels need 10+
        coins on record: Known dumper is 4+ sold into the stop and three quarters of its coins, Winner is 3+
        such wins at a rate that holds at twice the market&apos;s, and a wallet never carries both. Updated{" "}
        {ago(risk.computedAt)}.
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
                        ? `Peak in the hour after the alert: ${signedPct(c.peakPct)}`
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
  const main = kol.knownSideOf;
  if (main) {
    // One of a KOL's own wallets, not its main one: says whose, and opens the main wallet.
    return (
      <p className="wm-identity" title="Another of this KOL's entries on Solana Tracker's KOL list">
        <strong>{main.name ?? "KOL"} Known Side</strong>
        <button
          type="button"
          className="link"
          onClick={() => openWallet(main.wallet)}
          title="Open the KOL's main wallet"
        >
          Main wallet {shortAddress(main.wallet)}
        </button>
      </p>
    );
  }
  const stats = [
    kol.realizedPnlUsd !== null && `${usd(kol.realizedPnlUsd)} realised`,
    kol.winRate !== null && `${Math.round(kol.winRate)}% win rate`,
  ].filter(Boolean);
  return (
    <p className="wm-identity" title="From Solana Tracker's KOL list">
      <KolAvatar src={kol.avatar} className="wm-kol-pic" />
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
