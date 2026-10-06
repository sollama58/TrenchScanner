import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ApiError, post, type Subscription, type User, type WorkerHealth } from "./api";
import { cachedGet, invalidate, peek, prefetch } from "./cache";
import { setSessionToken } from "./session";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import {
  BrainIcon,
  ExternalIcon,
  GearIcon,
  LogoMark,
  LogoutIcon,
  PulseIcon,
  ShieldIcon,
  SlidersIcon,
} from "./components/Icons";
import {
  TAB_DATA,
  loadAdminTab,
  loadFiltersTab,
  loadModelTab,
  loadSettingsTab,
  loadSignIn,
  loaded,
  tabFromHash,
  type Tab,
} from "./routes";
import { AlertNotifier, resetSettings } from "./alerts";

// Only the Live tab ships in the first bundle. The others, and the wallet sign-in code (which a
// returning, signed-in visitor never needs), load on demand; main.tsx warms them once idle.
const LazyModelTab = lazy(() => loadModelTab().then((m) => ({ default: m.ModelTab })));
const LazyFiltersTab = lazy(() => loadFiltersTab().then((m) => ({ default: m.FiltersTab })));
const LazySettingsTab = lazy(() => loadSettingsTab().then((m) => ({ default: m.SettingsTab })));
const LazyAdminTab = lazy(() => loadAdminTab().then((m) => ({ default: m.AdminTab })));
const SignIn = lazy(() => loadSignIn().then((m) => ({ default: m.SignIn })));
// The burn button (and its transaction builder) only matters to someone without access.
const BurnPanel = lazy(() => import("./components/BurnPanel").then((m) => ({ default: m.BurnPanel })));

const TABS: { id: Tab; label: string; Icon: typeof PulseIcon }[] = [
  { id: "live", label: "Live", Icon: PulseIcon },
  { id: "model", label: "Models", Icon: BrainIcon },
  { id: "filters", label: "Filters", Icon: SlidersIcon },
  { id: "settings", label: "Settings", Icon: GearIcon },
];
/** Only shown to admin wallets; the /admin routes behind it check the wallet again server-side. */
const ADMIN_TAB = { id: "admin" as Tab, label: "Admin", Icon: ShieldIcon };

type Session =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "unreachable"; message: string }
  | { state: "signed-in"; user: User };

