import { type Settings } from "../api";
import { loadSettings, useSettings } from "../alerts";
import { Skeleton } from "../components/Charts";
import { BurnPanel } from "../components/BurnPanel";
import { AppearancePanel } from "../components/AppearancePanel";
import { ConnectPhonePanel } from "../components/ConnectPhonePanel";
import { ShieldIcon, SlidersIcon, StreamIcon } from "../components/Icons";
import { setAppearance, useAppearance } from "../appearance";
import { useNow } from "../hooks";
import { ago, shortAddress } from "../format";

/**
 * Settings: how your feed looks, your phones, and your account and access. How alerts reach you
 * (sound, browser notifications, Telegram) and which model's calls you get live on the Filters
 * tab now, next to the filters they apply to.
 */
export function SettingsTab({ goTo }: { goTo: (tab: "filters") => void }) {
  const settings = useSettings();

  return (
    <div className="stack settings">
      <p className="notice small moved-note">
        <SlidersIcon size={13} /> Alert sounds, browser notifications, Telegram alerts and your preferred
        model moved to the{" "}
        <button type="button" className="link" onClick={() => goTo("filters")}>
          Filters tab
        </button>
        .
      </p>
      <TabsPanel />
      <AppearancePanel />
      <ConnectPhonePanel />
      <AccountPanel account={settings?.account ?? null} />
    </div>
  );
}

/** Optional tabs, off until switched on here. Saved with the feed appearance, so it follows the wallet. */
function TabsPanel() {
  const { streamTab, lighthouseTab } = useAppearance();
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
          aria-checked={lighthouseTab}
          className={`switch${lighthouseTab ? " on" : ""}`}
          onClick={() => setAppearance({ lighthouseTab: !lighthouseTab })}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Lighthouse
        </button>
        <p className="muted small">
          A tab with the Market Lighthouse in full: how screened tokens are doing, and its trends over time.
          The Lighthouse button on the Live feed opens it either way.
        </p>
      </div>
    </section>
  );
}

const LEVEL_TEXT: Record<Settings["account"]["access"]["level"], string> = {
  admin: "Admin",
  whitelist: "Whitelisted",
  subscription: "Subscriber",
  none: "No access",
};

function daysLeft(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
}

function date(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function AccountPanel({ account }: { account: Settings["account"] | null }) {
  const now = useNow(60_000);
  const access = account?.access;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ShieldIcon size={13} /> Account
          </span>
          <h2>Your access</h2>
        </div>
      </header>
      {!account || !access ? (
        <Skeleton lines={3} />
      ) : (
        <dl className="facts">
          <div>
            <dt>Access level</dt>
            <dd>
              <span className={`badge ${access.hasAccess ? "good" : "bad"}`}>{LEVEL_TEXT[access.level]}</span>
            </dd>
          </div>
          <div>
            <dt>{access.hasAccess ? "Access until" : "Access ended"}</dt>
            <dd className="num">
              {access.expiresAt === null ? (access.hasAccess ? "No end date" : "–") : date(access.expiresAt)}
            </dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd className="num">
              {access.expiresAt === null
                ? access.hasAccess
                  ? "Unlimited"
                  : "–"
                : access.hasAccess
                  ? `${daysLeft(access.expiresAt, now)} days`
                  : `ended ${ago(access.expiresAt, now)}`}
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
                : access.level === "whitelist"
                  ? "Whitelist"
                  : access.level === "admin"
                    ? "Admin wallet"
                    : "–"}
            </dd>
          </div>
          <div>
            <dt>Wallet</dt>
            <dd className="num" title={account.walletAddress}>
              {shortAddress(account.walletAddress)}
            </dd>
          </div>
          <div>
            <dt>Signed up</dt>
            <dd className="num">{date(account.memberSince)}</dd>
          </div>
        </dl>
      )}
      {account && (access?.level === "subscription" || access?.level === "none") && (
        <div className="burn-section">
          <h3>{access.level === "subscription" ? "Extend your access" : "Subscribe"}</h3>
          <BurnPanel walletAddress={account.walletAddress} onCredited={() => void loadSettings(true)} />
        </div>
      )}
    </section>
  );
}
