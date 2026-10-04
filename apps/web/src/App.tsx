import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ApiError, post, type Subscription, type User, type WorkerHealth } from "./api";
import { cachedGet, invalidate, peek, prefetch } from "./cache";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import { BrainIcon, LogoMark, LogoutIcon, PulseIcon, ShieldIcon, SlidersIcon } from "./components/Icons";
import { TAB_DATA, loadFiltersTab, loadModelTab, loadSignIn, loaded, tabFromHash, type Tab } from "./routes";

// Only the Live tab ships in the first bundle. The others, and the wallet sign-in code (which a
// returning, signed-in visitor never needs), load on demand; main.tsx warms them once idle.
const LazyModelTab = lazy(() => loadModelTab().then((m) => ({ default: m.ModelTab })));
const LazyFiltersTab = lazy(() => loadFiltersTab().then((m) => ({ default: m.FiltersTab })));
const SignIn = lazy(() => loadSignIn().then((m) => ({ default: m.SignIn })));

const TABS: { id: Tab; label: string; Icon: typeof PulseIcon }[] = [
  { id: "live", label: "Live", Icon: PulseIcon },
  { id: "model", label: "Models", Icon: BrainIcon },
  { id: "filters", label: "Filters", Icon: SlidersIcon },
];

type Session = { state: "loading" } | { state: "signed-out" } | { state: "signed-in"; user: User };

export function App() {
  // A returning visitor starts signed in as last time (src/cache.ts keeps the answer), so their
  // feed paints at once; the check below signs them out if the session has since ended.
  const [session, setSession] = useState<Session>(() => {
    const user = peek<User>("/auth/me")?.data;
    return user ? { state: "signed-in", user } : { state: "loading" };
  });
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    // index.html already started this request; cachedGet adopts it rather than sending another.
    cachedGet<User>("/auth/me", 10_000)
      .then((user) => setSession({ state: "signed-in", user }))
      .catch((e: unknown) => {
        // Unreachable API with a remembered session: keep showing it (polling retries). A real
        // "not signed in" answer ends it and clears what this device kept.
        if (!(e instanceof ApiError) && peek<User>("/auth/me")) return;
        invalidate();
        setSession({ state: "signed-out" });
      });
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
    invalidate();
    setSession({ state: "signed-out" });
  };

  const signedIn = session.state === "signed-in";
  const ModelTab = loaded.model?.ModelTab ?? LazyModelTab;
  const FiltersTab = loaded.filters?.FiltersTab ?? LazyFiltersTab;

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
        {session.state === "loading" && <Boot />}
        {session.state === "signed-out" && (
          <Suspense fallback={<Boot />}>
            <SignIn
              onSignedIn={(user) => {
                // Anything cached while signed out (401s aside, e.g. /health/worker) is stale now.
                invalidate();
                setSession({ state: "signed-in", user });
              }}
            />
          </Suspense>
        )}
        {signedIn && (
          <AccessGate>
            <div className="tab-view" key={tab}>
              <Suspense fallback={<Boot />}>
                {tab === "live" && <LiveTab goTo={goTo} />}
                {tab === "model" && <ModelTab />}
                {tab === "filters" && <FiltersTab />}
              </Suspense>
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
  const { data } = usePolling<WorkerHealth>("/health/worker", 60_000);
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
  const { data, error } = usePolling<Subscription>("/subscription", 300_000);
  const hasAccess = data?.hasAccess === true;
  const warmed = useRef(false);
  useEffect(() => {
    if (!hasAccess || warmed.current) return;
    warmed.current = true;
    // Once the open tab has had its turn, fetch the other tabs' data too, so opening one paints
    // straight away (and refreshes behind) instead of showing skeletons while its calls run.
    const warm = () => {
      for (const t of Object.keys(TAB_DATA) as Tab[]) for (const p of TAB_DATA[t]) prefetch(p);
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 3000);
  }, [hasAccess]);
  if (error && !data) {
    return <p className="error center">Couldn't check your access: {error.message}</p>;
  }
  if (!data) return <Boot />;
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

function Boot() {
  return (
    <div className="boot">
      <LogoMark size={40} />
    </div>
  );
}
