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
import { ago, shortAddress, tokenLabel, tokenThumb } from "../format";
import { onWalletsChanged } from "../wallet";
import { Skeleton } from "../components/Charts";
import { TokenModal } from "../components/TokenModal";
import { ChartIcon, FlameIcon, SearchIcon, ToolsIcon } from "../components/Icons";

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
/** Most credits one burn buys from this panel; a bigger burn can still be made in a few goes. */
const MAX_CREDITS_PER_BURN = 1_000;
const CLAIM_EVERY_MS = 5_000;
const CLAIM_SLOW_AFTER_MS = 120_000;
const SYMBOL = "$ASDFASDFA";

type Stage = "connecting" | "preparing" | "signing" | "sending";
const STAGE_TEXT: Record<Stage, string> = {
  connecting: "Opening wallet…",
  preparing: "Preparing…",
  signing: "Approve in your wallet…",
  sending: "Sending…",
};

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

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
 *
 * Open to any signed-in wallet: the credits are their own payment, so `hasAccess` (a subscription)
 * only decides whether the token view's links to the TokenSage page and the bubble map work.
 */
export function UtilitiesTab({ walletAddress, hasAccess }: { walletAddress: string; hasAccess: boolean }) {
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
          taken once the lookup works, and you can re-open it free for an hour.
        </p>
      </header>

      <CreditsPanel walletAddress={walletAddress} data={data} error={error} onCredited={reload} />

      <div className="util-grid">
        <TokenLookup data={data} onOpened={(mint) => (setOpenMint(mint), reload())} />
        <WalletLookupSoon />
      </div>

      <RecentLookups data={data} onOpen={setOpenMint} />

      {openMint && (
        <UtilityTokenModal
          key={openMint}
          mint={openMint}
          hasAccess={hasAccess}
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
function CreditBurn({
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
            <label htmlFor="credit-count">Credits to buy</label>
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
                  : `Burn ${formatTokens(raw, decimals)} ${SYMBOL} for ${plural(chosen, "credit")}`}
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

/** Paste a contract address, pay a credit, see the coin as the feed's token view shows it. */
function TokenLookup({
  data,
  onOpened,
}: {
  data: UtilitiesOverview | null;
  onOpened: (mint: string) => void;
}) {
  const [mint, setMint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cost = data?.prices.cost.token ?? 1;
  const value = mint.trim();
  const valid = ADDRESS_RE.test(value);
  const open = data?.lookups.some((l) => l.utility === "token" && l.subject === value && l.open) ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post<{ mint: string; charged: number; balance: number }>("/utilities/token", { mint: value });
      setMint("");
      onOpened(value);
    } catch (err) {
      setError(lookupError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel util-card">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ChartIcon size={13} /> Token lookup
          </span>
          <h2>Scan any coin</h2>
        </div>
        <span className="util-cost num">{plural(cost, "credit")}</span>
      </header>
      <p className="muted small">
        Paste a contract address for the same view as a coin on the feed: its chart, holders, safety checks,
        flagged wallets and TokenSage&apos;s read. It gets a fresh scan and a fresh TokenSage read.
      </p>
      <form className="util-form" onSubmit={(e) => void submit(e)}>
        <input
          type="text"
          className="num"
          placeholder="Contract address (CA)"
          aria-label="Token contract address"
          autoComplete="off"
          spellCheck={false}
          value={mint}
          onChange={(e) => {
            setMint(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="primary" disabled={!valid || busy}>
          <SearchIcon size={14} />
          {busy ? "Looking up…" : open ? "Open (free)" : "Look up"}
        </button>
      </form>
      {value !== "" && !valid && <p className="muted small">That doesn&apos;t look like a Solana address.</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The wallet lookup's place on the tab until the wallet view ships. */
function WalletLookupSoon() {
  return (
    <section className="panel util-card util-soon">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <SearchIcon size={13} /> Wallet lookup
          </span>
          <h2>Look into any wallet</h2>
        </div>
      </header>
      <p className="muted small">
        Paste a wallet address to see its full profile: what it holds, who funded it, its risk score and how
        it traded the coins we track. Coming with the wallet view.
      </p>
    </section>
  );
}

/** The wallet's recent lookups: open ones re-open free, older ones can be looked up again. */
function RecentLookups({ data, onOpen }: { data: UtilitiesOverview | null; onOpen: (mint: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookups = data?.lookups ?? [];
  if (!data || lookups.length === 0) return null;

  const again = async (mint: string) => {
    setBusy(mint);
    setError(null);
    try {
      await post("/utilities/token", { mint });
      onOpen(mint);
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
          const label = l.token ? tokenLabel(l.token) : shortAddress(subject);
          const img = l.token?.imageUrl?.startsWith("https://") ? tokenThumb(l.token.imageUrl, 64) : null;
          return (
            <li key={`${subject}-${l.at}-${i}`}>
              {img ? (
                <img
                  className="avatar util-avatar"
                  src={img}
                  alt=""
                  width={28}
                  height={28}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="avatar placeholder util-avatar">{label.replace("$", "").slice(0, 2)}</span>
              )}
              <span className="util-what">
                <strong>{label}</strong>
                <span className="faint small num">
                  {l.utility === "wallet" ? "Wallet" : "Token"} · {shortAddress(subject)} ·{" "}
                  {ago(new Date(l.at))}
                </span>
              </span>
              {l.utility === "token" &&
                (l.open ? (
                  <button type="button" className="ghost small-btn" onClick={() => onOpen(subject)}>
                    Open
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost small-btn"
                    disabled={busy !== null}
                    onClick={() => void again(subject)}
                  >
                    {busy === subject
                      ? "Looking up…"
                      : `Look up again (${plural(data.prices.cost.token, "credit")})`}
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
function UtilityTokenModal({
  mint,
  hasAccess,
  onClose,
}: {
  mint: string;
  hasAccess: boolean;
  onClose: () => void;
}) {
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
      utility={{ apiBase: "/utilities/token", scan: data.scan, extras: hasAccess }}
    />
  );
}
