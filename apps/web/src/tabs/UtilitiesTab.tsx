import { useEffect, useRef, useState } from "react";
import { api, ApiError, post, type Card } from "../api";
import {
  BurnUncertainError,
  burnWallet,
  claimCreditBurn,
  clearPendingBurn,
  describeBurnError,
  formatTokens,
  PENDING_CREDIT_KEY,
  readPendingBurn,
  sendBurn,
  type BurnBalance,
  type BurnWallet,
  type PendingBurn,
} from "../burn";
import { usePolling } from "../hooks";
import { ago, shortAddress, tokenLabel } from "../format";
import { TokenImage } from "../components/TokenImage";
import { onWalletsChanged } from "../wallet";
import { openWallet } from "../walletModal";
import { Skeleton } from "../components/Charts";
import { TokenModal } from "../components/TokenModal";
import { ChartIcon, FlameIcon, SearchIcon, ToolsIcon, WalletIcon } from "../components/Icons";
import { SideWalletChecker } from "./SideWalletChecker";

/** Mirrors apps/api/src/routes/utilities.ts GET /utilities. */
export interface UtilitiesOverview {
  balance: number;
  prices: { tokensPerCredit: number; cost: { token: number; wallet: number } };
  burn: { mint: string; decimals: number; memo: string };
  reopenMinutes: number;
  lookups: {
    utility: "token" | "wallet" | null;
    subject: string | null;
    cost: number;
    at: string;
    open: boolean;
    token: {
      mintAddress: string;
      symbol: string | null;
      name: string | null;
      imageUrl: string | null;
    } | null;
  }[];
}

/** Mirrors apps/api/src/routes/utilities.ts UtilityTokenView. */
interface UtilityTokenView {
  mint: string;
  paidAt: string;
  scan: "scanning" | "scanned";
  card: Card;
}

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Most credits one burn redeems from this panel; more takes another burn. */
const MAX_CREDITS_PER_BURN = 100;
/** One-tap amounts, shown when the wallet holds enough $ASDFASDFA for them. */
const CREDIT_PICKS = [1, 10, 25, 50, 100];
const CLAIM_EVERY_MS = 5_000;
const CLAIM_SLOW_AFTER_MS = 120_000;
export const SYMBOL = "$ASDFASDFA";

type Stage = "connecting" | "preparing" | "signing" | "sending";
const STAGE_TEXT: Record<Stage, string> = {
  connecting: "Opening wallet…",
  preparing: "Preparing…",
  signing: "Approve in your wallet…",
  sending: "Sending…",
};

export const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** Why a lookup was refused, in words: the API's own message when it sent one. */
function lookupError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429)
      return "Too many lookups at once. Wait a minute, then try again. No credit was used.";
    return e.message || `The server answered ${e.status}. No credit was used.`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The Utilities tab: lookups paid for with Burn Credits, which a wallet earns by burning
 * $ASDFASDFA (500 per credit unless an admin changes it). A credit is taken only once a lookup
 * succeeds, and a lookup can be re-opened free for an hour.
 * Behind the subscription, like every other tab: credits pay for each lookup on top of it.
 */