export function App() {
  // A returning visitor starts signed in as last time (src/cache.ts keeps the answer), so their
  // feed paints at once; the check below signs them out if the session has since ended.
  const [session, setSession] = useState<Session>(() => {
    const user = peek<User>("/auth/me")?.data;
    return user ? { state: "signed-in", user } : { state: "loading" };
  });
  const [wantedTab, setTab] = useState<Tab>(tabFromHash);

  const checkSession = (maxAgeMs: number) => {
    // index.html already started this request; cachedGet adopts it rather than sending another.
    cachedGet<User>("/auth/me", maxAgeMs)
      .then((user) => setSession({ state: "signed-in", user }))
      .catch((e: unknown) => {
        // Only a real "not signed in" answer ends the session and clears what this device kept.
        if (e instanceof ApiError && e.status === 401) {
          setSessionToken(null);
          invalidate();
          resetSettings();
          setSession({ state: "signed-out" });
          return;
        }
        // The API is down or restarting (a network error, a 502 or 503 during a deploy): a
        // remembered session keeps showing its saved data while polling retries. Without one,
        // say so rather than offering a sign-in that can't work right now.
        if (peek<User>("/auth/me")) return;
        setSession({
          state: "unreachable",
          message: e instanceof Error ? e.message : String(e),
        });
      });
  };

  useEffect(() => {
    checkSession(10_000);
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
    setSessionToken(null);
    invalidate();
    resetSettings();
    setSession({ state: "signed-out" });
  };

  const signedIn = session.state === "signed-in";
  const ModelTab = loaded.model?.ModelTab ?? LazyModelTab;
  const FiltersTab = loaded.filters?.FiltersTab ?? LazyFiltersTab;
  const SettingsTab = loaded.settings?.SettingsTab ?? LazySettingsTab;
  const AdminTab = loaded.admin?.AdminTab ?? LazyAdminTab;
  const isAdmin = signedIn && session.user.isAdmin;
  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : TABS;
  // #admin without an admin wallet reads as the Live tab, so a tab is always the highlighted one.
  const tab: Tab = wantedTab === "admin" && !isAdmin ? "live" : wantedTab;

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
              {tabs.map(({ id, label, Icon }) => (
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
              {/* A link out to HolDEX, not a tab of this app: it opens in a new browser tab. */}
              <a
                className="button tab-link"
                href="https://holdex.live"
                target="_blank"
                rel="noopener noreferrer"
                title="Open HolDEX in a new tab"
              >
                <ExternalIcon size={15} />
                <span>HolDEX</span>
              </a>
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
        {session.state === "unreachable" && (
          <section className="panel paywall">
            <h2>Can&apos;t reach TrenchScanner</h2>
            <p className="muted">
              The server didn&apos;t answer ({session.message}). It may be restarting; try again in a moment.
            </p>
            <button
              className="button primary"
              onClick={() => {
                // The boot requests failed with the rest; drop them so every view asks again.
                invalidate();
                setSession({ state: "loading" });
                checkSession(-1);
              }}
            >
              Try again
            </button>
          </section>
        )}
        {session.state === "signed-out" && (
          <Suspense fallback={<Boot />}>
            <SignIn
              onSignedIn={(user) => {
                // Anything cached while signed out (401s aside, e.g. /health/worker) is stale now.
                invalidate();
                resetSettings();
                setSession({ state: "signed-in", user });
              }}
            />
          </Suspense>
        )}
        {signedIn && (
          <AccessGate walletAddress={session.user.walletAddress} onSignedOut={signOut}>
            <AlertNotifier />
            <div className="tab-view" key={tab}>
              <Suspense fallback={<Boot />}>
                {tab === "live" && <LiveTab goTo={goTo} />}
                {tab === "model" && <ModelTab />}
                {tab === "filters" && <FiltersTab />}
                {tab === "settings" && <SettingsTab goTo={goTo} />}
                {tab === "admin" && <AdminTab goTo={goTo} />}
              </Suspense>
            </div>
          </AccessGate>
        )}
      </main>

      <footer className="site-foot faint small">
        Alerts are for research, not financial advice. Memecoins can go to zero in minutes.
        {" | "}
        <a href="https://alonisthe.dev" target="_blank" rel="noopener noreferrer">
          alonisthe.dev
        </a>
        <div className="donation">Donation Wallet: 2wWTXhva24dQHoKRJzXAV98q8KeWL9oTRc3M7aLpvhaA</div>
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
      role="status"
      aria-label={bad ? "Scanner lagging" : "Scanning"}
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
function AccessGate({
  children,
  walletAddress,
  onSignedOut,
}: {
  children: React.ReactNode;
  walletAddress: string;
  onSignedOut: () => void;
}) {
  const { data, error, reload } = usePolling<Subscription>("/subscription", 300_000);
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
    // Signed in a moment ago but the API no longer knows us: the session didn't stick.
    if (error instanceof ApiError && error.status === 401)
      return (
        <section className="panel paywall">
          <h2>Your session ended</h2>
          <p className="muted">
            This browser didn't keep the sign-in. Sign in again; if it keeps happening, allow cookies for this
            site or set tracking prevention to Balanced.
          </p>
          <button className="button primary" onClick={onSignedOut}>
            Sign in again
          </button>
        </section>
      );
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
          Burn $ASDFASDFA below to subscribe. Access follows your wallet.
        </p>
        <Suspense fallback={<p className="muted small">Loading…</p>}>
          <BurnPanel walletAddress={walletAddress} onCredited={reload} />
        </Suspense>
        <p className="faint small">
          You can also burn on the{" "}
          <a href="https://holdex.live/trenches/" target="_blank" rel="noreferrer">
            HolDEX Trenches page
          </a>
          ; it counts the same.
        </p>
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
