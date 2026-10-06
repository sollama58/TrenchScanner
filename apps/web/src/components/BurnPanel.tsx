import { useEffect, useRef, useState } from "react";
import { api, type Subscription } from "../api";
import {
  BurnUncertainError,
  burnWallets,
  claimBurn,
  clearPendingBurn,
  describeBurnError,
  formatTokens,
  readPendingBurn,
  sendBurn,
  type BurnBalance,
  type BurnWallet,
  type PendingBurn,
} from "../burn";
import { usePolling } from "../hooks";
import { onWalletsChanged } from "../wallet";

/** Most months one burn buys (the API's MAX_MONTHS_PER_BURN); more than that is lost. */
const MAX_MONTHS = 12;
/** How often to ask whether a sent burn has been credited. Finalising takes ~15-30 seconds. */
const CLAIM_EVERY_MS = 5_000;
/** After this, say it's taking longer than usual (and slow the checks down). */
const CLAIM_SLOW_AFTER_MS = 120_000;

type Stage = "connecting" | "preparing" | "signing" | "sending";
const STAGE_TEXT: Record<Stage, string> = {
  connecting: "Opening wallet…",
  preparing: "Preparing…",
  signing: "Approve in your wallet…",
  sending: "Sending…",
};

function date(d: Date): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Burn $ASDFASDFA for access, right here: pick how many months, see exactly what gets burned and
 * what it buys, approve in the wallet. Used on the paywall (to subscribe) and in Settings (to
 * extend). The wallet's own approval prompt is the confirmation; nothing burns without it.
 */
