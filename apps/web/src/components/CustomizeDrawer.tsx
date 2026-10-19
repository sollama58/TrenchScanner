import { useEffect, useRef, type ReactNode } from "react";
import { defaultLook, sameAppearance, setAppearance, useAppearance, useAppearanceSave } from "../appearance";
import { AppearanceControls, SaveNote } from "./AppearancePanel";
import { CloseIcon, PaletteIcon } from "./Icons";

/**
 * The Live tab's Customize panel: the Feed appearance controls beside the feed, so every change
 * shows on the real cards at once. Not modal, so the feed stays visible and scrollable behind it:
 * a drawer on the right on desktop (the page makes room for it), a short sheet along the bottom
 * on phones. Escape or the close button shuts it. With `children`, it holds those instead (the Pro
 * coin window's own Customize, user ask 2026-10-19).
 */
export function CustomizeDrawer({
  open,
  onClose,
  section,
  nested = false,
  title = "Customize your feed",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** A section's element id to open at (scrolled to and briefly lit), e.g. CHART_MARKS_SECTION. */
  section?: string;
  /**
   * Opened from inside a popup (the token view's chart link): Escape closes the drawer and leaves
   * the popup open.
   */
  nested?: boolean;
  title?: string;
  /** The controls it holds; absent, every Feed appearance control (and their Reset). */
  children?: ReactNode;
}) {
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
    const target = section ? document.getElementById(section) : null;
    if (target && drawer?.contains(target)) {
      target.scrollIntoView({ block: "start" });
      target.classList.add("lit");
      target.focus({ preventScroll: true });
    } else drawer?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (nested) {
        // Before the popup's own Escape (which would close it), and only the drawer.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Escape in a popup opened over the drawer (How this works) closes that popup only.
      if (!document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey, nested);
    return () => {
      document.body.classList.remove("drawer-open");
      window.removeEventListener("keydown", onKey, nested);
      // Only when focus went down with the drawer (Escape, the close button), not when the reader
      // has since moved on to something else on the page.
      const now = document.activeElement;
      const lost = !now || now === document.body || (drawer?.contains(now) ?? false);
      if (lost && opener?.isConnected) opener.focus();
    };
  }, [open, onClose, section, nested]);

  if (!open) return null;
  return (
    <aside className="customize-drawer" aria-labelledby="customize-title" tabIndex={-1} ref={ref}>
      <header className="drawer-head">
        <div>
          <h2 id="customize-title">
            <PaletteIcon size={16} /> {title}
          </h2>
          <SaveNote save={save} />
        </div>
        <div className="drawer-actions">
          {!children && (
            <button
              className="ghost small-btn"
              disabled={sameAppearance(look, defaultLook(look))}
              onClick={() => setAppearance(defaultLook(look))}
            >
              Reset
            </button>
          )}
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      <div className="drawer-body">
        {children ?? (
          <>
            <p className="faint small">
              Changes show on your feed right away and are saved to your wallet&apos;s account, so every
              device you sign in on looks the same.
            </p>
            <AppearanceControls />
          </>
        )}
      </div>
    </aside>
  );
}
