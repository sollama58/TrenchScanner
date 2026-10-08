import { useEffect, useRef, useState } from "react";
import { canvasToPng } from "../pnlCard";
import { CloseIcon } from "./Icons";

/**
 * A branded share image (shareCard.ts) in a dialog, with the ways to send it, as the PnL card
 * does: the phone's share sheet where there is one, copy the image, or save it. The image is
 * drawn once per opening; the parent mounts this only while sharing.
 */
export function ShareImageDialog({
  title,
  fileName,
  caption,
  link,
  render,
  onClose,
}: {
  title: string;
  /** Without the extension. */
  fileName: string;
  /** The share sheet's title. */
  caption: string;
  /** Where the share text points, e.g. "trenchscanner.app". */
  link: string;
  render: () => Promise<HTMLCanvasElement>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const name = `${fileName}.png`;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    let url: string | null = null;
    let live = true;
    void render()
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
    // Drawn once per opening: a poll redraws nothing.
  }, []);

  const file = png ? new File([png.blob], name, { type: "image/png" }) : null;
  const canShare =
    !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  const canCopy = typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: caption, text: `${caption} · ${link}` });
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
    <dialog
      ref={ref}
      className="about-modal share-modal"
      aria-label={`Share: ${title}`}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h3>Share: {title}</h3>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {png ? (
          <img src={png.url} alt={`Share image: ${title}`} className="pnl-preview" />
        ) : (
          <div className="pnl-preview pnl-loading">Drawing the image…</div>
        )}
        <div className="pnl-actions">
          {canShare && (
            <button type="button" onClick={() => void share()}>
              Share
            </button>
          )}
          {canCopy && (
            <button
              type="button"
              className={canShare ? "ghost" : ""}
              disabled={!png}
              onClick={() => void copy()}
            >
              Copy image
            </button>
          )}
          {png ? (
            <a className={`button${canShare || canCopy ? " ghost" : ""}`} href={png.url} download={name}>
              Save image
            </a>
          ) : null}
          {note && <small className="muted">{note}</small>}
        </div>
      </div>
    </dialog>
  );
}
