import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAuth } from "../context/AuthContext";

export function Login() {
  const { connected } = useWallet();
  const { signIn, signingIn, error } = useAuth();

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__logo">🎯</div>
        <h1>TrenchScanner</h1>
        <p className="login__tagline">
          Scan the Solana memecoin trenches for tokens with breakout potential. Connect your
          wallet to set up filters and get alerts.
        </p>

        <div className="login__actions">
          <WalletMultiButton />
          {connected && (
            <button className="btn btn--primary" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? "Waiting for signature…" : "Sign in"}
            </button>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        <p className="login__note">
          Signing in only signs a message to prove wallet ownership - it never submits a
          transaction and costs no fees.
        </p>
      </div>
    </div>
  );
}
