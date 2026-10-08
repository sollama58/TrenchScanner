import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ApiError, post, type Subscription, type User, type WorkerHealth } from "./api";
import { cachedGet, invalidate, peek, prefetch } from "./cache";
import { GUEST_DELAY_MINUTES, isGuest, setGuest, setSessionToken } from "./session";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import { GuestLiveTab } from "./tabs/GuestLiveTab";
import {
  BrainIcon,
  ExternalIcon,
  GearIcon,
  LighthouseIcon,
  LogoMark,
  LockIcon,
  LogoutIcon,
  PhoneIcon,
  PulseIcon,
  ShieldIcon,
  SlidersIcon,
} from "./components/Icons";
import {
  TAB_DATA,
  loadAdminTab,
  loadFiltersTab,
  loadLighthouseTab,
  loadModelTab,
  loadSettingsTab,
  loadSignIn,
  loaded,
  tabFromHash,
  type Tab,
} from "./routes";
import { AlertNotifier, resetSettings } from "./alerts";
import { AnnouncementBar } from "./components/AnnouncementBar";
import { hasPendingLink, redeemLinkCode, takeLinkCode } from "./deviceLink";
import { useSageMint } from "./sage";

// Only the Live tab ships in the first bundle. The others, and the wallet sign-in code (which a
// returning, signed-in visitor never needs), load on demand; main.tsx warms them once idle.
const LazyModelTab = lazy(() => loadModelTab().then((m) => ({ default: m.ModelTab })));
const LazyLighthouseTab = lazy(() => loadLighthouseTab().then((m) => ({ default: m.LighthouseTab })));
const LazyFiltersTab = lazy(() => loadFiltersTab().then((m) => ({ default: m.FiltersTab })));
const LazySettingsTab = lazy(() => loadSettingsTab().then((m) => ({ default: m.SettingsTab })));
const LazyAdminTab = lazy(() => loadAdminTab().then((m) => ({ default: m.AdminTab })));
const SignIn = lazy(() => loadSignIn().then((m) => ({ default: m.SignIn })));
// The burn button (and its transaction builder) only matters to someone without access.
// The TokenSage view (and its charts) loads the first time a card or a Telegram link opens one.
const SageHost = lazy(() => import("./components/SageView").then((m) => ({ default: m.SageHost })));
const BurnPanel = lazy(() => import("./components/BurnPanel").then((m) => ({ default: m.BurnPanel })));

const TABS: { id: Tab; label: string; Icon: typeof PulseIcon }[] = [
  { id: "live", label: "Live", Icon: PulseIcon },
  // Filters sits right after Live: it is where the feed is tuned and where alerts are set up.
  { id: "filters", label: "Filters", Icon: SlidersIcon },
  { id: "model", label: "Models", Icon: BrainIcon },
  { id: "lighthouse", label: "Lighthouse", Icon: LighthouseIcon },
  { id: "settings", label: "Settings", Icon: GearIcon },
];
/** Only shown to admin wallets; the /admin routes behind it check the wallet again server-side. */
const ADMIN_TAB = { id: "admin" as Tab, label: "Admin", Icon: ShieldIcon };

type Session =
  | { state: "loading" }
  | { state: "signed-out" }
  /** Looking around without a wallet: the default model's feed, everything else locked. */
  | { state: "guest" }
  | { state: "unreachable"; message: string }
  /** Opened from a desktop's pairing QR: redeeming the code, or saying why it didn't work. */
  | { state: "linking"; error?: string }
  | { state: "signed-in"; user: User };

