import { useEffect, useState } from "react";
import { type AlertPrefs, type ChaosSite, type Settings, type Subscription } from "../api";
import { DEFAULT_ALERT_PREFS, loadSettings, saveAlertPrefs, useSettings } from "../alerts";
import { Skeleton } from "../components/Charts";
import { BurnPanel } from "../components/BurnPanel";
import { BuyAsdfDialog } from "../components/BuyAsdfDialog";
import { WalletHoldings } from "../components/WalletHoldings";
import { FeedPanel } from "../components/FeedPanel";
import { ConnectPhonePanel } from "../components/ConnectPhonePanel";
import { TwoFactorPanel } from "../components/TwoFactorPanel";
import { PrivyWalletPanel } from "../components/PrivyWalletPanel";
import { TradingSettingsPanel } from "../components/TradingSettingsPanel";
import { TrackedWalletsPanel } from "../components/TrackedWallets";
import { SETTINGS_ACCOUNT_ID } from "../components/WalletMenu";
import { InstallAppPanel } from "../components/InstallApp";
import { useMe } from "../me";
import {
  BoltIcon,
  ClockIcon,
  FlameIcon,
  ShieldIcon,
  SlidersIcon,
  StreamIcon,
  WalletIcon,
} from "../components/Icons";
import { Switch } from "../components/AlertDeliveryPanels";
import {
  CHAOS_PER_MINUTE,
  CHAOS_SITE_OPTIONS,
  chaosPerMinute,
  chaosSite,
  checkPopups,
  thisBrowserIsDesktop,
  useChaosStatus,
} from "../chaosMode";
import { setAppearance, useAppearance } from "../appearance";
import { useNow, usePolling } from "../hooks";
import { useWalletBalance } from "../walletBalance";
import { ago, shortAddress } from "../format";

/**
 * Settings: your subscription and wallet balances (first, user ask 2026-10-18), your feed's Model
 * alerts switch, extra tabs, and your phones. How alerts reach you (sound, browser notifications, Telegram) lives on
 * the Filters tab, next to the filters they apply to; which models' calls you get is picked on the
 * Models tab; how the feed looks is the Live feed's Customize button.
 */
export function SettingsTab({ goTo }: { goTo: (tab: "filters" | "model" | "live") => void }) {
  const settings = useSettings();
  const me = useMe();

  return (
    <div className="stack settings">
      <p className="notice small moved-note">
        <SlidersIcon size={13} />
        <span>
          Alert sounds, browser notifications and Telegram alerts are on the{" "}
          <button type="button" className="link" onClick={() => goTo("filters")}>
            Filters tab
          </button>
          , which models you follow on the{" "}
          <button type="button" className="link" onClick={() => goTo("model")}>
            Models tab
          </button>
          , and how your feed looks under <strong>Customize</strong> on the{" "}
          <button type="button" className="link" onClick={() => goTo("live")}>
            Live feed
          </button>
          .
        </span>
      </p>
      <AccountPanel account={settings?.account ?? null} />
      {/* Phones and tablets without the app installed only. */}
      <InstallAppPanel />
      <FeedPanel goTo={goTo} />
      <ChaosPanel prefs={settings?.alerts ?? null} />
      <TabsPanel />
      <TokenViewPanel />
      <TradingSettingsPanel />
      <TrackedWalletsPanel />
      {/* Phone pairing by QR is for wallet sign-ins only (user rule 2026-10-18). */}
      {me?.signInMethod === "privy" ? <PrivyWalletPanel /> : <ConnectPhonePanel />}
      <TwoFactorPanel />
    </div>
  );
}

/**
 * Chaos Mode (user ask 2026-10-17): each new Live feed alert opens in a tab on the picked trading
 * site, up to a cap a minute. Saved with the alert settings; only desktop browsers act on it.
 */
