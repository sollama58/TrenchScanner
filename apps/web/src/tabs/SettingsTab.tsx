import { useEffect, useRef, useState } from "react";
import { type AlertPrefs, type Leaderboard, type Settings } from "../api";
import { ALERT_SOUND_OPTIONS, type AlertSound } from "../alertSounds";
import {
  DEFAULT_ALERT_PREFS,
  notificationState,
  previewAlert,
  requestNotifications,
  sendTestAlert,
  saveAlertPrefs,
  loadSettings,
  useSettings,
  type NotificationState,
} from "../alerts";
import { saveFeedSettings } from "../components/ModelPicker";
import { Skeleton } from "../components/Charts";
import { BurnPanel } from "../components/BurnPanel";
import { ArrowRightIcon, BellIcon, BrainIcon, ShieldIcon, VolumeIcon } from "../components/Icons";
import { usePolling, useNow } from "../hooks";
import { ago, shortAddress } from "../format";

/**
 * Settings: how alerts reach you (a sound with its volume, browser notifications, and which
 * alerts do it), whether your feed follows the best-performing model, and your access.
 */
export function SettingsTab({ goTo }: { goTo: (tab: "live" | "model") => void }) {
  const settings = useSettings();
  const [pick, setPick] = useState(0);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));

  return (
    <div className="stack settings">
      <AlertsPanel prefs={settings?.alerts ?? null} />
      <ModelPanel
        board={board.data}
        stale={board.stale}
        onChanged={() => setPick((n) => n + 1)}
        goTo={goTo}
      />
      <AccountPanel account={settings?.account ?? null} />
    </div>
  );
}

function Switch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch${on ? " on" : ""}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {label}
    </button>
  );
}

function AlertsPanel({ prefs: saved }: { prefs: AlertPrefs | null }) {
  const prefs = saved ?? DEFAULT_ALERT_PREFS;
  const [error, setError] = useState<string | null>(null);
  // The slider moves freely; the value is saved when it is let go.
  const [volume, setVolume] = useState(prefs.volume);
  const [permission, setPermission] = useState<NotificationState>(notificationState);
  useEffect(() => setVolume(prefs.volume), [prefs.volume]);
  // What the last test did, shown under the button.
  const [testResult, setTestResult] = useState<string | null>(null);
  useEffect(() => {
    // The permission can change in the browser's own site settings while this tab is open.
    const onFocus = () => setPermission(notificationState());
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  const test = async () => {
    setTestResult(null);
    let state = notificationState();
    // A test is the obvious moment to ask, if the browser hasn't been asked yet.
    if (state === "default") {
      state = await requestNotifications();
      setPermission(state);
      if (state === "granted" && !prefs.browserNotifications) save({ browserNotifications: true });
    }
    const result = await sendTestAlert({ ...prefs, volume });
    const sound = prefs.soundEnabled ? "Played your sound. " : "";
    if (result === null) {
      setTestResult(
        state === "denied"
          ? `${sound}No notification: this site is blocked in your browser's notification settings.`
          : state === "unsupported"
            ? `${sound}No notification: this browser can't show them from a web page.`
            : `${sound}No notification: permission wasn't given.`,
      );
    } else if (!result.ok) {
      setTestResult(`${sound}The browser refused the notification: ${result.reason}`);
    } else {
      setTestResult(
        `${sound}Test notification sent. If nothing popped up, your computer is hiding it: check that ` +
          "notifications are allowed for your browser in the system settings (macOS: System Settings › " +
          "Notifications; Windows: Settings › System › Notifications) and that Focus / Do Not Disturb is off.",
      );
    }
  };

  const save = (change: Parameters<typeof saveAlertPrefs>[0]) => {
    setError(null);
    saveAlertPrefs(change).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const chooseSound = (sound: AlertSound) => {
    previewAlert({ ...prefs, sound, volume });
    if (sound !== prefs.sound) save({ sound });
  };

  // The slider's native "change" fires once when it is let go (wherever the pointer is by then)
  // and after keyboard steps; React's onChange fires on every move instead.
  const volumeRef = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(v: number) => void>(() => undefined);
  commitRef.current = (v: number) => {
    previewAlert({ ...prefs, volume: v });
    if (v !== prefs.volume) save({ volume: v });
  };
  const hasSaved = saved !== null;
  useEffect(() => {
    const el = volumeRef.current;
    if (!el) return;
    const onCommit = () => commitRef.current(Number(el.value));
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [hasSaved]);

  const toggleNotifications = async () => {
    // The switch shows notifications as on only where this browser may show them, so a pref
    // saved on another device (or before the permission was reset) asks here rather than
    // turning the pref off for every device.
    if (prefs.browserNotifications && permission === "granted") {
      save({ browserNotifications: false });
      return;
    }
    const state = permission === "granted" ? permission : await requestNotifications();
    setPermission(state);
    if (state === "granted") save({ browserNotifications: true });
  };

  const notifyLive = prefs.browserNotifications && permission === "granted";

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BellIcon size={13} /> Alerts
          </span>
          <h2>How new alerts reach you</h2>
          <p className="muted small">
            Works on every tab while this page is open, including in the background. Saved to your account, so
            it follows you to other devices.
          </p>
        </div>
        <button className="ghost" disabled={saved === null} onClick={() => void test()}>
          Send a test alert
        </button>
      </header>

      {saved === null ? (
        <Skeleton lines={5} />
      ) : (
        <div className="settings-grid">
          <fieldset>
            <legend>
              <VolumeIcon size={13} /> Sound
            </legend>
            <Switch
              on={prefs.soundEnabled}
              label="Play a sound for new alerts"
              onToggle={() => save({ soundEnabled: !prefs.soundEnabled })}
            />
            <div
              className={`sound-options${prefs.soundEnabled ? "" : " off"}`}
              role="radiogroup"
              aria-label="Sound"
            >
              {ALERT_SOUND_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={prefs.sound === o.id}
                  className={`sound-option${prefs.sound === o.id ? " on" : ""}`}
                  onClick={() => chooseSound(o.id)}
                  title={`${o.hint} (click to hear it)`}
                >
                  <strong>{o.label}</strong>
                  <small className="muted">{o.hint}</small>
                </button>
              ))}
            </div>
            <label className={`volume${prefs.soundEnabled ? "" : " off"}`}>
              <span className="small muted">Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={volume}
                aria-label="Alert volume"
                onChange={(e) => setVolume(Number(e.target.value))}
                ref={volumeRef}
              />
              <span className="num small volume-value">{volume}%</span>
            </label>
          </fieldset>

          <fieldset>
            <legend>
              <BellIcon size={13} /> Browser notifications
            </legend>
            <Switch
              on={notifyLive}
              label="Show a notification for new alerts"
              disabled={permission === "unsupported" || permission === "denied"}
              onToggle={() => void toggleNotifications()}
            />
            <p className="muted small">
              {permission === "unsupported"
                ? "This browser can't show notifications from a page."
                : permission === "denied"
                  ? "Notifications are blocked for this site. Allow them in your browser's site settings, then come back."
                  : notifyLive
                    ? "On. Each new alert pops up with the token and who called it; click it to come back here."
                    : permission === "granted"
                      ? "Off. Allowed by your browser; turn this on to get one for each new alert."
                      : "Your browser will ask for permission when you turn this on."}
            </p>

            <h4>Alert me for</h4>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.notifyOn.filterMatches}
                onChange={() => save({ notifyOn: { filterMatches: !prefs.notifyOn.filterMatches } })}
              />
              Tokens my filter catches
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.notifyOn.modelCalls}
                onChange={() => save({ notifyOn: { modelCalls: !prefs.notifyOn.modelCalls } })}
              />
              Calls from the models in my feed
            </label>
          </fieldset>
        </div>
      )}
      {testResult && (
        <p className="notice small" role="status">
          {testResult}
        </p>
      )}
      {error && <p className="error small">Couldn&apos;t save that: {error}</p>}
    </section>
  );
}

