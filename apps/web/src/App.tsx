import { useEffect, useState } from "react";
import type { Wallet } from "@wallet-standard/base";
import { api, post, ApiError, type Subscription, type User, type WorkerHealth } from "./api";
import { onWalletsChanged, signInWithWallet, solanaWallets } from "./wallet";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import { ModelTab } from "./tabs/ModelTab";
import { FiltersTab } from "./tabs/FiltersTab";

type Tab = "live" | "model" | "filters";

const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "model", label: "Model & AI" },
  { id: "filters", label: "Filters" },
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
  };

  const signOut = async () => {
    await post("/auth/logout").catch(() => undefined);
    setSession({ state: "signed-out" });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◎
          </span>
          <span>TrenchScanner</span>
        </div>
        {session.state === "signed-in" && (
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "on" : ""}
                onClick={() => goTo(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <div className="topbar-right">
          <WorkerStatus />
          {session.state === "signed-in" && (
            <button className="ghost" onClick={signOut} title="Sign out">
              {session.user.isAdmin && <span className="chip">admin</span>}{" "}
              {shortAddress(session.user.walletAddress)} ⏏
            </button>
          )}
        </div>
      </header>

      <main className="content">
        {session.state === "loading" && <p className="muted center">Loading…</p>}
        {session.state === "signed-out" && (
          <SignIn onSignedIn={(user) => setSession({ state: "signed-in", user })} />
        )}
        {session.state === "signed-in" && (
          <AccessGate>
            {tab === "live" && <LiveTab goTo={goTo} />}
            {tab === "model" && <ModelTab />}
            {tab === "filters" && <FiltersTab />}
          </AccessGate>
        )}
      </main>
    </div>
  );
}

/** A dot for the scanner's health, from the public worker heartbeat. */
function WorkerStatus() {
  const { data } = usePolling(() => api<WorkerHealth>("/health/worker"), 60_000);
  const scan = data?.jobs.find((j) => j.job === "scan");
  if (!data) return null;
  // Only the scan loop decides the dot: daily jobs (cleanup, outcome tracking) read as stale for
  // most of the day by design, and the user is asking "is it finding tokens right now".
  const bad = !scan || scan.stale || scan.hung;
  return (
    <span
      className={`status ${bad ? "warn" : "ok"}`}
      title={data.jobs.map((j) => `${j.job}: ${ago(j.lastSuccessAt)}`).join("\n")}
    >
      {bad ? "▲ Scanner lagging" : "● Scanning"}
      {scan && <small className="muted"> · {ago(scan.lastSuccessAt)}</small>}
    </span>
  );
}

/** Feed routes answer 402 without a subscription; show that instead of three broken tabs. */
function AccessGate({ children }: { children: React.ReactNode }) {
  const { data, error } = usePolling(() => api<Subscription>("/subscription"), 300_000);
  if (error && !data) {
    return <p className="error">Couldn't check your access: {error.message}</p>;
  }
  if (!data) return <p className="muted center">Checking access…</p>;
  if (!data.hasAccess) {
    return (
      <section className="panel narrow center-block">
        <h2>Subscription needed</h2>
        <p className="muted">
          {data.expiresAt
            ? `Your access ended ${ago(data.expiresAt)}.`
            : "This wallet has no active subscription."}{" "}
          Subscribe by burning on the HolDEX Trenches page, then come back here. Your access follows your
          wallet.
        </p>
        <a className="button primary" href="https://holdex.live/trenches/" target="_blank" rel="noreferrer">
          Subscribe on HolDEX
        </a>
      </section>
    );
  }
  return <>{children}</>;
}

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
        <h1>Pump.fun alerts, picked by a model that grades itself.</h1>
        <p className="muted">
          The scanner watches every new Solana memecoin. A curator, trained on what actually doubled, picks
          the few worth a look, and an AI reviewer gives each a buy or no-buy call. Every pick is graded in
          public against the goal: 2x on 75% of alerts, 4x on half.
        </p>
      </div>
      <div className="panel signin-box">
        <h2>Sign in with your wallet</h2>
        <p className="muted small">
          Signing proves you own the wallet. It costs nothing and sends no transaction.
        </p>
        {wallets.length === 0 ? (
          <p className="empty">
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
        ) : (
          <div className="wallets">
            {wallets.map((w) => (
              <button key={w.name} className="wallet" disabled={busy !== null} onClick={() => connect(w)}>
                <img src={w.icon} alt="" width={24} height={24} />
                {busy === w.name ? "Waiting for wallet…" : w.name}
              </button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
