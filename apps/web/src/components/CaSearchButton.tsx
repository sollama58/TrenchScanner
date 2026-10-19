import { useEffect } from "react";
import { SearchIcon } from "./Icons";

/** Whether a key press landed somewhere that types text, so "/" there is a character, not a shortcut. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The feed's search pill, by contract address, ticker or name, among the feed's other controls.
 * It opens the search window (SearchModal) rather than searching in place (user ask 2026-10-19);
 * "/" anywhere on the page opens it too.
 */
export function CaSearchButton({ onOpen, title }: { onOpen: () => void; title: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      // A dialog over the feed keeps its own keys.
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpen]);

  return (
    <button type="button" className="ca-search ca-search-button" onClick={onOpen} title={title}>
      <SearchIcon size={14} className="ca-search-icon" />
      <span className="ca-search-placeholder">Ticker, name or CA</span>
      <kbd className="ca-search-key" aria-hidden="true">
        /
      </kbd>
    </button>
  );
}
