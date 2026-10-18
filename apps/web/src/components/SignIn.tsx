import { useEffect, useState } from "react";
import { api, type User } from "../api";
import { GUEST_DELAY_MINUTES } from "../session";
import {
  describeSignInError,
  onWalletsChanged,
  signInWithPrivy,
  walletOptions,
  type WalletOption,
} from "../wallet";
import { privyConfig, type PrivyConfig } from "../privyBridge";
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
    title: "Curated alerts",
    body: "A curator scans every new Pump.fun token and sends only the few worth a look.",
  },
  {
    Icon: BrainIcon,
    title: "Models that grade themselves",
    body: "Several models retrain on what actually doubled, and a public leaderboard ranks their live alerts.",
  },
  {
    Icon: RobotIcon,
    title: "AI second opinion",
    body: "An AI reviewer is being trained to give a pass / reject on alerts, scored against real outcomes.",
  },
];

interface FreeAccessNotice {
  phase: "scheduled" | "open" | null;
  signInStartsAt: string;
  signInEndsAt: string;
  accessEndsAt: string;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

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

  // Free Access (set in Admin > Access): while its sign-in window is open, or about to open, say
  // so - signing in is what gets a wallet in. Best effort: no answer, no line.
  const [free, setFree] = useState<FreeAccessNotice | null>(null);
  useEffect(() => {
    let live = true;
    api<FreeAccessNotice>("/config/free-access")
      .then((f) => live && setFree(f.phase ? f : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Email sign-in (Privy): shown when the API has it on and sign-ups aren't full.
  const [privy, setPrivy] = useState<PrivyConfig | null>(null);
  useEffect(() => {
    let live = true;
    void privyConfig().then((c) => live && setPrivy(c));
    return () => {
      live = false;
    };
  }, []);
  const emailSignIn = async () => {
    setBusy("privy");
    setError(null);
    try {
      onSignedIn(await signInWithPrivy());
    } catch (e) {
      console.error("Email sign-in failed", e);
      setError(describeSignInError(e, "Privy"));
    } finally {
      setBusy(null);
    }
  };

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
          Pump.fun alerts, <span className="grad">flagged by a model</span> that grades itself.
        </h1>
        <p className="lead muted">
          Every alert is measured against one goal in public: 2x within 15 minutes on 75% of alerts, 4x within
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
        {/* Always there once it's on: at the sign-up cap, returning accounts still sign in. */}
        {privy?.enabled && (
          <div className="privy-entry">
            <span className="guest-or faint small">or</span>
            <button
              type="button"
              className="button wallet privy-btn"
              disabled={busy !== null}
              onClick={() => void emailSignIn()}
            >
              <span>{busy === "privy" ? "Waiting for sign-in…" : "Sign in with email, Google or X"}</span>
              <span className="wallet-go">→</span>
            </button>
            <p className="faint small">
              {privy.signupsOpen === false
                ? "New email sign-ups are full for now; accounts made before still sign in here."
                : "No wallet? Privy makes you one. It's a separate account from any wallet sign-in, and there's no free start: add SOL, buy $ASDFASDFA in the app and burn it for access."}
            </p>
          </div>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {free && (
          <p className="small signin-free" role="status">
            {free.phase === "open"
              ? `Free access is open: sign in before ${fmt(free.signInEndsAt)} to use everything until ${fmt(free.accessEndsAt)}.`
              : `Free access opens ${fmt(free.signInStartsAt)}: sign in then to use everything until ${fmt(free.accessEndsAt)}.`}
          </p>
        )}
        <p className="faint small signin-burn">
          No subscription yet? Sign in, then burn $ASDFASDFA on the next screen to get access. Your wallet
          shows the exact amount and asks before anything is burned.
        </p>
        <p className="faint small signin-phone">
          On your phone? Open Settings on your signed-in desktop, choose &quot;Show QR code&quot; and scan it.
          No wallet needed on the phone. (For wallet sign-ins; with email, sign in on the phone too.)
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
              Look around without a wallet: you see the top models&apos; alerts {GUEST_DELAY_MINUTES} minutes
              late, and the model leaderboard. Live alerts, filters, model selection, alert delivery and
              settings need a connected wallet.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
