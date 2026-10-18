import { useState } from "react";
import { useInstallApp, type InstallPlatform } from "../installApp";
import { DownloadIcon, PhoneIcon, ShareIcon } from "./Icons";

/** Where the wallet menu's install item lands in Settings when there's no install dialog to open. */
export const SETTINGS_INSTALL_ID = "settings-install";

/** How to add the site by hand, where the browser has no install dialog to open (all of iOS). */
function InstallSteps({ platform }: { platform: InstallPlatform }) {
  return platform === "ios" ? (
    <>
      <ol className="install-steps small">
        <li>
          Tap <strong>Share</strong> <ShareIcon size={13} /> in Safari&apos;s toolbar (in Chrome it&apos;s in
          the address bar).
        </li>
        <li>
          Scroll down and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Tap <strong>Add</strong>, then open TrenchScanner from your home screen.
        </li>
      </ol>
      <p className="faint small">The app keeps its own sign-in, so you sign in once more there.</p>
    </>
  ) : (
    <ol className="install-steps small">
      <li>
        Open your browser&apos;s menu (<strong>⋮</strong> or <strong>≡</strong>).
      </li>
      <li>
        Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
      </li>
      <li>Confirm, then open TrenchScanner from your home screen.</li>
    </ol>
  );
}

/**
 * The install button: opens the browser's install dialog where it has one, else shows the steps.
 * Renders nothing on a desktop or inside the installed app.
 */
export function InstallAppButton({ className = "button primary" }: { className?: string }) {
  const app = useInstallApp();
  const [steps, setSteps] = useState(false);
  if (!app.show) return null;
  const onClick = async () => {
    if (app.canPrompt && (await app.install())) return;
    setSteps((s) => !s);
  };
  return (
    <div className="install-app">
      <button
        type="button"
        className={`${className} install-btn`}
        aria-expanded={steps}
        onClick={() => void onClick()}
      >
        <DownloadIcon size={16} />
        <span>Install the app</span>
      </button>
      {steps && <InstallSteps platform={app.platform} />}
    </div>
  );
}

/** Settings card for the same button; phones and tablets only. */
export function InstallAppPanel() {
  const app = useInstallApp();
  if (!app.show) return null;
  return (
    <section className="panel install-panel" id={SETTINGS_INSTALL_ID}>
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <PhoneIcon size={13} /> App
          </span>
          <h2>Install TrenchScanner</h2>
        </div>
      </header>
      <p className="muted small">
        Add TrenchScanner to your home screen: it opens full screen, like any other app, with no browser bars.
      </p>
      {app.platform === "ios" && !app.canPrompt ? <InstallSteps platform="ios" /> : <InstallAppButton />}
    </section>
  );
}
