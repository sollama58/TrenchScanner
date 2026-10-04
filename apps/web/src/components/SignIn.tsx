import { useEffect, useState } from "react";
import type { Wallet } from "@wallet-standard/base";
import { ApiError, type User } from "../api";
import { onWalletsChanged, signInWithWallet, solanaWallets } from "../wallet";
import { BrainIcon, RobotIcon, TargetIcon } from "./Icons";

const FEATURES = [
  {
    Icon: TargetIcon,
    title: "Curated picks",
    body: "A curator scans every new Pump.fun token and sends only the few worth a look.",
  },
  {
    Icon: BrainIcon,
    title: "A model that grades itself",
    body: "It retrains on what actually doubled and only takes over when it beats the heuristic out of sample.",
  },
  {
    Icon: RobotIcon,
    title: "AI buy / no-buy",
    body: "Each pick gets a second opinion from an AI reviewer, scored against real outcomes.",
  },
];

export function SignIn({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [wallets, setWallets] = useState<readonly Wallet[]>(solanaWallets);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onWalletsChanged(() => setWallets(solanaWallets())), []);

  const connect = async (wallet: Wallet) => {
    setBusy(wallet.name);
    setError(null);
    try {
      onSignedIn(await signInWithWallet(wallet));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401
          ? "The signature didn't verify. Try again, and make sure the wallet shows this site's address."
          : e instanceof Error
            ? e.message
            : String(e),
      );
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
          Every pick is measured against one goal in public: 2x on 75% of alerts, 4x on half, within an hour
          of a realistic fill.
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
        {wallets.length === 0 ? (
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
              , then reload.
            </p>
          </div>
        ) : (
          <div className="wallets">
            {wallets.map((w) => (
              <button key={w.name} className="wallet" disabled={busy !== null} onClick={() => connect(w)}>
                <img src={w.icon} alt="" width={28} height={28} />
                <span>{busy === w.name ? "Waiting for wallet…" : w.name}</span>
                <span className="wallet-go">→</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </section>
  );
}