function ChaosPanel({ prefs: saved }: { prefs: AlertPrefs | null }) {
  const prefs = saved ?? DEFAULT_ALERT_PREFS;
  const { quickLinks } = useAppearance();
  const status = useChaosStatus();
  const [desktop] = useState(thisBrowserIsDesktop);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<"allowed" | "blocked" | null>(null);
  const cap = chaosPerMinute(prefs);
  // The box edits freely; the value is saved when it is left or Enter is pressed.
  const [capInput, setCapInput] = useState(String(cap));
  useEffect(() => setCapInput(String(cap)), [cap]);
  const on = prefs.chaosMode === true;
  const site = chaosSite(prefs, quickLinks);
  const siteLabel = CHAOS_SITE_OPTIONS.find((o) => o.id === site)?.label ?? site;
  const followsQuickLinks = (prefs.chaosSite ?? null) === null;

  const save = (change: Parameters<typeof saveAlertPrefs>[0]) => {
    setError(null);
    saveAlertPrefs(change).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const commitCap = () => {
    const n = Number(capInput);
    const next = Number.isFinite(n)
      ? Math.min(CHAOS_PER_MINUTE.max, Math.max(CHAOS_PER_MINUTE.min, Math.round(n)))
      : cap;
    setCapInput(String(next));
    if (next !== cap) save({ chaosPerMinute: next });
  };
  const pick = (id: ChaosSite | null) => {
    if (id !== (prefs.chaosSite ?? null)) save({ chaosSite: id });
  };
  const blocked = check === "blocked" || (check === null && status.blockedAt !== null);

  return (
    <section className="panel chaos-panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> Chaos Mode
          </span>
          <h2>Open every new alert</h2>
          <p className="muted small">
            Each new alert in your Live feed opens in a new tab as it arrives, on the site you pick while
            TrenchScanner is open on this computer. Desktop browsers only: phones and tablets ignore it even
            when it is on.
          </p>
        </div>
        {desktop && (
          <button className="ghost" disabled={saved === null} onClick={() => setCheck(checkPopups())}>
            Check pop-ups
          </button>
        )}
      </header>
      {saved === null ? (
        <Skeleton lines={3} />
      ) : (
        <div className="tab-option">
          <Switch on={on} label="Chaos Mode" onToggle={() => save({ chaosMode: !on })} />
          {!desktop && (
            <p className="notice small">
              This is a phone or tablet, so Chaos Mode won&apos;t open anything here. It works in a desktop
              browser signed in to this wallet.
            </p>
          )}
          <h4>Open alerts on</h4>
          <div className={`sound-options${on ? "" : " off"}`} role="radiogroup" aria-label="Chaos Mode site">
            <button
              type="button"
              role="radio"
              aria-checked={followsQuickLinks}
              className={`sound-option${followsQuickLinks ? " on" : ""}`}
              onClick={() => pick(null)}
            >
              <strong>Quick link</strong>
              <small className="muted">
                Your cards&apos; first (
                {CHAOS_SITE_OPTIONS.find((o) => o.id === (quickLinks[0] ?? "terminal"))?.label})
              </small>
            </button>
            {CHAOS_SITE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={prefs.chaosSite === o.id}
                className={`sound-option${prefs.chaosSite === o.id ? " on" : ""}`}
                onClick={() => pick(o.id)}
              >
                <strong>{o.label}</strong>
              </button>
            ))}
          </div>
          <label className={`chaos-cap${on ? "" : " off"}`}>
            <span className="small muted">Most tabs a minute</span>
            <input
              type="number"
              inputMode="numeric"
              min={CHAOS_PER_MINUTE.min}
              max={CHAOS_PER_MINUTE.max}
              step={1}
              value={capInput}
              aria-label="Most Chaos Mode tabs a minute"
              onChange={(e) => setCapInput(e.target.value)}
              onBlur={commitCap}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCap();
              }}
            />
          </label>
          <p className="muted small">
            {on
              ? `On. New alerts open on ${siteLabel}, at most ${cap} a minute; alerts past that are skipped, not saved for later.`
              : `Off. When on, new alerts open on ${siteLabel}, at most ${cap} a minute.`}
            {status.opened + status.skipped > 0 &&
              ` Since this page loaded: ${status.opened} opened${status.skipped ? `, ${status.skipped} skipped at the cap` : ""}.`}
          </p>
          {desktop && blocked && (
            <p className="notice small" role="status">
              Your browser is blocking the tabs. Click the blocked pop-up icon at the right of the address bar
              and choose to always allow pop-ups from this site (Safari: Settings › Websites › Pop-up Windows
              › Allow), then press Check pop-ups again.
            </p>
          )}
          {desktop && check === "allowed" && (
            <p className="notice small" role="status">
              Pop-ups are allowed for this site, so Chaos Mode can open its tabs.
            </p>
          )}
          {desktop && on && check === null && status.blockedAt === null && (
            <p className="faint small">
              Browsers block tabs a page opens on its own until you allow pop-ups for the site. Press Check
              pop-ups to see if yours does.
            </p>
          )}
        </div>
      )}
      {error && <p className="error small">Couldn&apos;t save that: {error}</p>}
    </section>
  );
}

