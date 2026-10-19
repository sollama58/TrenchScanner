import { useEffect, useRef } from "react";
import { setAutoUnhide, unhideAll, unhideTokens, useHiddenTokens } from "../hiddenTokens";
import { ago, tokenLabel } from "../format";
import { CloseIcon, EyeIcon } from "./Icons";
import { TokenImage } from "./TokenImage";

/**
 * The tokens hidden from the Live feed's Cards and Scope views (user ask 2026-10-19), each with a
 * way back, and the switch that brings them back by themselves when they graduate or first pass
 * 2x, 4x or 10x. A native modal dialog: a centered panel on desktop, a sheet on phones.
 */
export function HiddenTokensDialog({
  open,
  onClose,
  now,
}: {
  open: boolean;
  onClose: () => void;
  now: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hidden = useHiddenTokens();
  // Newest hide first.
  const tokens = [...hidden.tokens].reverse();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal hidden-tokens-modal"
      aria-labelledby="hidden-tokens-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="hidden-tokens-title">Hidden tokens</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <button
          type="button"
          role="switch"
          aria-checked={hidden.autoUnhide}
          className={`switch${hidden.autoUnhide ? " on" : ""}`}
          onClick={() => setAutoUnhide(!hidden.autoUnhide)}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Bring them back when they run
        </button>
        <p className="muted small hidden-tokens-hint">
          {hidden.autoUnhide
            ? "A hidden token comes back to Cards and Scope by itself when it graduates, or first passes 2x, 4x or 10x from its alert, whichever it hadn't reached when you hid it."
            : "Hidden tokens stay hidden until you bring them back here."}
        </p>
        {tokens.length === 0 ? (
          <p className="muted hidden-tokens-empty">
            Nothing hidden. The eye button on a card or a Scope row hides that token from both views.
          </p>
        ) : (
          <>
            <ul className="hidden-tokens-list">
              {tokens.map((t) => {
                const label = tokenLabel({ ...t, mintAddress: t.mintAddress ?? t.tokenId });
                return (
                  <li key={t.tokenId} className="hidden-token">
                    <TokenImage
                      url={t.imageUrl?.startsWith("https://") ? t.imageUrl : null}
                      size={64}
                      width={32}
                      height={32}
                      className="hidden-token-img"
                      fallback={
                        <span className="hidden-token-img placeholder">{(t.symbol ?? "?").slice(0, 2)}</span>
                      }
                    />
                    <span className="hidden-token-text">
                      <strong>{label}</strong>
                      {t.name && t.symbol && <span className="muted small"> {t.name}</span>}
                      <span className="muted small hidden-token-when">Hidden {ago(t.hiddenAt, now)}</span>
                    </span>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => unhideTokens([t.tokenId])}
                      title={`Show ${label} in Cards and Scope again`}
                    >
                      <EyeIcon size={13} /> Unhide
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="ghost small hidden-tokens-all" onClick={unhideAll}>
              Unhide all {tokens.length}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
