import { type Settings } from "../api";
import { loadSettings, useSettings } from "../alerts";
import { Skeleton } from "../components/Charts";
import { BurnPanel } from "../components/BurnPanel";
import { AppearancePanel } from "../components/AppearancePanel";
import { ConnectPhonePanel } from "../components/ConnectPhonePanel";
import { ShieldIcon, SlidersIcon } from "../components/Icons";
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
      <AppearancePanel />
      <ConnectPhonePanel />
      <AccountPanel account={settings?.account ?? null} />
    </div>
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