/** Optional tabs, off until switched on here. Saved with the feed appearance, so it follows the wallet. */
function TabsPanel() {
  const { streamTab, hideLighthouseTab } = useAppearance();
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <StreamIcon size={13} /> Tabs
          </span>
          <h2>Extra tabs</h2>
        </div>
      </header>
      <div className="tab-option">
        <button
          type="button"
          role="switch"
          aria-checked={streamTab}
          className={`switch${streamTab ? " on" : ""}`}
          onClick={() => setAppearance({ streamTab: !streamTab })}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Stream
        </button>
        <p className="muted small">
          A tab showing every new token the moment it passes the safety screen inside the band, newest first,
          on the same cards as your Live feed.
        </p>
      </div>
      <div className="tab-option">
        <button
          type="button"
          role="switch"
          aria-checked={!hideLighthouseTab}
          className={`switch${hideLighthouseTab ? "" : " on"}`}
          onClick={() => setAppearance({ hideLighthouseTab: !hideLighthouseTab })}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Lighthouse
        </button>
        <p className="muted small">
          A tab with the Market Lighthouse in full: how screened tokens are doing, and its trends over time.
        </p>
      </div>
    </section>
  );
}

/** The token view's header (user ask 2026-10-16). Saved with the feed appearance, so it follows the wallet. */
function TokenViewPanel() {
  const { hideSafetyPill } = useAppearance();
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ShieldIcon size={13} /> Token view
          </span>
          <h2>Coin header</h2>
        </div>
      </header>
      <div className="tab-option">
        <button
          type="button"
          role="switch"
          aria-checked={!hideSafetyPill}
          className={`switch${hideSafetyPill ? "" : " on"}`}
          onClick={() => setAppearance({ hideSafetyPill: !hideSafetyPill })}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Safety pill
        </button>
        <p className="muted small">
          The safety screen&apos;s Passed or Failed pill beside Sage in a coin&apos;s header. Its Safety
          section always shows.
        </p>
      </div>
    </section>
  );
}

const LEVEL_TEXT: Record<Settings["account"]["access"]["level"], string> = {
  admin: "Admin",
  whitelist: "Whitelisted",
  subscription: "Subscriber",
  free_access: "Free access",
  none: "No access",
};

function daysLeft(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
}

function date(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Subscription (redrawn 2026-10-18, user ask): how long access lasts, the signed-in wallet's SOL
 * and $ASDFASDFA, a Buy $ASDFASDFA button that opens the site's own Trade panel for it (every
 * signed-in wallet, Pro or not), and the burn that turns it into access.
 */
