import { useEffect, useState } from "react";
import type { Wallet } from "@wallet-standard/base";
import { api, post, ApiError, type Subscription, type User, type WorkerHealth } from "./api";
import { onWalletsChanged, signInWithWallet, solanaWallets } from "./wallet";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import { ModelTab } from "./tabs/ModelTab";
import { FiltersTab } from "./tabs/FiltersTab";
import {
  BrainIcon,
  LogoMark,
  LogoutIcon,
  PulseIcon,
  RobotIcon,
  ShieldIcon,
  SlidersIcon,
  TargetIcon,
} from "./components/Icons";

type Tab = "live" | "model" | "filters";

const TABS: { id: Tab; label: string; Icon: typeof PulseIcon }[] = [
  { id: "live", label: "Live", Icon: PulseIcon },
  { id: "model", label: "Model & AI", Icon: BrainIcon },
  { id: "filters", label: "Filters", Icon: SlidersIcon },
];

function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "");
  return h === "model" || h === "filters" ? h : "live";
}

type Session = { state: "loading" } | { state: "signed-out" } | { state: "signed-in"; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    api<User>("/auth/me")
      .then((user) => setSession({ state: "signed-in", user }))
      .catch(() => setSession({ state: "signed-out" }));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goTo = (t: Tab) => {
    window.location.hash = t === "live" ? "" : t;
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  const signOut = async () => {
    await post("/auth/logout").catch(() => undefined);
    setSession({ state: "signed-out" });
  };

  const signedIn = session.state === "signed-in";

  return (
    <div className="app">
      <div className="backdrop" aria-hidden />
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#" onClick={() => goTo("live")}>
            <LogoMark />
            <span className="brand-name">
              Trench<span>Scanner</span>
            </span>
          </a>
          {signedIn && (
            <nav className="tabs" role="tablist">
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? "on" : ""}
                  onClick={() => goTo(id)}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="topbar-right">
            <WorkerStatus />
            {signedIn && (
              <button className="wallet-pill" onClick={signOut} title="Sign out">
                <span className="wallet-dot" />
                {session.user.isAdmin && <span className="admin-tag">admin</span>}
                <span className="num">{shortAddress(session.user.walletAddress)}</span>
                <LogoutIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="content">
        {session.state === "loading" && (
          <div className="boot">
            <LogoMark size={40} />
          </div>
        )}
        {session.state === "signed-out" && (
          <SignIn onSignedIn={(user) => setSession({ state: "signed-in", user })} />
        )}
        {signedIn && (
          <AccessGate>
            <div className="tab-view" key={tab}>
              {tab === "live" && <LiveTab goTo={goTo} />}
              {tab === "model" && <ModelTab />}
              {tab === "filters" && <FiltersTab />}
            </div>
          </AccessGate>
        )}
      </main>

      <footer className="site-foot faint small">
        Alerts are for research, not financial advice. Memecoins can go to zero in minutes.
      </footer>
    </div>
  );
}

/** A pill for the scanner's health, from the public worker heartbeat. */
function WorkerStatus() {
  const { data } = usePolling(() => api<WorkerHealth>("/health/worker"), 60_000);
  const scan = data?.jobs.find((j) => j.job === "scan");
  if (!data) return null;
  // Only the scan loop decides the pill: daily jobs (cleanup, outcome tracking) read as stale for
  // most of the day by design, and the user is asking "is it finding tokens right now".
  const bad = !scan || scan.stale || scan.hung;
  return (
    <span
      className={`status-pill ${bad ? "warn" : "ok"}`}
      title={data.jobs.map((j) => `${j.job}: ${ago(j.lastSuccessAt)}`).join("\n")}
    >
      <span className="pulse" />
      {bad ? "Scanner lagging" : "Scanning"}
      {scan && <span className="faint"> · {ago(scan.lastSuccessAt)}</span>}
    </span>
  );
}

/** Feed routes answer 402 without a subscription; show that instead of three broken tabs. */
function AccessGate({ children }: { children: React.ReactNode }) {
  const { data, error } = usePolling(() => api<Subscription>("/subscription"), 300_000);
  if (error && !data) {
    return <p className="error center">Couldn't check your access: {error.message}</p>;
  }
  if (!data)
    return (
      <div className="boot">
        <LogoMark size={40} />
      </div>
    );
  if (!data.hasAccess) {
    return (
      <section className="panel paywall">
        <span className="paywall-icon">
          <ShieldIcon size={26} />
        </span>
        <h2>Subscription needed</h2>
        <p className="muted">
          {data.expiresAt
            ? `Your access ended ${ago(data.expiresAt)}.`
            : "This wallet has no active subscription."}{" "}
          Subscribe by burning on the HolDEX Trenches page, then come back. Access follows your wallet.
        </p>
        <a className="button primary" href="https://holdex.live/trenches/" target="_blank" rel="noreferrer">
          Subscribe on HolDEX
        </a>
      </section>
    );
  }
  return <>{children}</>;
}

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

function SignIn({ onSignedIn }: { onSignedIn: (u: User) => void }) {
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