export function BurnPanel({
  walletAddress,
  onCredited,
}: {
  /** The signed-in wallet. The burn has to come from it. */
  walletAddress: string;
  onCredited?: () => void;
}) {
  const sub = usePolling<Subscription>("/subscription", 300_000);
  const price = sub.data?.price;
  const [balance, setBalance] = useState<BurnBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceKey, setBalanceKey] = useState(0);
  const [months, setMonths] = useState(1);
  const [wallets, setWallets] = useState<BurnWallet[]>(burnWallets);
  const [stage, setStage] = useState<{ wallet: string; stage: Stage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBurn | null>(() => readPendingBurn(walletAddress));
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [pendingSlow, setPendingSlow] = useState(false);
  /** Set synchronously on the first click, so a double click can't start two burns. */
  const starting = useRef(false);
  const [done, setDone] = useState<{ expiresAt: string | null; months: number } | null>(null);
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;

  useEffect(() => {
    const refresh = () => setWallets(burnWallets());
    const off = onWalletsChanged(refresh);
    const late = setTimeout(refresh, 2_000);
    return () => {
      off();
      clearTimeout(late);
    };
  }, []);

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

  // While a sent burn is waiting to be credited, keep asking. The reconciler credits it anyway if
  // this page closes; this is only so the person sees it land.
  useEffect(() => {
    if (!pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const r = await claimBurn(pending.signature);
      if (!live) return;
      if (r.status === "credited") {
        clearPendingBurn();
        setPending(null);
        setPendingNote(null);
        setPendingSlow(false);
        setDone({ expiresAt: r.expiresAt, months: pending.months });
        setBalanceKey((k) => k + 1);
        sub.reload();
        onCreditedRef.current?.();
        return;
      }
      if (r.status === "rejected" || r.status === "held") {
        clearPendingBurn();
        setPending(null);
        setPendingNote(null);
        setPendingSlow(false);
        setError(r.message);
        setBalanceKey((k) => k + 1);
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
    // sub.reload is stable; only a new pending burn restarts the checks.
  }, [pending]);

  if (!price)
    return sub.error && !sub.data ? (
      <p className="error small">Couldn&apos;t load the price: {sub.error.message}</p>
    ) : (
      <p className="muted small">Loading the price…</p>
    );

  const decimals = price.decimals;
  const perMonth = BigInt(price.tokensPerMonth) * 10n ** BigInt(decimals);
  const source = balance?.accounts[0] ?? null;
  const largest = source ? BigInt(source.rawAmount) : 0n;
  const total = balance ? BigInt(balance.totalRaw) : 0n;
  const affordable = Math.min(MAX_MONTHS, Number(largest / perMonth));
  const chosen = Math.max(1, Math.min(months, Math.max(affordable, 1)));
  const raw = perMonth * BigInt(chosen);
  const days = chosen * price.daysPerMonth;
  // Same rule as the API's extendedExpiry: time stacks on an expiry still in the future.
  const now = Date.now();
  const current = sub.data?.expiresAt ? new Date(sub.data.expiresAt).getTime() : 0;
  const stacks = sub.data?.reason === "subscription" || sub.data?.reason === "none";
  const newExpiry = new Date(Math.max(stacks ? current : 0, now) + days * 86_400_000);
  const busy = stage !== null;
  const symbol = "$ASDFASDFA";

  const burn = async (wallet: BurnWallet) => {
    if (!source || starting.current || pending) return;
    starting.current = true;
    setError(null);
    setDone(null);
    setStage({ wallet: wallet.key, stage: "connecting" });
    try {
      const signature = await sendBurn({
        wallet,
        owner: walletAddress,
        tokenAccount: source.address,
        mint: price.mint,
        decimals,
        rawAmount: raw,
        months: chosen,
        onStage: (s) => setStage({ wallet: wallet.key, stage: s }),
      });
      setPending({ signature, wallet: walletAddress, months: chosen, at: Date.now() });
    } catch (e) {
      if (e instanceof BurnUncertainError) {
        setPending({ signature: e.signature, wallet: walletAddress, months: chosen, at: Date.now() });
        setPendingNote(e.message);
      } else {
        console.error("Burn failed", e);
        setError(describeBurnError(e, wallet.name));
      }
    } finally {
      starting.current = false;
      setStage(null);
    }
  };

  if (pending) {
    return (
      <div className="burn" aria-live="polite">
        <p>
          <strong>{pendingNote ? "Checking on your burn." : "Burn sent."}</strong> Waiting for Solana to
          finalise it, usually under a minute. Your access updates here as soon as it does.
        </p>
        {pendingNote && <p className="muted small">{pendingNote}</p>}
        {pendingSlow && (
          <p className="muted small">
            This is taking longer than usual. If your wallet shows the burn went through, your access arrives
            on its own within a few minutes. If it shows the burn failed or was never sent, nothing was burned
            and you can dismiss this.
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
                clearPendingBurn();
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
    <div className="burn">
      {done && (
        <p className="notice" role="status">
          Burn credited: {done.months} month{done.months === 1 ? "" : "s"} added
          {done.expiresAt ? `, access until ${date(new Date(done.expiresAt))}` : ""}.
        </p>
      )}
      <p className="muted small">
        {Number(price.tokensPerMonth).toLocaleString("en-US")} {symbol} buys {price.daysPerMonth} days. Burned
        tokens are destroyed for good, not paid to anyone. Your wallet asks you to approve before anything is
        burned, and the network fee needs a little SOL.
      </p>

      {balanceError ? (
        <p className="error small">
          Couldn&apos;t read your balance: {balanceError}{" "}
          <button type="button" className="link" onClick={() => setBalanceKey((k) => k + 1)}>
            Try again
          </button>
        </p>
      ) : !balance ? (
        <p className="muted small">Reading your balance…</p>
      ) : affordable < 1 ? (
        <p className="small">
          This wallet holds {formatTokens(total, decimals)} {symbol}
          {total > largest && largest > 0n ? ` (${formatTokens(largest, decimals)} in one account)` : ""}. One
          month needs {Number(price.tokensPerMonth).toLocaleString("en-US")}.{" "}
          <a href={`https://pump.fun/coin/${price.mint}`} target="_blank" rel="noreferrer">
            Get {symbol}
          </a>
          {" · "}
          <button type="button" className="link" onClick={() => setBalanceKey((k) => k + 1)}>
            Check again
          </button>
        </p>
      ) : (
        <>
          <div className="burn-pick">
            <label htmlFor="burn-months">Months</label>
            <select
              id="burn-months"
              value={chosen}
              disabled={busy}
              onChange={(e) => setMonths(Number(e.target.value))}
            >
              {Array.from({ length: affordable }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m} month{m === 1 ? "" : "s"} ({m * price.daysPerMonth} days)
                </option>
              ))}
            </select>
            <span className="faint small">
              Balance {formatTokens(total, decimals)} {symbol}
            </span>
          </div>
          <dl className="facts burn-facts">
            <div>
              <dt>Burns</dt>
              <dd className="num">
                {formatTokens(raw, decimals)} {symbol}
              </dd>
            </div>
            <div>
              <dt>Adds</dt>
              <dd className="num">{days} days</dd>
            </div>
            <div>
              <dt>{stacks ? "Access until" : "Subscription until"}</dt>
              <dd className="num">{stacks ? date(newExpiry) : `+${days} days`}</dd>
            </div>
          </dl>
          {wallets.length === 0 ? (
            <p className="muted small">
              No wallet in this browser can sign transactions. Open this page where your wallet extension is
              installed.
            </p>
          ) : (
            <div className="burn-actions">
              {wallets.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void burn(w)}
                >
                  {stage?.wallet === w.key
                    ? STAGE_TEXT[stage.stage]
                    : `Burn ${formatTokens(raw, decimals)} ${symbol}${wallets.length > 1 ? ` with ${w.name}` : ""}`}
                </button>
              ))}
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
