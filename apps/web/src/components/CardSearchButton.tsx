import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cardSearchQuery,
  googleSearchHref,
  openCardSearch,
  useCardSearchReady,
  xSearchHref,
} from "../cardSearch";
import { SearchIcon } from "./Icons";

/**
 * A small search control on a token card (Cards and Scope). The menu searches the ticker or name
 * in the feed's own search, and the same text plus the contract on X and Google.
 */
export function CardSearchButton({
  symbol,
  name,
  mint,
  className,
}: {
  symbol: string | null;
  name: string | null;
  mint: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const ready = useCardSearchReady();
  const query = cardSearchQuery(symbol, name);
  const shown = symbol?.trim() ? `$${symbol.trim().replace(/^\$+/, "")}` : name?.trim() || "this token";

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const node = e.target as Node | null;
      if (btn.current?.contains(node)) return;
      if (node instanceof Element && node.closest?.(".card-search-menu")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = 240;
    setBox({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
    });
  };

  return (
    <div className={className} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button
        ref={btn}
        type="button"
        className={`card-search-btn${open ? " open" : ""}`}
        aria-label={`Search ${shown}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Search ${shown}`}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setOpen(true);
        }}
      >
        <SearchIcon size={13} />
      </button>
      {open &&
        box &&
        createPortal(
          <div id={menuId} className="card-search-menu" role="menu" style={{ top: box.top, left: box.left }}>
            {query && ready && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  openCardSearch(query);
                }}
              >
                Search {query} here
              </button>
            )}
            {query && (
              <a role="menuitem" href={xSearchHref(query)} target="_blank" rel="noreferrer noopener">
                Search {query} on X
              </a>
            )}
            <a role="menuitem" href={xSearchHref(mint)} target="_blank" rel="noreferrer noopener">
              Search CA on X
            </a>
            {query && (
              <a role="menuitem" href={googleSearchHref(query)} target="_blank" rel="noreferrer noopener">
                Search {query} on Google
              </a>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
