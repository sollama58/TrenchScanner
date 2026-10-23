import { useEffect, useState } from "react";
import { type Card, type User } from "../api";
import { cachedGet } from "../cache";
import { GUEST_DELAY_MINUTES } from "../session";
import {
  describeSignInError,
  onWalletsChanged,
  signInWithPrivy,
  walletOptions,
  type WalletOption,
} from "../wallet";
import { privyConfig, privyOAuthReturn, type PrivyConfig } from "../privyBridge";
import { cardHideSet, DEFAULT_APPEARANCE } from "../appearance";
import { AlertCard } from "./AlertCard";
import { ClockIcon, FlameIcon, TrophyIcon } from "./Icons";
import { InstallAppButton } from "./InstallApp";
import { usePolling, useNow } from "../hooks";
import type { GuestPage } from "../tabs/GuestLiveTab";

/**
 * How long to look for wallets before saying there are none. Extensions can announce themselves
 * after the page has rendered (Edge in particular can be slow to wake one up), and the old
 * window.solana-style providers send no event at all, so the list is also re-read once this ends.
 */
const WALLET_SEARCH_MS = 2_000;

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

/** The feed's default card: Customize's starting field list, not a denser or expanded look. */
const DEFAULT_CARD_HIDE = cardHideSet(DEFAULT_APPEARANCE);

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
    // index.html starts this on a first visit; cachedGet adopts that request.
    cachedGet<FreeAccessNotice>("/config/free-access")
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

  // Back from Google or X (a full-page redirect): finish that sign-in.
  useEffect(() => {
    if (!privyOAuthReturn()) return;
    void emailSignIn();
    // Once per page load: the return is in the address it was opened with.
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
      <LandingIntro />
      <SignInPanel
        wallets={wallets}
        searching={searching}
        busy={busy}
        error={error}
        privy={privy}
        free={free}
        onConnect={(wallet) => void connect(wallet)}
        onEmail={() => void emailSignIn()}
        onGuest={onGuest}
      />
      <ShowcaseAlert />
    </section>
  );
}

/** What the product is, before anyone is asked to sign in. */
function LandingIntro() {
  return (
    <div className="landing-intro">
      <ThisIsFine />
      <h1>A trading app for the average Joe.</h1>
      <p className="lead">
        Screen a Solana token, open its chart, and trade from the coin window. Model alerts come with the
        terminal.
      </p>
      {/* Phones and tablets without the app installed only: up top, where it is seen first. */}
      <InstallAppButton />
      <div className="landing-token">
        <span className="landing-flame" aria-hidden>
          <FlameIcon size={18} />
        </span>
        <div>
          <p className="landing-token-name">$ASDFASDFA</p>
          <p>Burn it for access.</p>
          <p>The 250 largest holders get Pro Mode: trade from the coin window, with no TrenchScanner fee.</p>
        </div>
      </div>
      <ul className="landing-points">
        <li>
          <span className="eyebrow">Terminal</span>
          <p>The coin window and its chart. Filters, models, and utilities are part of the terminal.</p>
        </li>
        <li>
          <span className="eyebrow">Alerts</span>
          <p>
            Models flag a few Solana tokens. Guests see those alerts {GUEST_DELAY_MINUTES} minutes late. A
            wallet opens them live.
          </p>
        </li>
      </ul>
    </div>
  );
}

/**
 * The hero's mark (user ask 2026-10-23): a flickering flame with "This is Fine" circling it. Still
 * under reduced motion (styles.css).
 */
function ThisIsFine() {
  return (
    <div className="this-is-fine" role="img" aria-label="This is fine">
      <svg className="this-is-fine-ring" viewBox="0 0 100 100" aria-hidden>
        <defs>
          <path id="this-is-fine-path" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
        </defs>
        <text>
          <textPath href="#this-is-fine-path" textLength="230" lengthAdjust="spacing">
            THIS IS FINE • THIS IS FINE •
          </textPath>
        </text>
      </svg>
      <span className="this-is-fine-flame" aria-hidden>
        🔥
      </span>
    </div>
  );
}

