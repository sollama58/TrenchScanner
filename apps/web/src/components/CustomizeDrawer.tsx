import { useEffect, useRef } from "react";
import { defaultLook, sameAppearance, setAppearance, useAppearance, useAppearanceSave } from "../appearance";
import { AppearanceControls, SaveNote } from "./AppearancePanel";
import { CloseIcon, PaletteIcon } from "./Icons";

/**
 * The Live tab's Customize panel: the Feed appearance controls beside the feed, so every change
 * shows on the real cards at once. Not modal, so the feed stays visible and scrollable behind it:
 * a drawer on the right on desktop (the page makes room for it), a short sheet along the bottom
 * on phones. Escape or the close button shuts it.
 */
export function CustomizeDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const look = useAppearance();
  const save = useAppearanceSave();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    // The page shifts left on wide screens so the drawer doesn't cover the cards.
    document.body.classList.add("drawer-open");
    // Whatever opened the drawer (the Customize button) gets focus back when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = ref.current;
    drawer?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Escape in a popup opened over the drawer (Stats, How this works) closes that popup only.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("drawer-open");
      window.removeEventListener("keydown", onKey);
      // Only when focus went down with the drawer (Escape, the close button), not when the reader
      // has since moved on to something else on the page.
      const now = document.activeElement;
      const lost = !now || now === document.body || (drawer?.contains(now) ?? false);
      if (lost && opener?.isConnected) opener.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <aside className="customize-drawer" aria-labelledby="customize-title" tabIndex={-1} ref={ref}>
      <header className="drawer-head">
        <div>
          <h2 id="customize-title">
            <PaletteIcon size={16} /> Customize your feed
          </h2>
          <SaveNote save={save} />
        </div>
        <div className="drawer-actions">
          <button
            className="ghost small-btn"
            disabled={sameAppearance(look, defaultLook(look))}
            onClick={() => setAppearance(defaultLook(look))}
          >
            Reset
          </button>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      <div className="drawer-body">
        <p className="faint small">
          Changes show on your feed right away and are saved to your wallet&apos;s account, so every device
          you sign in on looks the same.
        </p>
        <AppearanceControls />
      </div>
    </aside>
  );
}
