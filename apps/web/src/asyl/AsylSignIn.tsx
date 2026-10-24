import { useEffect, useState } from "react";
import type { User } from "../api";
import { describeSignInError, onWalletsChanged, walletOptions, type WalletOption } from "../wallet";

/**
 * Asyl's sign-in: the dashboard's wallet sign-in (wallet.ts), the same session as
 * trenchscanner.app's. Email sign-in (Privy) needs its provider on the page; it lives on the
 * dashboard, and a session made there carries over here.
 */
export function AsylSignIn({ onSignedIn, reason }: { onSignedIn: (u: User) => void; reason?: string }) {
  const [options, setOptions] = useState<WalletOption[]>(() => walletOptions());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onWalletsChanged(() => setOptions(walletOptions())), []);

  const signIn = async (o: WalletOption) => {
    setBusy(o.key);
    setError(null);
    try {
      onSignedIn(await o.signIn());
    } catch (e) {
      setError(describeSignInError(e, o.name));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="asyl-gate">
      <div className="asyl-gate-card">
        <h1 className="asyl-wordmark">ASYL</h1>
        <p className="asyl-gate-lede">
          Map who funds, pays and trades with whom on Solana: from TrenchScanner&apos;s own reads, and the
          chain itself with Pro Mode.
        </p>
        {reason && <p className="asyl-gate-note">{reason}</p>}
        <div className="asyl-gate-wallets">
          {options.length === 0 && <p className="asyl-muted">No Solana wallet found in this browser.</p>}
          {options.map((o) => (
            <button
              key={o.key}
              className="asyl-btn asyl-wallet-btn"
              disabled={!!busy}
              onClick={() => void signIn(o)}
            >
              {o.icon && <img src={o.icon} alt="" width={22} height={22} />}
              {busy === o.key ? "Waiting for wallet…" : `Sign in with ${o.name}`}
            </button>
          ))}
        </div>
        {error && (
          <p className="asyl-error" role="alert">
            {error}
          </p>
        )}
        <p className="asyl-muted asyl-small">
          Signed in with email? Sign in on{" "}
          <a href="https://trenchscanner.app" target="_blank" rel="noreferrer">
            trenchscanner.app
          </a>{" "}
          and come back: the session carries over.
        </p>
      </div>
    </div>
  );
}