export function UtilitiesTab({ walletAddress }: { walletAddress: string }) {
  const { data, error, reload } = usePolling<UtilitiesOverview>("/utilities", 60_000);
  const [openMint, setOpenMint] = useState<string | null>(null);

  return (
    <div className="stack utilities">
      <header className="util-intro">
        <span className="eyebrow">
          <ToolsIcon size={13} /> Utilities
        </span>
        <h1>Look up any coin or wallet</h1>
        <p className="muted">
          Each lookup costs Burn Credits, which you get by burning {SYMBOL} from this wallet. A credit is only
          taken once the lookup works, and you can re-open it free for an hour. The Side Wallet Checker is
          free.
        </p>
      </header>

      <CreditsPanel walletAddress={walletAddress} data={data} error={error} onCredited={reload} />

      <div className="util-grid">
        <LookupCard utility="token" data={data} onOpened={(mint) => (setOpenMint(mint), reload())} />
        <LookupCard utility="wallet" data={data} onOpened={(wallet) => (openWallet(wallet), reload())} />
      </div>

      <SideWalletChecker />

      <RecentLookups
        data={data}
        onOpen={(utility, subject) => (utility === "wallet" ? openWallet(subject) : setOpenMint(subject))}
        onPaid={reload}
      />

      {openMint && (
        <UtilityTokenModal
          key={openMint}
          mint={openMint}
          onClose={() => {
            setOpenMint(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** The balance, and burning for more. */
function CreditsPanel({
  walletAddress,
  data,
  error,
  onCredited,
}: {
  walletAddress: string;
  data: UtilitiesOverview | null;
  error: Error | null;
  onCredited: () => void;
}) {
  return (
    <section className="panel util-credits">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <FlameIcon size={13} /> Burn Credits
          </span>
          <h2>Your balance</h2>
        </div>
        <div className="util-balance" aria-live="polite">
          {data ? (
            <>
              <span className="num">{data.balance.toLocaleString("en-US")}</span>
              <small className="muted">credit{data.balance === 1 ? "" : "s"}</small>
            </>
          ) : (
            <span className="num muted">–</span>
          )}
        </div>
      </header>
      {error && !data ? (
        <p className="error small">Couldn&apos;t load your credits: {error.message}</p>
      ) : !data ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <dl className="facts util-rates">
            <div>
              <dt>1 credit</dt>
              <dd className="num">
                {data.prices.tokensPerCredit.toLocaleString("en-US")} {SYMBOL}
              </dd>
            </div>
            <div>
              <dt>Token lookup</dt>
              <dd className="num">{plural(data.prices.cost.token, "credit")}</dd>
            </div>
            <div>
              <dt>Wallet lookup</dt>
              <dd className="num">{plural(data.prices.cost.wallet, "credit")}</dd>
            </div>
          </dl>
          <CreditBurn walletAddress={walletAddress} overview={data} onCredited={onCredited} />
        </>
      )}
    </section>
  );
}

/**
 * Burn for credits: pick how many, see what burns, approve in the wallet. The burn carries the
 * Burn Credits tag, so it buys credits and never subscription time; the API reads it back from the
 * chain and credits it once (and the burn reconciler does, if this tab closes first).
 */
export function CreditBurn({
  walletAddress,
  overview,
  onCredited,
}: {
  walletAddress: string;
  overview: UtilitiesOverview;
  onCredited: () => void;
}) {
  const [balance, setBalance] = useState<BurnBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceKey, setBalanceKey] = useState(0);
  const [wanted, setWanted] = useState(10);
  const [wallet, setWallet] = useState<BurnWallet | null>(() => burnWallet(walletAddress));
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBurn | null>(() =>
    readPendingBurn(walletAddress, PENDING_CREDIT_KEY),
  );
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [pendingSlow, setPendingSlow] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const starting = useRef(false);
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;

  useEffect(() => {
    const refresh = () => setWallet(burnWallet(walletAddress));
    refresh();
    const off = onWalletsChanged(refresh);
    const late = setTimeout(refresh, 2_000);
    window.addEventListener("focus", refresh);
    return () => {
      off();
      clearTimeout(late);
      window.removeEventListener("focus", refresh);
    };
  }, [walletAddress]);

  useEffect(() => {
    let live = true;
    setBalanceError(null);
    api<BurnBalance>("/subscription/balance")
      .then((b) => live && setBalance(b))
      .catch((e: unknown) => live && setBalanceError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [balanceKey]);

  // While a sent burn waits to be credited, keep asking (the reconciler credits it regardless).
  useEffect(() => {
    if (!pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearPendingBurn(PENDING_CREDIT_KEY);
      setPending(null);
      setPendingNote(null);
      setPendingSlow(false);
      setBalanceKey((k) => k + 1);
    };
    const check = async () => {
      const r = await claimCreditBurn(pending.signature);
      if (!live) return;
      if (r.status === "credited") {
        settle();
        setDone(r.credits ?? pending.months);
        onCreditedRef.current();
        return;
      }
      if (r.status === "rejected" || r.status === "held") {
        settle();
        setError(r.message);
        return;
      }
      const slow = Date.now() - pending.at > CLAIM_SLOW_AFTER_MS;
      setPendingSlow(slow);
      timer = setTimeout(check, slow ? CLAIM_EVERY_MS * 3 : CLAIM_EVERY_MS);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pending]);

  const decimals = overview.burn.decimals;
  const perCredit = BigInt(overview.prices.tokensPerCredit) * 10n ** BigInt(decimals);
  const source = balance?.accounts[0] ?? null;
  const largest = source ? BigInt(source.rawAmount) : 0n;
  const total = balance ? BigInt(balance.totalRaw) : 0n;
  const affordable = perCredit > 0n ? Math.min(MAX_CREDITS_PER_BURN, Number(largest / perCredit)) : 0;
  const chosen = Math.max(
    1,
    Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : 1, Math.max(affordable, 1)),
  );
  const raw = perCredit * BigInt(chosen);
  const busy = stage !== null;

  const burn = async (w: BurnWallet) => {
    if (!source || starting.current || pending) return;
    starting.current = true;
    setError(null);
    setDone(null);
    setStage("connecting");
    try {
      const signature = await sendBurn({
        wallet: w,
        owner: walletAddress,
        tokenAccount: source.address,
        mint: overview.burn.mint,
        decimals,
        rawAmount: raw,
        months: chosen,
        memo: overview.burn.memo,
        pendingKey: PENDING_CREDIT_KEY,
        onStage: setStage,
      });
      setPending({ signature, wallet: walletAddress, months: chosen, at: Date.now() });
    } catch (e) {
      if (e instanceof BurnUncertainError) {
        setPending({ signature: e.signature, wallet: walletAddress, months: chosen, at: Date.now() });
        setPendingNote(e.message);
      } else {
        console.error("Credit burn failed", e);
        setError(describeBurnError(e, w.name));
      }
    } finally {
      starting.current = false;
      setStage(null);
    }
  };

  if (pending) {
    return (
      <div className="burn util-burn" aria-live="polite">
        <p>
          <strong>{pendingNote ? "Checking on your burn." : "Burn sent."}</strong> Waiting for Solana to
          finalise it, usually under a minute. Your credits show here as soon as it does.
        </p>
        {pendingNote && <p className="muted small">{pendingNote}</p>}
        {pendingSlow && (
          <p className="muted small">
            This is taking longer than usual. If your wallet shows the burn went through, your credits arrive
            on their own within a few minutes. If it failed or was never sent, nothing was burned.
          </p>
        )}
        <p className="small">
          <a href={`https://solscan.io/tx/${pending.signature}`} target="_blank" rel="noreferrer">
            View the transaction
          </a>
          {pendingSlow && " · "}
          {pendingSlow && (
            <button
              type="button"
              className="link"
              onClick={() => {
                clearPendingBurn(PENDING_CREDIT_KEY);
                setPending(null);
                setPendingNote(null);
                setPendingSlow(false);
                setBalanceKey((k) => k + 1);
              }}
            >
              Dismiss
            </button>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="burn util-burn">
      {done !== null && (
        <p className="notice" role="status">
          Burn credited: {plural(done, "credit")} added.
        </p>
      )}
      {balanceError ? (
        <p className="error small">
          Couldn&apos;t read your {SYMBOL}: {balanceError}{" "}
          <button type="button" className="link" onClick={() => setBalanceKey((k) => k + 1)}>
            Try again
          </button>
        </p>
      ) : !balance ? (
        <p className="muted small">Reading your {SYMBOL}…</p>
      ) : affordable < 1 ? (
        <p className="small">
          This wallet holds {formatTokens(total, decimals)} {SYMBOL}
          {total > largest && largest > 0n ? ` (${formatTokens(largest, decimals)} in one account)` : ""}. One
          credit needs {overview.prices.tokensPerCredit.toLocaleString("en-US")}.{" "}
          <a href={`https://pump.fun/coin/${overview.burn.mint}`} target="_blank" rel="noreferrer">
            Get {SYMBOL}
          </a>
          {" · "}
          <button type="button" className="link" onClick={() => setBalanceKey((k) => k + 1)}>
            Check again
          </button>
        </p>
      ) : (
        <>
          <div className="burn-pick">
            <label htmlFor="credit-count">Credits to redeem</label>
            <div className="util-picks" role="group" aria-label="Quick amounts">
              {CREDIT_PICKS.filter((p) => p <= affordable).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`small-btn${chosen === p ? " active" : ""}`}
                  aria-pressed={chosen === p}
                  disabled={busy}
                  onClick={() => setWanted(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <input
              id="credit-count"
              className="util-count num"
              type="number"
              inputMode="numeric"
              min={1}
              max={affordable}
              step={1}
              value={wanted}
              disabled={busy}
              onChange={(e) => setWanted(Number(e.target.value))}
            />
            <span className="faint small">
              Up to {affordable.toLocaleString("en-US")} · balance {formatTokens(total, decimals)} {SYMBOL}
            </span>
          </div>
          {!wallet ? (
            <p className="muted small">
              The wallet you signed in with ({shortAddress(walletAddress)}) isn&apos;t available in this
              browser. Burning only works from that wallet: sign out, then sign in again with it here.
            </p>
          ) : (
            <div className="burn-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void burn(wallet)}>
                {stage
                  ? STAGE_TEXT[stage]
                  : `Redeem ${plural(chosen, "credit")} (burns ${formatTokens(raw, decimals)} ${SYMBOL})`}
              </button>
              <span className="faint small">
                Burned tokens are destroyed for good. Your wallet asks you to approve first.
              </span>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What each lookup card says and where it posts. */
const LOOKUP_CARDS = {
  token: {
    path: "/utilities/token",
    field: "mint",
    eyebrow: "Token lookup",
    title: "Scan any coin",
    short: "Coin scanner",
    blurb:
      "Paste a contract address for the same view as a coin on the feed: its chart, holders, safety checks, flagged wallets and TokenSage's read. It gets a fresh scan and a fresh TokenSage read.",
    placeholder: "Contract address (CA)",
    label: "Token contract address",
  },
  wallet: {
    path: "/utilities/wallet",
    field: "wallet",
    eyebrow: "Wallet lookup",
    title: "Look into any wallet",
    short: "Wallet scanner",
    blurb:
      "Paste a wallet address to see its full profile: what it holds, who funded it, its risk score and how it traded the coins we track.",
    placeholder: "Wallet address",
    label: "Wallet address",
  },
} as const;

/**
 * Paste an address, pay a credit, see the coin or wallet as the dashboard's own view shows it.
 * `compact` is the utility panel's version (UtilityDrawer): a short title, no blurb.
 */
export function LookupCard({
  utility,
  data,
  onOpened,
  compact = false,
}: {
  utility: "token" | "wallet";
  data: UtilitiesOverview | null;
  onOpened: (address: string) => void;
  compact?: boolean;
}) {
  const card = LOOKUP_CARDS[utility];
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cost = data?.prices.cost[utility] ?? 1;
  const value = address.trim();
  const valid = ADDRESS_RE.test(value);
  const open = data?.lookups.some((l) => l.utility === utility && l.subject === value && l.open) ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post<{ charged: number; balance: number }>(card.path, { [card.field]: value });
      setAddress("");
      onOpened(value);
    } catch (err) {
      setError(lookupError(err));
    } finally {
      setBusy(false);
    }
  };

  const Icon = utility === "token" ? ChartIcon : compact ? WalletIcon : SearchIcon;
  const Wrap = compact ? "div" : "section";
  return (
    <Wrap className={compact ? "util-card util-card-compact" : "panel util-card"}>
      {compact ? (
        <header className="util-col-head">
          <h3>
            <Icon size={14} /> {card.short}
          </h3>
          <span className="util-cost num">{plural(cost, "credit")}</span>
        </header>
      ) : (
        <header className="section-head">
          <div>
            <span className="eyebrow">
              <Icon size={13} /> {card.eyebrow}
            </span>
            <h2>{card.title}</h2>
          </div>
          <span className="util-cost num">{plural(cost, "credit")}</span>
        </header>
      )}
      {!compact && <p className="muted small">{card.blurb}</p>}
      <form className="util-form" onSubmit={(e) => void submit(e)}>
        <input
          type="text"
          className="num"
          placeholder={card.placeholder}
          aria-label={card.label}
          autoComplete="off"
          spellCheck={false}
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="primary" disabled={!valid || busy}>
          <SearchIcon size={14} />
          {busy
            ? compact
              ? "Scanning…"
              : "Looking up…"
            : open
              ? "Open (free)"
              : compact
                ? "Scan"
                : "Look up"}
        </button>
      </form>
      {value !== "" && !valid && <p className="muted small">That doesn&apos;t look like a Solana address.</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </Wrap>
  );
}

type Lookup = UtilitiesOverview["lookups"][number];

/**
 * One lookup in a list: the coin's picture (or the address's first letters) and what it was.
 * `detail` replaces the default second line (kind · address · when).
 */
export function LookupWhat({ lookup: l, detail }: { lookup: Lookup; detail?: React.ReactNode }) {
  const subject = l.subject ?? "";
  const label = l.token ? tokenLabel(l.token) : shortAddress(subject);
  return (
    <>
      <TokenImage
        url={l.token?.imageUrl}
        size={64}
        className="avatar util-avatar"
        width={28}
        height={28}
        fallback={
          <span className="avatar placeholder util-avatar">{label.replace("$", "").slice(0, 2)}</span>
        }
      />
      <span className="util-what">
        <strong>{label}</strong>
        <span className="faint small num">
          {detail ?? (
            <>
              {l.utility === "wallet" ? "Wallet" : "Token"} · {shortAddress(subject)} · {ago(new Date(l.at))}
            </>
          )}
        </span>
      </span>
    </>
  );
}

/** The wallet's recent lookups: open ones re-open free, older ones can be looked up again. */
function RecentLookups({
  data,
  onOpen,
  onPaid,
}: {
  data: UtilitiesOverview | null;
  onOpen: (utility: "token" | "wallet", subject: string) => void;
  onPaid: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookups = data?.lookups ?? [];
  if (!data || lookups.length === 0) return null;

  const again = async (utility: "token" | "wallet", subject: string) => {
    setBusy(subject);
    setError(null);
    try {
      const card = LOOKUP_CARDS[utility];
      await post(card.path, { [card.field]: subject });
      onOpen(utility, subject);
      onPaid();
    } catch (e) {
      setError(lookupError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel util-recent">
      <header className="section-head">
        <div>
          <span className="eyebrow">Recent</span>
          <h2>Your lookups</h2>
        </div>
      </header>
      <ul className="util-list">
        {lookups.map((l, i) => {
          const subject = l.subject ?? "";
          return (
            <li key={`${subject}-${l.at}-${i}`}>
              <LookupWhat lookup={l} />
              {l.utility !== null &&
                (l.open ? (
                  <button
                    type="button"
                    className="ghost small-btn"
                    onClick={() => onOpen(l.utility!, subject)}
                  >
                    Open
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost small-btn"
                    disabled={busy !== null}
                    onClick={() => void again(l.utility!, subject)}
                  >
                    {busy === subject
                      ? "Looking up…"
                      : `Look up again (${plural(data.prices.cost[l.utility], "credit")})`}
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <p className="faint small">
        A lookup re-opens free for {data.reopenMinutes} minutes after you pay for it.
      </p>
    </section>
  );
}

/** A paid lookup in the feed's token modal, refreshed while it is open (its scan lands within a minute). */
export function UtilityTokenModal({ mint, onClose }: { mint: string; onClose: () => void }) {
  const path = `/utilities/token/${encodeURIComponent(mint)}`;
  const [poll, setPoll] = useState(10_000);
  const { data, error } = usePolling<UtilityTokenView>(path, poll);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Every 10s until the scan lands, then at the feed's own pace.
  useEffect(() => {
    if (data?.scan === "scanned") setPoll(30_000);
  }, [data?.scan]);

  if (!data) {
    if (!error) return null;
    // The lookup closed (its free window passed) or failed to load: say so where the button was.
    return (
      <div className="util-toast error small" role="alert">
        Couldn&apos;t open that lookup: {error.message}{" "}
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  return (
    <TokenModal
      card={data.card}
      now={now}
      onClose={onClose}
      utility={{ apiBase: "/utilities/token", scan: data.scan }}
    />
  );
}
