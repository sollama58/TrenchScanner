import { useEffect, useRef, useState } from "react";
import { canvasToPng } from "../pnlCard";
import { CloseIcon, ShareIcon } from "./Icons";

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
  wide = false,
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
  /** Preview near full size (a detailed image, such as the bubble map's). */
  wide?: boolean;
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
        if (!live) return;
        if (!blob) throw new Error("no image");
        url = URL.createObjectURL(blob);
        setPng({ blob, url });
      })
      .catch(() => {
        if (live) setNote("Couldn't draw the image here.");
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
      className={`about-modal share-modal${wide ? " wide" : ""}`}
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
          <div className="pnl-preview pnl-loading">{note ?? "Drawing the image…"}</div>
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
          {png && note && <small className="muted">{note}</small>}
        </div>
      </div>
    </dialog>
  );
}

/**
 * A section's Share button and the dialog it opens. `render` is only called once the dialog
 * opens, so a section drawing nothing until someone shares costs nothing.
 */
export function ShareButton({
  title,
  fileName,
  caption,
  link = "trenchscanner.app",
  render,
  disabled = false,
  iconOnly = false,
  wide = false,
}: {
  title: string;
  fileName: string;
  caption: string;
  link?: string;
  render: () => Promise<HTMLCanvasElement>;
  disabled?: boolean;
  /** A bare icon, for a toolbar of icon buttons. */
  iconOnly?: boolean;
  /** Preview the image near full size (ShareImageDialog). */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={iconOnly ? "ghost icon-btn" : "ghost share-btn"}
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Share this as an image"
        aria-label={iconOnly ? `Share ${title} as an image` : undefined}
      >
        <ShareIcon size={14} />
        {iconOnly ? null : " Share"}
      </button>
      {open && (
        <ShareImageDialog
          title={title}
          fileName={fileName}
          caption={caption}
          link={link}
          render={render}
          onClose={() => setOpen(false)}
          wide={wide}
        />
      )}
    </>
  );
}
