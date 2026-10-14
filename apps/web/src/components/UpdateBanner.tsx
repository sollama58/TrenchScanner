import { useEffect, useState } from "react";
import { applyUpdate, availableUpdate, onUpdateAvailable } from "../version";
import { CloseIcon } from "./Icons";

/**
 * "A new version is available" with a reload button, once src/version.ts finds a newer deploy.
 * Closing it hides that version only: a later deploy offers itself again.
 */
export function UpdateBanner() {
  const [version, setVersion] = useState(availableUpdate);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => onUpdateAvailable(() => setVersion(availableUpdate())), []);
  if (!version || version === dismissed) return null;
  return (
    <aside className="update-banner" role="status" aria-label="Update available">
      <p className="update-banner-text">A new version of TrenchScanner is available.</p>
      <button type="button" className="primary update-banner-reload" onClick={applyUpdate}>
        Reload
      </button>
      <button
        type="button"
        className="icon-btn update-banner-close"
        onClick={() => setDismissed(version)}
        aria-label="Not now"
      >
        <CloseIcon size={16} />
      </button>
    </aside>
  );
}
