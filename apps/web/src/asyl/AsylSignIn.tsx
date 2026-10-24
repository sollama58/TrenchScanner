import { useEffect, useState } from "react";
import { signInUrl } from "../returnTo";

/**
 * Asyl has no sign-in of its own (user ask 2026-10-24): it uses TrenchScanner's, on
 * trenchscanner.app, which sends the visitor back here once signed in (returnTo.ts). Both sites
 * share the one session cookie on api.trenchscanner.app.
 *
 * Sends the visitor there at once, unless this tab already went there in the last minute and came
 * back still signed out (a browser that drops the cookie): then it says so instead of bouncing
 * between the two pages.
 */

const SENT_KEY = "asyl:sent-to-sign-in";
const BOUNCE_MS = 60_000;

function recentlySent(): boolean {
  try {
    const at = Number(sessionStorage.getItem(SENT_KEY));
    return Number.isFinite(at) && Date.now() - at < BOUNCE_MS;
  } catch {
    return false;
  }
}

export function goSignIn(): void {
  try {
    sessionStorage.setItem(SENT_KEY, String(Date.now()));
  } catch {
    // Storage blocked: no bounce guard, the redirect still works.
  }
  window.location.assign(signInUrl(window.location.href));
}

export function AsylSignIn() {
  const [stuck] = useState(recentlySent);

  useEffect(() => {
    if (!stuck) goSignIn();
  }, [stuck]);

  if (!stuck) return <div className="asyl-loading">ASYL</div>;
  return (
    <div className="asyl-gate">
      <div className="asyl-gate-card">
        <h1 className="asyl-wordmark">ASYL</h1>
        <p className="asyl-gate-lede">Asyl uses your TrenchScanner sign-in.</p>
        <p>
          You came back from TrenchScanner still signed out here. If you signed in there, this browser may be
          blocking the sign-in for this site: allow cookies for trenchscanner.app, or turn off strict tracking
          prevention for it, then try again.
        </p>
        <div className="asyl-gate-wallets">
          <button className="asyl-btn asyl-wallet-btn" onClick={goSignIn}>
            Sign in on TrenchScanner
          </button>
        </div>
      </div>
    </div>
  );
}
