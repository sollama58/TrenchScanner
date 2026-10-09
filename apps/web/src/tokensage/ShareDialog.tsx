import { useEffect, useState } from "react";
import { canvasToPng } from "../pnlCard";
import { CloseIcon } from "../components/Icons";
import { renderShareCard, SHARE_CARDS, type ShareCardKind } from "./shareCards";
import type { LighthouseSignals } from "../api";
import type { TokenSageShowcase } from "./showcase";

/**
 * A section's share image (shareCards.ts) with the ways to send it, as the PnL card does: the
 * phone's share sheet where there is one, copy the image, or save it.
 */
export function ShareDialog({
  kind,
  data,
  pay,
  onClose,
}: {
  kind: ShareCardKind;
  data: TokenSageShowcase;
  /** How calls did by narrative over the picked window, which the "Which narratives pay" image draws from. */
  pay: LighthouseSignals | null;
  onClose: () => void;
}) {
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { title, file: name } = SHARE_CARDS[kind];
  const fileName = `${name}.png`;

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    void renderShareCard(kind, data, pay)
      .then(canvasToPng)
      .then((blob) => {
        if (!live || !blob) return;
        url = URL.createObjectURL(blob);
        setPng({ blob, url });
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // Drawn once per opening: the page remounts this per card, and a poll redraws nothing.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const file = png ? new File([png.blob], fileName, { type: "image/png" }) : null;
  const canShare =
    !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  const canCopy = typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
  const caption = `${title}, by TokenSage on TrenchScanner`;

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({
        files: [file],
        title: caption,
        text: `${caption} · trenchscanner.app/tokensage`,
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNote("Couldn't open the share sheet. Try saving the image.");
    }
  };
  const copy = async () => {
    if (!png) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png.blob })]);
      setNote("Image copied");
    } catch {
      setNote("Couldn't copy here. Try saving the image.");
    }
  };

  return (
    <div
      className="tsg-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Share: ${title}`}
      onClick={onClose}
    >
      <div className="tsg-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="tsg-modal-head">
          <h3>Share: {title}</h3>
          <button type="button" className="tsg-icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        {png ? (
          <img src={png.url} alt={`Share image: ${title}`} className="pnl-preview" />
        ) : (
          <div className="pnl-preview pnl-loading">Drawing the image…</div>
        )}
        <div className="pnl-actions">
          {canShare && (
            <button type="button" className="primary" onClick={() => void share()}>
              Share
            </button>
          )}
          {canCopy && (
            <button type="button" disabled={!png} onClick={() => void copy()}>
              Copy image
            </button>
          )}
          {png ? (
            <a className="button" href={png.url} download={fileName}>
              Save image
            </a>
          ) : null}
          {note && <small className="muted">{note}</small>}
        </div>
      </div>
    </div>
  );
}
