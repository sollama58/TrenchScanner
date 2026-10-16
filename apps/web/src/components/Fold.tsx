import type { ReactNode } from "react";
import { ChevronDownIcon } from "./Icons";

/**
 * A token-modal card's heading that folds the card (user ask 2026-10-16): the whole heading is the
 * button, so its count and summary stay readable while the body is folded away.
 */
export function FoldHead({
  open,
  onToggle,
  controls,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** The id of the body it shows and hides. */
  controls: string;
  children: ReactNode;
}) {
  return (
    <h4 className="tm-fold-h">
      <button
        type="button"
        className="tm-fold-btn"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        {children}
        <ChevronDownIcon size={15} className="tm-fold-chev" />
      </button>
    </h4>
  );
}
