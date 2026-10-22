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
import { scopeSampleCard } from "../scopeSample";
import { AlertCard } from "./AlertCard";
import { ClockIcon, TrophyIcon } from "./Icons";
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

/** The grading goal already used on the guest feed. A target, never a claimed result. */
const GOAL = "2x within 15 minutes on 75% of alerts, and 4x within 30 minutes on half";

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
      <p className="eyebrow brand-eyebrow">Pump.fun on Solana</p>
      <h1>Pump.fun alerts, graded in public.</h1>
      <p className="lead">
        Models scan new launches and flag a few. Each alert is graded from the price at the alert. The goal is
        a {GOAL}, measured from that price. Those figures are the target, not a record of results.
      </p>
      {/* Phones and tablets without the app installed only: up top, where it is seen first. */}
      <InstallAppButton />
      <ul className="landing-points">
        <li>
          <span className="eyebrow">Scan</span>
          <p>New Pump.fun tokens are screened first. A model flags only the few that pass.</p>
        </li>
        <li>
          <span className="eyebrow">The card</span>
          <p>
            You see the token, the market cap at the alert, the move since, and a grade when the window
            closes.
          </p>
        </li>
        <li>
          <span className="eyebrow">Then you</span>
          <p>
            Guests see calls {GUEST_DELAY_MINUTES} minutes late. A wallet signature opens the live feed, your
            filters, and alert delivery.
          </p>
        </li>
      </ul>
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

/**
 * The settings sample (scopeSample.ts), with its outbound links removed so the landing example
 * cannot be mistaken for a coin you can open.
 */
function exampleAlertCard(now: number): Card {
  const card = scopeSampleCard(now);
  card.token.twitterUrl = null;
  card.token.websiteUrl = null;
  return card;
}

type ShowcaseBest = { match: Card | null; windowHours: number };
type ShowcaseLatest = { matches: readonly Card[]; delayMinutes?: number };

/**
 * The signed-out explainer: a made-up card so the layout is always on screen, then the real guest
 * showcase (the default models' best call of the last 24 hours, else the latest call) when it loads.
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
  const example = exampleAlertCard(now);
  const live = best.data ? (best.data.match ?? latest.data?.matches[0] ?? null) : null;
  const isBest = live !== null && live === best.data?.match;
  const waiting = !best.data && !best.error;
  const latestPending = !!best.data && !best.data.match && !latest.data && !latest.error;
  const delay = latest.data?.delayMinutes ?? GUEST_DELAY_MINUTES;

  return (
    <section className="landing-example" aria-labelledby="landing-example-title">
      <p className="eyebrow">The alert</p>
      <h2 id="landing-example-title">What an alert looks like</h2>
      <p className="muted">
        One card is one call. The figures on the example below are made up, so you can see the layout before
        the feed answers. A real call, when there is one, is shown under it and labeled as such.
      </p>
      <ul className="landing-reads">
        <li>
          <strong>Token</strong>
          <span>Name, market cap at the alert, and which model flagged it.</span>
        </li>
        <li>
          <strong>Move</strong>
          <span>How far price went from the alert, and where it sits now.</span>
        </li>
        <li>
          <strong>Grade</strong>
          <span>A mark once a target hits or the window closes. An open call has no result yet.</span>
        </li>
      </ul>

      <div className="landing-sample">
        <p className="landing-flag" role="note">
          <strong>Example</strong>
          <span>Made-up coin. The figures are not a result, and this is not a live call.</span>
        </p>
        <div className="cards signin-cards">
          <AlertCard card={example} now={now} detail={false} links={false} atAlert />
        </div>
      </div>

      <div className="landing-live">
        {live ? (
          <>
            <p className="signin-alerts-head small muted">
              {isBest ? (
                <>
                  <TrophyIcon size={13} /> A real call: best model alert of the last{" "}
                  {best.data?.windowHours ?? 24} hours, with its stats at the alert
                </>
              ) : (
                <>
                  <ClockIcon size={13} /> A real call: latest alert, shown {delay} minutes late
                </>
              )}
            </p>
            <div className="cards signin-cards">
              <AlertCard card={live} now={now} labelSource detail={false} atAlert={isBest} />
            </div>
          </>
        ) : (
          <p className="muted small landing-live-note" role="status">
            {waiting
              ? "Checking the last 24 hours for a real alert. The card above is an example."
              : latestPending
                ? "No standout call in that window yet. Checking the latest alert. The card above is an example."
                : best.error || latest.error
                  ? "The live feed didn't answer. The card above is an example, not a recent call."
                  : "Nothing to show from the guest feed right now. The card above is an example."}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The signed-out page's showcase: the default models' best call of the last 24 hours by its Peak,
 * among calls that passed (user decision 2026-10-18). Falls back to the latest call, as guests see
 * it, while no call has passed in that window.
 */
function ShowcaseAlert() {
  const best = usePolling<ShowcaseBest>("/guest/best", 60_000);
  const latest = usePolling<GuestPage>("/guest/feed?page=1", 60_000);
  const now = useNow(15_000);
  return <LandingShowcase best={best} latest={latest} now={now} />;
}