export function App() {
  // A returning visitor starts signed in as last time (src/cache.ts keeps the answer), so their
  // feed paints at once; the check below signs them out if the session has since ended.
  const [session, setSession] = useState<Session>(() => {
    // A pairing link wins over whatever this browser remembered: scanning is asking to sign in.
    if (hasPendingLink()) return { state: "linking" };
    const user = peek<User>("/auth/me")?.data;
    if (user) return { state: "signed-in", user };
    return isGuest() ? { state: "guest" } : { state: "loading" };
  });
  const [wantedTab, setTab] = useState<Tab>(tabFromHash);
  const sageMint = useSageMint();

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
    // takeLinkCode hands the code out once, so StrictMode's second run finds nothing to redeem
    // (and, still "linking", checks no session either).
    const linkCode = takeLinkCode();
    if (linkCode !== undefined) redeem(linkCode);
    // A guest has no session to check: asking would only fetch a 401.
    else if (session.state !== "guest" && session.state !== "linking") checkSession(10_000);
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** Phone side of pairing: the code from the desktop's QR becomes this phone's own session. */
  const redeem = (code: string | null) => {
    const failed =
      "This QR code has expired or was already used. On your desktop, open Settings, press " +
      '"Show QR code" and scan the new one.';
    if (code === null) {
      setSession({ state: "linking", error: failed });
      return;
    }
    redeemLinkCode(code)
      .then((user) => {
        setGuest(false);
        invalidate();
        resetSettings();
        setSession({ state: "signed-in", user });
      })
      .catch((e: unknown) => {
        setSession({
          state: "linking",
          // Every refusal from the API reads the same (expired, used or wrong); anything else is
          // the network or a blocked cookie, whose own message says more.
          error:
            e instanceof ApiError && e.status === 400 ? failed : e instanceof Error ? e.message : String(e),
        });
      });
  };

  /** Out of a failed pairing: whatever this browser was before, or the sign-in page. */
  const leaveLinking = () => {
    if (isGuest()) {
      setSession({ state: "guest" });
      return;
    }
    setSession({ state: "loading" });
    checkSession(-1);
  };

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

  const enterGuest = () => {
    setGuest(true);
    invalidate();
    resetSettings();
    setSession({ state: "guest" });
    // On a phone the guest button sits below the fold; the feed should open at its top.
    window.scrollTo({ top: 0 });
  };

  /** From guest mode to the wallet sign-in page. */
  const connectWallet = () => {
    setGuest(false);
    invalidate();
    setSession({ state: "signed-out" });
    window.scrollTo({ top: 0 });
  };

  const signedIn = session.state === "signed-in";
  const guest = session.state === "guest";
  const ModelTab = loaded.model?.ModelTab ?? LazyModelTab;
  const LighthouseTab = loaded.lighthouse?.LighthouseTab ?? LazyLighthouseTab;
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
          {guest && (
            <nav className="tabs" role="tablist">
              {TABS.map(({ id, label, Icon }) => {
                // Live, Models and the Lighthouse work read-only without a wallet; the rest are
                // saved to one.
                const locked = id !== "live" && id !== "model" && id !== "lighthouse";
                return (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    aria-disabled={locked || undefined}
                    className={`${tab === id ? "on" : ""}${locked ? " locked" : ""}`}
                    title={locked ? `Connect a wallet to use ${label}` : undefined}
                    onClick={() => goTo(id)}
                  >
                    {locked ? <LockIcon size={13} /> : <Icon size={15} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>
          )}
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
            {guest && (
              <button className="button primary connect-btn" onClick={connectWallet}>
                Connect wallet
              </button>
            )}
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
        {/* The Admin tab's broadcast: for everyone, signed in, guest or signed out. */}
        {session.state !== "linking" && <AnnouncementBar />}
        {session.state === "loading" && <Boot />}
        {session.state === "linking" &&
          (session.error ? (
            <section className="panel paywall" role="alert">
              <span className="paywall-icon">
                <PhoneIcon size={26} />
              </span>
              <h2>Couldn&apos;t sign this phone in</h2>
              <p className="muted">{session.error}</p>
              <button className="button primary" onClick={leaveLinking}>
                Continue
              </button>
            </section>
          ) : (
            <section className="panel paywall" aria-busy>
              <span className="paywall-icon">
                <PhoneIcon size={26} />
              </span>
              <h2>Signing this phone in…</h2>
              <p className="muted">Pairing with your desktop session.</p>
            </section>
          ))}
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
              onGuest={enterGuest}
              onSignedIn={(user) => {
                // Anything cached while signed out (401s aside, e.g. /health/worker) is stale now.
                setGuest(false);
                invalidate();
                resetSettings();
                setSession({ state: "signed-in", user });
              }}
            />
          </Suspense>
        )}
        {guest && (
          <div className="tab-view" key={tab}>
            {tab === "live" ? (
              <GuestLiveTab onConnect={connectWallet} />
            ) : tab === "model" ? (
              <Suspense fallback={<Boot />}>
                <ModelTab guest />
              </Suspense>
            ) : tab === "lighthouse" ? (
              <Suspense fallback={<Boot />}>
                <LighthouseTab guest />
              </Suspense>
            ) : (
              <GuestLocked
                label={TABS.find((t) => t.id === tab)?.label ?? "this"}
                onConnect={connectWallet}
              />
            )}
          </div>
        )}
        {guest && sageMint && (
          <Suspense fallback={null}>
            <SageHost key={sageMint} mint={sageMint} guest onConnect={connectWallet} />
          </Suspense>
        )}
        {signedIn && (
          <AccessGate walletAddress={session.user.walletAddress} onSignedOut={signOut}>
            <AlertNotifier />
            <div className="tab-view" key={tab}>
              <Suspense fallback={<Boot />}>
                {tab === "live" && <LiveTab goTo={goTo} />}
                {tab === "model" && <ModelTab />}
                {tab === "lighthouse" && <LighthouseTab />}
                {tab === "filters" && <FiltersTab goTo={goTo} />}
                {tab === "settings" && <SettingsTab goTo={goTo} />}
                {tab === "admin" && <AdminTab goTo={goTo} />}
              </Suspense>
            </div>
            {sageMint && (
              <Suspense fallback={null}>
                <SageHost key={sageMint} mint={sageMint} guest={false} onConnect={connectWallet} />
              </Suspense>
            )}
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
/** Past this, a stage that normally produces every few minutes reads as stalled in the tooltip. */
const STAGE_STALE_MS = 15 * 60_000;

/** "42s ago", "12m 5s ago", "3h 10m ago": finer than ago(), since a stall is minutes long. */
function since(iso: string | null | undefined, now: number): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function WorkerStatus() {
  const { data } = usePolling<WorkerHealth>("/health/worker", 30_000);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  // The ages count up live while the tooltip is showing.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);
  const scan = data?.jobs.find((j) => j.job === "scan");
  if (!data) return null;
  // Only the scan loop decides the pill: daily jobs (cleanup, outcome tracking) read as stale for
  // most of the day by design, and the user is asking "is it finding tokens right now".
  const bad = !scan || scan.stale || scan.hung;
  const p = data.pipeline;
  const stages = p
    ? [
        { label: "Last alert by any model", at: p.lastAlertAt },
        { label: "Last token passed pre-check", at: p.lastPreCheckPassAt },
        { label: "Last token back from TokenSage", at: p.lastTokenSageAt },
        { label: "Last token considered by any model", at: p.lastDecisionAt },
      ]
    : [];
  return (
    <span
      className="status-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span
        role="status"
        tabIndex={0}
        aria-label={bad ? "Scanner lagging" : "Scanning"}
        aria-describedby="status-tip"
        className={`status-pill ${bad ? "warn" : "ok"}`}
      >
        <span className="pulse" />
        {bad ? "Scanner lagging" : "Scanning"}
        {scan && <span className="faint"> · {ago(scan.lastSuccessAt)}</span>}
      </span>
      <span id="status-tip" role="tooltip" className={`status-tip${open ? " open" : ""}`}>
        {stages.length > 0 && (
          <>
            <span className="status-tip-head">Alert pipeline</span>
            {stages.map((st) => {
              const late = !st.at || now - new Date(st.at).getTime() > STAGE_STALE_MS;
              return (
                <span key={st.label} className="status-tip-row">
                  <span className={`status-tip-dot ${late ? "warn" : "ok"}`} />
                  <span className="status-tip-label">{st.label}</span>
                  <span className={`status-tip-val num${late ? " warn" : ""}`}>{since(st.at, now)}</span>
                </span>
              );
            })}
          </>
        )}
        <span className="status-tip-head">Jobs</span>
        {data.jobs.map((j) => {
          const late = j.stale || j.hung;
          return (
            <span key={j.job} className="status-tip-row">
              <span className={`status-tip-dot ${late ? "warn" : "ok"}`} />
              <span className="status-tip-label">{j.job}</span>
              <span className={`status-tip-val num${late ? " warn" : ""}`}>
                {j.hung ? "running too long" : since(j.lastSuccessAt, now)}
              </span>
            </span>
          );
        })}
      </span>
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

/** What a guest sees on a tab that needs a wallet, in place of the tab. */
function GuestLocked({ label, onConnect }: { label: string; onConnect: () => void }) {
  return (
    <section className="panel paywall">
      <span className="paywall-icon">
        <LockIcon size={24} />
      </span>
      <h2>Connect a wallet to use {label}</h2>
      <p className="muted">
        You&apos;re in guest mode: the Live tab shows the recommended model&apos;s calls {GUEST_DELAY_MINUTES}{" "}
        minutes late, and the Models tab shows how every model is doing. Your own filters, model picks, alerts
        and settings are saved to your wallet.
      </p>
      <button className="button primary" onClick={onConnect}>
        Connect wallet
      </button>
    </section>
  );
}

function Boot() {
  return (
    <div className="boot">
      <LogoMark size={40} />
    </div>
  );
}