export function SignInPanel({
  wallets,
  searching,
  busy,
  error,
  privy,
  free,
  onConnect,
  onEmail,
  onGuest,
}: {
  wallets: WalletOption[];
  searching: boolean;
  busy: string | null;
  error: string | null;
  privy: PrivyConfig | null;
  free: FreeAccessNotice | null;
  onConnect: (wallet: WalletOption) => void;
  onEmail: () => void;
  onGuest?: () => void;
}) {
  return (
    <div className="panel signin-box" aria-busy={busy !== null || undefined}>
      <div className="signin-head">
        <p className="eyebrow">Account</p>
        <h2 id="signin-heading">Sign in</h2>
        <p className="muted small">
          A wallet in this browser signs a message to prove you own it. Signing is free and sends no
          transaction.
        </p>
      </div>

      <section className="signin-method" aria-labelledby="signin-wallet-heading">
        <h3 id="signin-wallet-heading">Solana wallet</h3>
        <ol className="signin-steps">
          <li>
            <span className="num">1</span>
            <span>Choose a wallet installed in this browser.</span>
          </li>
          <li>
            <span className="num">2</span>
            <span>
              Approve the signature prompt. It proves you own the wallet, and nothing is sent on-chain.
            </span>
          </li>
          <li>
            <span className="num">3</span>
            <span>
              You are signed in. If access is not open yet, the next screen asks you to burn $ASDFASDFA.
            </span>
          </li>
        </ol>
        {wallets.length === 0 && searching ? (
          <p className="signin-status small" role="status">
            Looking for wallets in this browser. Extensions can take a moment to wake up.
          </p>
        ) : wallets.length === 0 ? (
          <div className="empty-state left" role="status">
            <p>
              <strong>No Solana wallet in this browser.</strong>
            </p>
            <p>
              Install{" "}
              <a href="https://phantom.app" target="_blank" rel="noreferrer">
                Phantom
              </a>{" "}
              or{" "}
              <a href="https://solflare.com" target="_blank" rel="noreferrer">
                Solflare
              </a>
              , then reload. If one is installed, make sure it&apos;s switched on for this browser and allowed
              on this site (and in InPrivate windows, if you&apos;re using one).
            </p>
          </div>
        ) : (
          <div className="wallets">
            {wallets.map((w) => (
              <button
                key={w.key}
                type="button"
                className="wallet"
                disabled={busy !== null}
                onClick={() => onConnect(w)}
              >
                {w.icon ? (
                  <img src={w.icon} alt="" width={28} height={28} />
                ) : (
                  <span className="wallet-letter" aria-hidden>
                    {w.name.charAt(0)}
                  </span>
                )}
                <span className="wallet-name">{busy === w.key ? "Waiting for wallet…" : w.name}</span>
                <span className="wallet-go" aria-hidden>
                  →
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Always there once it's on: at the sign-up cap, returning accounts still sign in. */}
      {privy?.enabled && (
        <div className="privy-entry">
          <span className="guest-or faint small">or</span>
          <h3>Email, Google, or X</h3>
          <p className="muted small">
            No extension in this browser. Privy signs you in with email, Google, or X.
          </p>
          <button
            type="button"
            className="button wallet privy-btn"
            disabled={busy !== null}
            onClick={onEmail}
          >
            <span className="wallet-name">
              {busy === "privy" ? "Waiting for sign-in…" : "Sign in with email, Google or X"}
            </span>
            <span className="wallet-go" aria-hidden>
              →
            </span>
          </button>
          <p className="faint small">
            {privy.signupsOpen === false
              ? "New email sign-ups are full for now; accounts made before still sign in here."
              : "No wallet? Privy makes you one. It's a separate account from any wallet sign-in, and there's no free start: add SOL, buy $ASDFASDFA in the app and burn it for access."}
          </p>
        </div>
      )}

      {error && (
        <p className="error small signin-error" role="alert">
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

      <div className="signin-after">
        <p className="eyebrow">After you sign in</p>
        <p className="faint small">
          No subscription yet? Sign in, then burn $ASDFASDFA on the next screen to get access. Your wallet
          shows the exact amount and asks before anything is burned.
        </p>
        <p className="faint small">
          On your phone? Open Settings on your signed-in desktop, choose &quot;Show QR code&quot; and scan it.
          No wallet needed on the phone. (For wallet sign-ins; with email, sign in on the phone too.)
        </p>
      </div>

      {onGuest && (
        <div className="guest-entry">
          <span className="guest-or faint small">or</span>
          <h3>Look around first</h3>
          <button type="button" className="button ghost guest-btn" disabled={busy !== null} onClick={onGuest}>
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
  );
}

type ShowcaseBest = { match: Card | null; windowHours: number };
type ShowcaseLatest = { matches: readonly Card[]; delayMinutes?: number };

/**
 * The signed-out explainer: the real guest showcase (the default models' best alert of the last 24
 * hours, else the latest alert) in the default feed look. No made-up card (user ask 2026-10-23).
 */
export function LandingShowcase({
  best,
  latest,
  now,
}: {
  best: { data: ShowcaseBest | null; error: Error | null };
  latest: { data: ShowcaseLatest | null; error: Error | null };
  now: number;
}) {
  const live = best.data ? (best.data.match ?? latest.data?.matches[0] ?? null) : null;
  const isBest = live !== null && live === best.data?.match;
  const waiting = !best.data && !best.error;
  const latestPending = !!best.data && !best.data.match && !latest.data && !latest.error;
  const delay = latest.data?.delayMinutes ?? GUEST_DELAY_MINUTES;

  return (
    <section className="landing-example" aria-labelledby="landing-example-title">
      <p className="eyebrow">Alerts</p>
      <h2 id="landing-example-title">What an alert looks like</h2>
      <div className="landing-live">
        {live ? (
          <>
            <p className="signin-alerts-head small muted">
              {isBest ? (
                <>
                  <TrophyIcon size={13} /> Best model alert of the last {best.data?.windowHours ?? 24} hours,
                  with its stats at the alert
                </>
              ) : (
                <>
                  <ClockIcon size={13} /> Latest alert, shown {delay} minutes late
                </>
              )}
            </p>
            <div className="cards signin-cards">
              <AlertCard
                card={live}
                now={now}
                hide={DEFAULT_CARD_HIDE}
                detail={false}
                links={false}
                atAlert={isBest}
              />
            </div>
          </>
        ) : (
          <p className="muted small landing-live-note" role="status">
            {waiting
              ? "Checking the last 24 hours for a real alert."
              : latestPending
                ? "No standout alert in that window yet. Checking the latest alert."
                : best.error || latest.error
                  ? "The live feed didn't answer. Try again in a minute."
                  : "Nothing to show from the guest feed right now."}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The signed-out page's showcase: the default models' best alert of the last 24 hours by its Peak,
 * among alerts that passed (user decision 2026-10-18). Falls back to the latest alert, as guests see
 * it, while none have passed in that window.
 */
function ShowcaseAlert() {
  const best = usePolling<ShowcaseBest>("/guest/best", 60_000);
  const latest = usePolling<GuestPage>("/guest/feed?page=1", 60_000);
  const now = useNow(15_000);
  return <LandingShowcase best={best} latest={latest} now={now} />;
}