function ModelPanel({
  board,
  stale,
  onChanged,
  goTo,
}: {
  board: Leaderboard | null;
  stale: boolean;
  onChanged: () => void;
  goTo: (tab: "live" | "model") => void;
}) {
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const following = board?.followBest ?? board?.followsDefault ?? true;
  const best = board?.entries.find((e) => e.id === board.defaultModel) ?? null;
  const mine = board ? board.entries.filter((e) => board.selectedModels.includes(e.id)) : [];

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveFeedSettings({ followBest: !following });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BrainIcon size={13} /> Model
          </span>
          <h2>Which model's calls you get</h2>
        </div>
      </header>
      {!board ? (
        <Skeleton lines={3} />
      ) : (
        <div className={stale ? "stale" : ""}>
          <Switch
            on={following}
            label="Always follow the best-performing model"
            disabled={busy || stale}
            onToggle={() => void toggle()}
          />
          <p className="muted">
            {following ? (
              <>
                Your feed shows <strong>{best?.name ?? "–"}</strong>, the best performer right now, and
                switches by itself whenever a new best is chosen (after each training run, every{" "}
                {board.evolution.runEveryHours}h). Ticking a model yourself on the Live or Models tab switches
                you to your own picks.
              </>
            ) : (
              <>
                Your feed keeps your own picks: <strong>{mine.map((e) => e.name).join(", ") || "–"}</strong>.
                It won&apos;t change when a new best performer is chosen. Change your picks on the Live or
                Models tab.
              </>
            )}
          </p>
          <div className="champion">
            <div>
              <span className="small muted">Best performer</span>
              <div className="row gap-s">
                <strong>{best?.name ?? "–"}</strong>
                {best && best.composite.score !== null && (
                  <span className="chip chip-model num">score {best.composite.score.toFixed(0)}</span>
                )}
                {best && <span className="chip num">#{best.rank} on the 30-day board</span>}
              </div>
              <small className="faint">
                {board.champion
                  ? `Chosen ${ago(board.champion.chosenAt, now)}. ${board.champion.reason}`
                  : "Not chosen from live results yet: until a model has enough graded live calls, the default is the Consensus when it can call, else Rules."}
              </small>
            </div>
            <button className="ghost" onClick={() => goTo("model")}>
              Leaderboard <ArrowRightIcon size={13} />
            </button>
          </div>
          {board.champion && (
            <p className="faint small">
              A model needs {board.champion.minLiveGraded} graded live calls to become the best performer, and
              has to beat the current one by {board.champion.margin} points to take over.
            </p>
          )}
        </div>
      )}
      {error && <p className="error small">Couldn&apos;t switch: {error}</p>}
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
