import { useEffect, useState } from "react";
import type { User } from "../api";
import { describeSignInError, onWalletsChanged, walletOptions, type WalletOption } from "../wallet";
import { BrainIcon, RobotIcon, TargetIcon } from "./Icons";

/**
 * How long to look for wallets before saying there are none. Extensions can announce themselves
 * after the page has rendered (Edge in particular can be slow to wake one up), and the old
 * window.solana-style providers send no event at all, so the list is also re-read once this ends.
 */
const WALLET_SEARCH_MS = 2_000;

const FEATURES = [
  {
    Icon: TargetIcon,
    title: "Curated picks",
    body: "A curator scans every new Pump.fun token and sends only the few worth a look.",
  },
  {
    Icon: BrainIcon,
    title: "Models that grade themselves",
    body: "Several models retrain on what actually doubled, and a public leaderboard ranks their live calls.",
  },
  {
    Icon: RobotIcon,
    title: "AI second opinion",
    body: "An AI reviewer is being trained to give a buy / no-buy on picks, scored against real outcomes.",
  },
];

export function SignIn({ onSignedIn, onGuest }: { onSignedIn: (u: User) => void; onGuest?: () => void }) {
  const [wallets, setWallets] = useState<WalletOption[]>(walletOptions);
  const [searching, setSearching] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setWallets(walletOptions());
    const off = onWalletsChanged(refresh);
    const done = setTimeout(() => {
      refresh();
      setSearching(false);
    }, WALLET_SEARCH_MS);
    // Coming back from installing or unlocking a wallet in another tab.
    window.addEventListener("focus", refresh);
    return () => {
      off();
      clearTimeout(done);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const connect = async (wallet: WalletOption) => {
    setBusy(wallet.key);
    setError(null);
    try {
      onSignedIn(await wallet.signIn());
    } catch (e) {
      console.error("Wallet sign-in failed", e);
      setError(describeSignInError(e, wallet.name));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="signin">
      <div className="signin-copy">
        <span className="eyebrow brand-eyebrow">Solana memecoin scanner</span>
        <h1>
          Pump.fun alerts, <span className="grad">picked by a model</span> that grades itself.
        </h1>
        <p className="lead muted">
          Every pick is measured against one goal in public: 2x within 15 minutes on 75% of alerts, 4x within
          30 minutes on half, and 10x within an hour on a quarter, from the price at the alert.
        </p>
        <div className="features">
          {FEATURES.map(({ Icon, title, body }) => (
            <div key={title} className="feature">
              <span className="feature-icon">
                <Icon size={18} />
              </span>
              <div>
                <strong>{title}</strong>
                <p className="muted small">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="panel signin-box">
        <h2>Sign in</h2>
        <p className="muted small">Signing proves you own the wallet. It's free and sends no transaction.</p>
        {wallets.length === 0 && searching ? (
          <p className="muted small">Looking for wallets in this browser…</p>
        ) : wallets.length === 0 ? (
          <div className="empty-state left">
            <p>
              No Solana wallet found in this browser. Install{" "}
              <a href="https://phantom.app" target="_blank" rel="noreferrer">
                Phantom
              </a>{" "}
              or{" "}
              <a href="https://solflare.com" target="_blank" rel="noreferrer">
                Solflare
              </a>
              , then reload. If one is installed, make sure it's switched on for this browser and allowed on
              this site (and in InPrivate windows, if you're using one).
            </p>
          </div>
        ) : (
          <div className="wallets">
            {wallets.map((w) => (
              <button key={w.key} className="wallet" disabled={busy !== null} onClick={() => connect(w)}>
                {w.icon ? (
                  <img src={w.icon} alt="" width={28} height={28} />
                ) : (
                  <span className="wallet-letter" aria-hidden>
                    {w.name.charAt(0)}
                  </span>
                )}
                <span>{busy === w.key ? "Waiting for wallet…" : w.name}</span>
                <span className="wallet-go">→</span>
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <p className="faint small signin-burn">
          No subscription yet? Sign in, then burn $ASDFASDFA on the next screen to get access. Your wallet
          shows the exact amount and asks before anything is burned.
        </p>
        {onGuest && (
          <div className="guest-entry">
            <span className="guest-or faint small">or</span>
            <button
              type="button"
              className="button ghost guest-btn"
              disabled={busy !== null}
              onClick={onGuest}
            >
              Continue as guest
            </button>
            <p className="faint small">
              Look around without a wallet: you see the recommended model&apos;s calls. Filters, model picks,
              alerts and settings need a connected wallet.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
