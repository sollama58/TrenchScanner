import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ACCESS_ENDED_EVENT, ApiError, post, type Subscription, type User } from "./api";
import { cachedGet, invalidate, peek, prefetch } from "./cache";
import { GUEST_DELAY_MINUTES, isGuest, setGuest, setSessionToken } from "./session";
import { usePolling } from "./hooks";
import { ago, shortAddress } from "./format";
import { LiveTab } from "./tabs/LiveTab";
import { GuestLiveTab } from "./tabs/GuestLiveTab";
import {
  BookIcon,
  BrainIcon,
  FlameIcon,
  GearIcon,
  LighthouseIcon,
  ToolsIcon,
  LogoMark,
  LockIcon,
  LogoutIcon,
  PhoneIcon,
  PulseIcon,
  ShieldIcon,
  SlidersIcon,
  StreamIcon,
  WalletIcon,
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
import { currentSignIn, hasPendingLink, mayReplaceSignIn, redeemLinkCode, takeLinkCode } from "./deviceLink";
import { useSageMint } from "./sage";
import { useWalletAddress } from "./walletModal";
import { PageLoader } from "./components/PageLoader";
import { beginWait, markNavigation } from "./loadTracker";
import { StreamView } from "./components/StreamView";
import { useAppearance } from "./appearance";
import { TokenModalHost } from "./components/TokenModalHost";
import { closeTokenModal } from "./tokenModal";
import { setProState, proStateOf } from "./proTrade";
import { ProGraceBanner } from "./components/ProGraceBanner";
import { BugButton } from "./components/BugButton";
import { AdminReportsBadge } from "./components/AdminReportsBadge";
import { TwoFactorPromptHost } from "./components/TwoFactorPrompt";
import { setMe } from "./me";
import { clearPasses } from "./twoFactor";
import { loadedPrivyControls, privyConfig, usePrivyWanted, wantPrivy } from "./privyBridge";

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
// Utilities: its own chunk, loaded the first time the tab opens.
const UtilitiesTab = lazy(() => import("./tabs/UtilitiesTab").then((m) => ({ default: m.UtilitiesTab })));
// Portfolio: its own chunk too.
const PortfolioTab = lazy(() => import("./tabs/PortfolioTab").then((m) => ({ default: m.PortfolioTab })));
// The wallet detail modal loads the first time a wallet or a ?wallet= link opens it.
const WalletModalHost = lazy(() =>
  import("./components/WalletModal").then((m) => ({ default: m.WalletModalHost })),
);
// The pull-out utility panel on every tab (desktop only): loads once signed in with access.
const TradesDrawer = lazy(() =>
  import("./components/TradesDrawer").then((m) => ({ default: m.TradesDrawer })),
);
const UtilityDrawer = lazy(() =>
  import("./components/UtilityDrawer").then((m) => ({ default: m.UtilityDrawer })),
);
const BurnPanel = lazy(() => import("./components/BurnPanel").then((m) => ({ default: m.BurnPanel })));
const PrivyWalletPanel = lazy(() =>
  import("./components/PrivyWalletPanel").then((m) => ({ default: m.PrivyWalletPanel })),
);
const AccessBuy = lazy(() => import("./components/AccessBuy").then((m) => ({ default: m.AccessBuy })));
// Privy (email sign-in): only for someone choosing it, or already signed in with it.
const PrivyRoot = lazy(() => import("./privy"));

const TABS: { id: Tab; label: string; Icon: typeof PulseIcon }[] = [
  { id: "live", label: "Live", Icon: PulseIcon },
  // Hidden unless switched on in Settings (FeedAppearance.streamTab); see shownTabs below.
  { id: "stream", label: "Stream", Icon: StreamIcon },
  // Filters sits right after Live: it is where the feed is tuned and where alerts are set up.
  { id: "filters", label: "Filters", Icon: SlidersIcon },
  { id: "model", label: "Models", Icon: BrainIcon },
  // Shown unless switched off in Settings (FeedAppearance.hideLighthouseTab); #lighthouse links still open it.
  { id: "lighthouse", label: "Lighthouse", Icon: LighthouseIcon },
  // Lookups paid for with Burn Credits, on top of a subscription.
  { id: "utilities", label: "Utilities", Icon: ToolsIcon },
  // Pro Mode only (see portfolioOn below): the wallet's own holdings, positions, trades and alerts.
  { id: "portfolio", label: "Portfolio", Icon: WalletIcon },
  { id: "settings", label: "Settings", Icon: GearIcon },
];
/** Only shown to admin wallets; the /admin routes behind it check the wallet again server-side. */
const ADMIN_TAB = { id: "admin" as Tab, label: "Admin", Icon: ShieldIcon };
/** The open tab's view, which the selected tab button controls. */
const TAB_PANEL_ID = "tab-panel";

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
  const walletAddress = useWalletAddress();

  const checkSession = (maxAgeMs: number) => {
    // index.html already started this request; cachedGet adopts it rather than sending another.
    cachedGet<User>("/auth/me", maxAgeMs)
      .then((user) => setSession({ state: "signed-in", user }))
      .catch((e: unknown) => {
        // Only a real "not signed in" answer ends the session and clears what this device kept.
        if (e instanceof ApiError && e.status === 401) {
          setSessionToken(null);
          clearPasses();
          invalidate();
          resetSettings();
          // The open token view is above the feed, so it would outlive the session it was read in.
          closeTokenModal();
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
    // Someone already signed in here is asked before the link swaps them for the paired account;
    // saying no keeps their sign-in and drops the code unredeemed.
    currentSignIn()
      .then((current) => {
        if (!mayReplaceSignIn(current, (q) => window.confirm(q))) {
          leaveLinking();
          return null;
        }
        return redeemLinkCode(code);
      })
      .then((user) => {
        if (!user) return;
        setGuest(false);
        invalidate();
        resetSettings();
        closeTokenModal();
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
    // Privy's own session too, so the next email sign-in asks again (only if it's loaded).
    await loadedPrivyControls()
      ?.logout()
      .catch(() => undefined);
    clearPasses();
    setSessionToken(null);
    invalidate();
    resetSettings();
    closeTokenModal();
    // The form is lazy-loaded; this fetches the same chunk the bug button does.
    void import("./components/BugReportDialog").then((m) => m.clearBugReportDraft()).catch(() => undefined);
    setSession({ state: "signed-out" });
  };

  const enterGuest = () => {
    setGuest(true);
    invalidate();
    resetSettings();
    closeTokenModal();
    setSession({ state: "guest" });
    // On a phone the guest button sits below the fold; the feed should open at its top.
    window.scrollTo({ top: 0 });
  };

  /** From guest mode to the wallet sign-in page. */
  const connectWallet = () => {
    setGuest(false);
    invalidate();
    closeTokenModal();
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
  // Every render, like setProState: panels deep in a tab read the user from here (me.ts).
  useEffect(() => setMe(signedIn ? session.user : null));
  // A Privy account's wallet lives in Privy's code: load it so burns and trades can sign.
  const privyAccount = signedIn && session.user.signInMethod === "privy";
  useEffect(() => {
    if (privyAccount) wantPrivy();
  }, [privyAccount]);
  const privyWanted = usePrivyWanted();
  const [privyAppId, setPrivyAppId] = useState<string | null>(null);
  useEffect(() => {
    if (!privyWanted) return;
    void privyConfig().then((c) => setPrivyAppId(c.enabled && c.appId ? c.appId : null));
  }, [privyWanted]);
  // Pro Mode, for the token modal's Trade panel (null hides all of it).
  const pro = signedIn ? proStateOf(session.user) : null;
  // Every render: setProState ignores a state equal to the one it has.
  useEffect(() => setProState(pro));
  // In a grace period, the session is re-read every few minutes: back in the top 250, the
  // warnings go; out of time, the panel turns to selling only.
  const inGrace = pro?.graceEndsAt != null;
  useEffect(() => {
    if (!inGrace) return;
    const timer = setInterval(() => checkSession(0), 5 * 60_000);
    return () => clearInterval(timer);
  }, [inGrace]);
  // The Stream tab only for a signed-in reader who switched it on in Settings.
  const appearance = useAppearance();
  const streamOn = appearance.streamTab && signedIn;
  // The Lighthouse tab unless switched off, or while the reader is on it (a #lighthouse URL), so the
  // open page always has its tab highlighted.
  const lighthouseOn = !appearance.hideLighthouseTab || wantedTab === "lighthouse";
  // The Portfolio tab only for Pro Mode wallets (user decision 2026-10-18).
  const portfolioOn = !!pro?.pro;
  const shownTabs = TABS.filter(
    (t) =>
      (t.id !== "stream" || streamOn) &&
      (t.id !== "lighthouse" || lighthouseOn) &&
      (t.id !== "portfolio" || portfolioOn),
  );
  const tabs = isAdmin ? [...shownTabs, ADMIN_TAB] : shownTabs;
  // #admin without an admin wallet, or #stream with the tab off, reads as the Live tab, so a tab
  // is always the highlighted one.
  const tab: Tab =
    (wantedTab === "admin" && !isAdmin) ||
    (wantedTab === "stream" && !streamOn) ||
    (wantedTab === "portfolio" && !portfolioOn)
      ? "live"
      : wantedTab;
  // A new tab, or signing in or out, is a new page: its load gets the full loader.
  useEffect(markNavigation, [tab, session.state]);
  const loaderLabel =
    session.state === "signed-in" || session.state === "guest"
      ? `Loading ${tabs.find((t) => t.id === tab)?.label ?? "TrenchScanner"}`
      : "Loading TrenchScanner";
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? (tab === "admin" ? ADMIN_TAB.label : "");
  // The tab bar's button for this view, when it shows one (a hidden Lighthouse tab opened from a
  // link has none): it names the tab panel.
  const tabButtonShown = (guest ? shownTabs : tabs).some((t) => t.id === tab);
  const panelProps = {
    role: "tabpanel",
    id: TAB_PANEL_ID,
    ...(tabButtonShown ? { "aria-labelledby": `tab-${tab}` } : { "aria-label": tabLabel }),
  };
  // One <h1> per view, for screen readers and outlines; the design shows the brand and the tab bar
  // instead. The sign-in page and the Utilities tab have their own visible one.
  const heading =
    session.state === "signed-out" || (signedIn && tab === "utilities")
      ? null
      : guest || signedIn
        ? `TrenchScanner: ${tabLabel}`
        : "TrenchScanner";

  return (
    <div className="app">
      <div className="backdrop" aria-hidden />
      <header className={`topbar${streamOn && lighthouseOn ? " packed" : ""}`}>
        <div className="topbar-inner">
          <a className="brand" href="#" onClick={() => goTo("live")}>
            <LogoMark />
            <span className="brand-name">
              Trench<span>Scanner</span>
            </span>
          </a>
          {guest && (
            <nav className="tabs" role="tablist" aria-label="Sections">
              {shownTabs.map(({ id, label, Icon }) => {
                // Live, Models and the Lighthouse work read-only without a wallet; the rest are
                // saved to one.
                const locked = id !== "live" && id !== "model" && id !== "lighthouse";
                return (
                  <button
                    key={id}
                    id={`tab-${id}`}
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={tab === id ? TAB_PANEL_ID : undefined}
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
            <nav className="tabs" aria-label="Sections">
              {/* The tablist wrapper uses display: contents, so its buttons lay out as the bar's own. */}
              <div className="tablist" role="tablist">
                {tabs.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    id={`tab-${id}`}
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={tab === id ? TAB_PANEL_ID : undefined}
                    className={tab === id ? "on" : ""}
                    onClick={() => goTo(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                    {id === "admin" && <AdminReportsBadge />}
                  </button>
                ))}
              </div>
            </nav>
          )}
          <div className="topbar-right">
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
        {heading && <h1 className="sr-only">{heading}</h1>}
        <PageLoader label={loaderLabel} />
        {/* The Admin tab's broadcast: for everyone, signed in, guest or signed out. */}
        {session.state !== "linking" && <AnnouncementBar />}
        {signedIn && <ProGraceBanner />}
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
          <div className="tab-view" key={tab} {...panelProps}>
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
        {guest && walletAddress && (
          <Suspense fallback={null}>
            <WalletModalHost key={walletAddress} wallet={walletAddress} guest onConnect={connectWallet} />
          </Suspense>
        )}
        {signedIn && (
          <AccessGate walletAddress={session.user.walletAddress} onSignedOut={signOut}>
            <AlertNotifier />
            <div className="tab-view" key={tab} {...panelProps}>
              <Suspense fallback={<Boot />}>
                {tab === "live" && (
                  <LiveTab goTo={goTo} walletAddress={session.user.walletAddress} isAdmin={isAdmin} />
                )}
                {tab === "stream" && <StreamView isAdmin={isAdmin} />}
                {tab === "model" && <ModelTab />}
                {tab === "lighthouse" && <LighthouseTab />}
                {tab === "filters" && <FiltersTab goTo={goTo} />}
                {tab === "utilities" && <UtilitiesTab walletAddress={session.user.walletAddress} />}
                {tab === "portfolio" && <PortfolioTab goTo={goTo} />}
                {tab === "settings" && <SettingsTab goTo={goTo} />}
                {tab === "admin" && <AdminTab goTo={goTo} />}
              </Suspense>
            </div>
            {/* Pro Mode's TRADES panel, above the Utility handle on every tab. */}
            {pro?.pro && (
              <Suspense fallback={null}>
                <TradesDrawer key={pro.wallet} />
              </Suspense>
            )}
            {/* The Utilities tab has the same tools, with its own toolbar beside them. */}
            {tab !== "utilities" && (
              <Suspense fallback={null}>
                <UtilityDrawer walletAddress={session.user.walletAddress} onMore={() => goTo("utilities")} />
              </Suspense>
            )}
            {sageMint && (
              <Suspense fallback={null}>
                <SageHost key={sageMint} mint={sageMint} guest={false} onConnect={connectWallet} />
              </Suspense>
            )}
            {walletAddress && (
              <Suspense fallback={null}>
                <WalletModalHost
                  key={walletAddress}
                  wallet={walletAddress}
                  guest={false}
                  onConnect={connectWallet}
                />
              </Suspense>
            )}
          </AccessGate>
        )}
      </main>

      <footer className="site-foot faint small">
        <span>Alerts are for research, not financial advice. Memecoins can go to zero in minutes.</span>
        {/* Links out, each opening in a new browser tab. */}
        <span className="foot-links">
          <a
            className="foot-link"
            href="https://holdex.live"
            target="_blank"
            rel="noopener noreferrer"
            title="Open HolDEX in a new tab"
          >
            <BookIcon size={13} />
            <span>HolDEX</span>
          </a>
          <a
            className="foot-link"
            href="https://alonisthe.dev"
            target="_blank"
            rel="noopener noreferrer"
            title="Open alonisthe.dev in a new tab"
          >
            <FlameIcon size={13} />
            <span>alonisthe.dev</span>
          </a>
        </span>
      </footer>
      <TokenModalHost />
      <TwoFactorPromptHost />
      {privyAppId && (
        <Suspense fallback={null}>
          <PrivyRoot appId={privyAppId} />
        </Suspense>
      )}
      {/* On every screen, signed in or not: bug reports and suggestions, read in Admin > Reports. */}
      <BugButton
        tab={signedIn || guest ? tab : session.state}
        signedIn={signedIn}
        guest={guest}
        walletAddress={signedIn ? session.user.walletAddress : null}
      />
    </div>
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
  // A finished access buy remounts the burn panel, so it reads the new balance at once.
  const [buys, setBuys] = useState(0);
  const hasAccess = data?.hasAccess === true;
  // A gated route said access has ended (api.ts): look again now rather than at the next poll,
  // so the paywall replaces the failing tabs. At most every 10 s, as every open tab's poll says so.
  const lastRecheck = useRef(0);
  useEffect(() => {
    const recheck = () => {
      if (Date.now() - lastRecheck.current < 10_000) return;
      lastRecheck.current = Date.now();
      reload();
    };
    window.addEventListener(ACCESS_ENDED_EVENT, recheck);
    return () => window.removeEventListener(ACCESS_ENDED_EVENT, recheck);
  }, [reload]);
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
          {/* A Privy wallet starts empty: where to send SOL comes first. */}
          <PrivyWalletPanel compact />
          {data.price && (
            <AccessBuy
              walletAddress={walletAddress}
              mint={data.price.mint}
              onBought={() => setBuys((n) => n + 1)}
            />
          )}
          <BurnPanel key={buys} walletAddress={walletAddress} onCredited={reload} />
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
        You&apos;re in guest mode: the Live tab shows the top models&apos; alerts {GUEST_DELAY_MINUTES}{" "}
        minutes late, and the Models tab shows how every model is doing. Your own filters, model choices,
        alerts and settings are saved to your wallet.
      </p>
      <button className="button primary" onClick={onConnect}>
        Connect wallet
      </button>
    </section>
  );
}

/** Stands in for a screen whose code or session check is still loading; the loader waits on it. */
function Boot() {
  useEffect(() => beginWait(), []);
  return (
    <div className="boot">
      <LogoMark size={40} />
    </div>
  );
}