function AccountPanel({ account }: { account: Settings["account"] | null }) {
  const now = useNow(60_000);
  const funds = useWalletBalance();
  const sub = usePolling<Subscription>("/subscription", 300_000);
  const [buying, setBuying] = useState(false);
  const access = account?.access;
  const { balance } = funds;
  const mint = balance?.mint ?? sub.data?.price?.mint ?? null;
  const asdfRaw = balance ? BigInt(balance.totalRaw) : null;
  const price = sub.data?.price;
  const months =
    asdfRaw !== null && price
      ? Number(asdfRaw / (BigInt(price.tokensPerMonth) * 10n ** BigInt(price.decimals)))
      : null;

  const status = !access
    ? null
    : access.hasAccess
      ? access.expiresAt === null
        ? { big: "Unlimited", line: access.level === "admin" ? "Admin wallet, no end date" : "No end date" }
        : {
            big: `${daysLeft(access.expiresAt, now)} day${daysLeft(access.expiresAt, now) === 1 ? "" : "s"}`,
            line: `left, until ${date(access.expiresAt)}`,
          }
      : access.expiresAt
        ? { big: "Ended", line: `Access ended ${ago(access.expiresAt, now)}` }
        : { big: "No access", line: "Burn $ASDFASDFA below to subscribe" };

  return (
    <section className="panel sub-panel" id={SETTINGS_ACCOUNT_ID}>
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ShieldIcon size={13} /> Subscription
          </span>
          <h2>Your access</h2>
        </div>
        {access && (
          <span className={`badge ${access.hasAccess ? "good" : "bad"}`}>{LEVEL_TEXT[access.level]}</span>
        )}
      </header>
      {!account || !access || !status ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <div className="sub-top">
            <div className={`sub-status ${access.hasAccess ? "on" : "off"}`}>
              <span className="sub-kicker">
                <ClockIcon size={13} /> {access.hasAccess ? "Access" : "Status"}
              </span>
              <strong className="sub-big num">{status.big}</strong>
              <span className="sub-line">{status.line}</span>
            </div>
            <div className="sub-wallet">
              <div className="sub-wallet-head">
                <span className="sub-kicker">
                  <WalletIcon size={13} /> Wallet
                </span>
                <code className="num" title={account.walletAddress}>
                  {shortAddress(account.walletAddress)}
                </code>
                <button
                  type="button"
                  className="link small sub-refresh"
                  onClick={funds.reload}
                  aria-label="Read the balances again"
                >
                  Refresh
                </button>
              </div>
              <WalletHoldings
                funds={funds}
                asdfNote={
                  months === null
                    ? null
                    : months >= 1
                      ? `enough for ${months} month${months === 1 ? "" : "s"}`
                      : "under a month's worth"
                }
              />
              <button
                type="button"
                className="primary sub-buy"
                disabled={!mint}
                onClick={() => setBuying(true)}
              >
                <FlameIcon size={14} /> Buy $ASDFASDFA
              </button>
            </div>
          </div>
          <dl className="facts sub-facts">
            <div>
              <dt>{access.hasAccess ? "Access until" : "Access ended"}</dt>
              <dd className="num">
                {access.expiresAt === null
                  ? access.hasAccess
                    ? "No end date"
                    : "–"
                  : date(access.expiresAt)}
              </dd>
            </div>
            <div>
              <dt>Subscriber since</dt>
              <dd className="num">{access.subscription ? date(access.subscription.since) : "–"}</dd>
            </div>
            <div>
              <dt>Paid by</dt>
              <dd>
                {access.subscription
                  ? access.subscription.source === "BURN"
                    ? `Burning (${access.burns} burn${access.burns === 1 ? "" : "s"})`
                    : "Granted by an admin"
                  : access.level === "free_access"
                    ? "Free access"
                    : access.level === "whitelist"
                      ? "Whitelist"
                      : access.level === "admin"
                        ? "Admin wallet"
                        : "–"}
              </dd>
            </div>
            <div>
              <dt>Signed up</dt>
              <dd className="num">{date(account.memberSince)}</dd>
            </div>
          </dl>
        </>
      )}
      {access?.level === "free_access" && access.expiresAt && (
        <p className="small muted">
          {access.freeAccess?.deletesAccount
            ? `Free access ends ${date(access.expiresAt)}. This account was made during free access, so it is deleted soon after, with its filters, settings and linked phones and chats, unless you subscribe before.`
            : `Free access ends ${date(access.expiresAt)}. Your account and settings stay; subscribe to keep using everything.`}
        </p>
      )}
      {account &&
        (access?.level === "subscription" || access?.level === "none" || access?.level === "free_access") && (
          <div className="burn-section sub-burn">
            <h3>
              <FlameIcon size={15} />{" "}
              {access.level === "subscription"
                ? "Extend your access"
                : access.level === "free_access"
                  ? "Subscribe to keep your account"
                  : "Subscribe"}
            </h3>
            <BurnPanel
              walletAddress={account.walletAddress}
              funds={funds}
              onGetAsdf={mint ? () => setBuying(true) : undefined}
              onCredited={() => void loadSettings(true)}
            />
          </div>
        )}
      {buying && account && mint && (
        <BuyAsdfDialog
          owner={account.walletAddress}
          mint={mint}
          onClose={() => setBuying(false)}
          onBought={funds.reload}
          balance={balance}
        />
      )}
    </section>
  );
}
