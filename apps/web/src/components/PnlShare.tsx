import { useEffect, useState } from "react";
import { canvasToPng, renderPnlCard, type PnlCardData } from "../pnlCard";

/**
 * A PnL card's preview with the ways to send it: the phone's share sheet where there is one,
 * copy the image, or save it.
 */
export function PnlShare({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileName = `trenchscanner-${(data.symbol ?? "token").replace(/[^a-z0-9]/gi, "").toLowerCase() || "token"}-pnl.png`;

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    void renderPnlCard(data)
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
    // Drawn once: the parent remounts this per token (its key), and redraws nothing on a poll.
  }, []);

  const file = png ? new File([png.blob], fileName, { type: "image/png" }) : null;
  const canShare =
    !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  const canCopy = typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
  const caption = `${data.symbol ? `$${data.symbol}` : "A token"} called by TrenchScanner`;

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: caption, text: `${caption} · trenchscanner.app` });
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
    <div className="pnl-share">
      {png ? (
        <img src={png.url} alt={`PnL card for ${data.symbol ?? "this token"}`} className="pnl-preview" />
      ) : (
        <div className="pnl-preview pnl-loading">Drawing your card…</div>
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
          <a className="button ghost" href={png.url} download={fileName}>
            Save image
          </a>
        ) : null}
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
        {note && <small className="muted">{note}</small>}
      </div>
    </div>
  );
}
